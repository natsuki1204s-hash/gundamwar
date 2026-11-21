'use strict';
// =====================================================================
//  対戦卓（index.html の後に読む。CARDS・BY_ID・Images・decks・esc・toast・$ を使う）
//
//  しくみ
//  - 部屋を作った人のブラウザが「管理役」。場のカード（公開情報）を持ち、全員に配る
//  - 本国（山札）と手札は各自のブラウザだけが持つ。管理役にも中身は送らない（枚数だけ）
//  - 盤面の変化は全部「操作」（act）として管理役の apply() を通る。
//    将来の自動化は、操作をまとめて出すボタンを足せばよい
//  - 通信は PeerJS（ブラウザ同士の直接接続）。URL に ?local を付けると同じブラウザの
//    タブ同士で試せる（BroadcastChannel）
// =====================================================================
(() => {
if (!CARDS.length) return;

const PFX = 'gundamwar-taku-';
const LOCAL = new URLSearchParams(location.search).has('local');
const ZONES = { G: 'G', deploy: '配備エリア', space: '戦闘エリア（宇宙）', earth: '戦闘エリア（地球）', ring: 'リング', junk: 'ジャンクヤード', discard: '捨て山', removed: '除外', cmd: 'コマンド', hangar: 'ハンガー' };
// 盤の名前に添える英字（見た目の飾り。2026-11-16）
const ZEN = { deploy: 'DEPLOY', space: 'SPACE', earth: 'EARTH', ring: 'RING', cmd: 'COMMAND', hangar: 'HANGAR' };
const PILES = ['junk', 'discard', 'removed'];
const SECRET = ['discard'];   // 中身が誰にも見えない置き場（捨て山は非公開。枚数だけ見える）
const PHASES = ['リロールフェイズ', 'ドローフェイズ', '配備フェイズ', '攻撃ステップ', '防御ステップ', 'ダメージ判定ステップ', '帰還ステップ', 'ターンエンド'];
const HAND0 = 6;              // 最初の手札
const MOVE_TO = ['deploy', 'space', 'earth', 'ring', 'G', 'hangar', 'junk', 'discard', 'removed'];
// 前の版で作った盤面（リング・コマンド・ハンガーがない）を開き直した時のために、足りない置き場を足す
const fillZones = S => S && S.seats.forEach(s => { for (const k in ZONES) if (!s.z[k]) s.z[k] = []; });
// ヴァリアブル：手札・ハンガーから、自軍配備フェイズに配備エリアへリロール状態・逆向きで出し、そのカードの色の特殊Gとして扱う（Gのプレイ扱い）。c.vb
const variN = x => { const m = x && (x.x || []).join(' ').match(/ヴァリアブル\s*[（(](\d+|X)[)）]/); return m ? m[1] : null; };
const emptyZones = () => Object.fromEntries(Object.keys(ZONES).map(k => [k, []]));
const emptySeat = () => ({ name: '', online: false, ready: false, deckName: '', dn: 0, hn: 0, z: emptyZones() });
const rid = () => Math.random().toString(36).slice(2, 7);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cname = c => { if (c && c.coin) return c.coin; const x = c && c.id && BY_ID.get(c.id); return x ? x.n : '裏向きのカード'; };
// コイン：カードの上に乗せる物は c.cn = {名前: 枚数}。場に単独で置く物は置き場の中の {u, o, coin: 名前, n: 枚数}
const COINS = ['コイン', '+1/+1/+1コイン', '-1/-1/-1コイン', '+2/+2/+2コイン', '解体コイン', '汚染コイン'];
const COIN_ST = /^([+\-±]\d+)\/([+\-±]\d+)\/([+\-±]\d+)コイン$/;   // 戦闘力を変えるコイン（+1/+1/+1 など）
const coinShort = n => { const m = COIN_ST.exec(n); return m ? m[1] : n.replace(/コイン$/, '').slice(0, 3) || '●'; };
const SWAP_Z = ['deploy', 'space', 'earth'];   // 換装で入れ替えられる場所（リングのユニットは換装元にできない：Wiki「換装」）
const BATTLE = ['space', 'earth', 'ring'];   // リングは第3の戦場（使う時だけ）
// 一時修正（コマンドや能力で一時的に変わった分）：c.tm = { d:[格闘,射撃,耐久], s:※を付けるか, m:メモ, k:ターン終了で消さない }
const fmtMod = d => d.map(v => (v >= 0 ? '+' : '') + v).join('/');
const tmLabel = tm => (tm.d.some(v => v) ? fmtMod(tm.d) : '') + (tm.s || tm.m ? '※' : '');
const tmTitle = tm => `一時修正${tm.d.some(v => v) ? ' ' + fmtMod(tm.d) : ''}${tm.m ? ' ※' + tm.m : tm.s ? ' ※' : ''}${tm.k ? '（ターン終了で消さない）' : '（ターン終了で消える）'}`;
const UNIT_T = ['U', 'A'];   // 部隊戦闘力に数える種類（ユニット・ACE）
// トークン（「ボルジャーノンコイン{UNIT、…、2/0/2}」のように効果で出るユニット・キャラ）。
// 中身（def）は盤面の S.tk[id] に持ち、BY_ID にも足して普通のカードと同じに描く。場のカードは {u, id, tk:1, …}。
// id は 'TK|呼び名|格/射/耐'。画像もこの id ごと（カード詳細と同じしくみ）。場を離れると消える
const TK_COLORS = ['無', '白', '青', '緑', '黒', '赤', '茶', '紫'];
const tkId = d => `TK|${d.n}|${d.st.join('/')}`;
function cleanTok(d) {
  if (!d) return null;
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const list = (v, n) => (Array.isArray(v) ? v : String(v || '').split(/[\s、,]+/)).map(x => str(x, 20)).filter(Boolean).slice(0, n);
  const n = str(d.n, 30); if (!n) return null;
  const st = [0, 1, 2].map(i => str((d.st || [])[i], 4) || '0');
  const t = d.t === 'CH' ? 'CH' : 'U', c = TK_COLORS.includes(d.c) ? d.c : '無';
  const nm = str(d.nm, 30);
  const x = String(Array.isArray(d.x) ? d.x.join('\n') : d.x || '').split('\n').map(l => str(l, 200)).filter(Boolean).slice(0, 6);
  const def = { n, t, c, k: [null, null, null], r: '', tok: true, nm, tr: list(d.tr, 8), tg: list(d.tg, 3).filter(g => ['宇宙', '地球'].includes(g)), st, x: (nm ? [`名称：${nm}`] : []).concat(x.filter(l => !/^名称：/.test(l))), no: ['トークン'], s: ['トークン'], m: 'トークン' };
  if (!def.tr.length) delete def.tr;
  def.id = tkId(def);
  return def;
}
const regTokens = S => S && S.tk && Object.values(S.tk).forEach(d => BY_ID.set(d.id, d));
// カードの文面から「〇〇コイン{UNIT、…、2/0/2}」を読む（ボタン一発で出せるように）
function tokTemplates(x, src) {
  const out = [], t = (x && x.x || []).join(' ');
  for (const m of t.matchAll(/([^\s、。「」”"{}｛｝:：（）()]{0,16})[{｛](UNIT|CHARACTER\(UNIT\)|CHARACTER)、([^}｝]*)[}｝]/g)) {
    const body = m[3], d = { t: m[2] === 'UNIT' ? 'U' : 'CH', tr: [], tg: [], x: [] };
    const st = body.match(/([0-9XYZ*＊]+)\/([0-9XYZ*＊]+)\/([0-9XYZ*＊]+)\s*$/);
    d.st = st ? st.slice(1, 4) : ['0', '0', '0'];
    const g = body.match(/地形適性((?:「[^」]*」)+)/); if (g) d.tg = [...g[1].matchAll(/「([^」]*)」/g)].map(y => y[1]);
    let rest = body.replace(/地形適性(?:「[^」]*」)+/, '').replace(/[0-9XYZ*＊]+\/[0-9XYZ*＊]+\/[0-9XYZ*＊]+\s*$/, '');
    const nm = rest.match(/(?:カード)?名称[「:：]+([^」]*)」?/); if (nm) { d.nm = nm[1]; rest = rest.replace(nm[0], ''); }
    const tr = rest.match(/「特徴[:：]([^」]*)」/); if (tr) { d.tr = tr[1].split(/[、,]/); rest = rest.replace(tr[0], ''); }
    const q = [...rest.matchAll(/「([^」]*)」/g)].map(y => y[1]);
    if (d.t === 'CH' && !tr) d.tr = q; else if (q.length) d.x = [q.map(y => `「${y}」`).join('')];
    const pre = (m[1] || '').replace(/^(以後|敵軍配備エリアに|このカードの部隊に|部隊に)/, '');
    d.n = /コイン$/.test(pre) ? pre : d.nm ? d.nm + 'コイン' : (src || 'トークン') + 'のコイン';
    out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------
//  通信
// ---------------------------------------------------------------------
const PEER_OPT = { debug: 1 };
function mkLocalConn(ch, me, other, meta) {
  const h = {};
  return {
    metadata: meta, open: true,
    on(ev, fn) { (h[ev] = h[ev] || []).push(fn); },
    _emit(ev, x) { (h[ev] || []).forEach(f => f(x)); },
    send(d) {   // PeerJS と同じく、16300バイトを超える1通は送らずに落とす（試験モードでも本番と同じ不具合が出るように）
      const j = JSON.stringify(d);
      if (new TextEncoder().encode(j).length >= 16300) { console.error('Message too big for JSON channel'); return; }
      ch.postMessage({ to: other, from: me, k: 'data', d: JSON.parse(j) });
    },
    close() { ch.postMessage({ to: other, from: me, k: 'bye' }); this._emit('close'); }
  };
}
// PeerJS（JSON の通信）は1通が16300バイトを超えると黙って捨てる。盤面は記録が溜まるとすぐ超えるので、
// 文字列にしてから小分けにして送り、受け側で組み立て直す（順番どおり届く通信なので番号順に並べるだけ）
const PART = 3000; // 文字数。日本語は1文字3バイト、送る時の " のエスケープ込みでも 16300 に収まる
function wrapConn(c) {
  const h = [], parts = new Map();
  const emit = d => h.forEach(f => { try { f(d); } catch (e) { console.error(e); } });
  c.on('data', d => {
    if (!d || d.k !== 'part') { emit(d); return; }
    let p = parts.get(d.id); if (!p) parts.set(d.id, p = []);
    p[d.i] = d.d;
    if (p.filter(x => x != null).length < d.n) return;
    parts.delete(d.id);
    try { emit(JSON.parse(p.join(''))); } catch (e) { console.error('組み立てに失敗', e); }
  });
  c.on('error', e => console.error('通信のエラー', e));
  return {
    get metadata() { return c.metadata; },
    on(ev, fn) { if (ev === 'data') h.push(fn); else c.on(ev, fn); },
    send(d) {
      const j = JSON.stringify(d);
      if (j.length <= PART) { c.send(d); return; }
      const id = rid(), n = Math.ceil(j.length / PART);
      for (let i = 0; i < n; i++) c.send({ k: 'part', id, i, n, d: j.slice(i * PART, (i + 1) * PART) });
    },
    close() { c.close(); }
  };
}
const Net = {
  host(code, onConn) {
    if (LOCAL) {
      const ch = new BroadcastChannel('gwlocal-' + code), conns = new Map();
      ch.onmessage = e => {
        const m = e.data; if (m.to !== 'host') return;
        if (m.k === 'hello') {
          const c = mkLocalConn(ch, 'host', m.from, m.meta); conns.set(m.from, c);
          ch.postMessage({ to: m.from, from: 'host', k: 'ok' });
          onConn(wrapConn(c)); setTimeout(() => c._emit('open'), 0);
        } else if (m.k === 'data') conns.get(m.from)?._emit('data', m.d);
        else if (m.k === 'bye') { conns.get(m.from)?._emit('close'); conns.delete(m.from); }
      };
      addEventListener('beforeunload', () => conns.forEach((c, id) => ch.postMessage({ to: id, from: 'host', k: 'bye' })));
      return Promise.resolve({ destroy() { conns.forEach(c => c.close()); ch.close(); } });
    }
    if (!window.Peer) return Promise.reject(new Error('通信の部品（PeerJS）が読み込めませんでした'));
    return new Promise((res, rej) => {
      const p = new Peer(PFX + code, PEER_OPT);
      let opened = false;
      p.on('open', () => { opened = true; res({ destroy: () => p.destroy() }); });
      p.on('connection', c => onConn(wrapConn(c)));
      p.on('disconnected', () => { if (opened && !p.destroyed) setTimeout(() => p.reconnect(), 2000); });
      p.on('error', e => { if (!opened) { p.destroy(); rej(e); } else console.warn(e); });
    });
  },
  join(code, meta) {
    if (LOCAL) return new Promise((res, rej) => {
      const ch = new BroadcastChannel('gwlocal-' + code), me = 'c' + rid();
      const c = mkLocalConn(ch, me, 'host', meta);
      const t = setTimeout(() => { ch.close(); rej({ type: 'peer-unavailable' }); }, 2000);
      ch.onmessage = e => {
        const m = e.data; if (m.to !== me) return;
        if (m.k === 'ok') { clearTimeout(t); res(wrapConn(c)); }
        else if (m.k === 'data') c._emit('data', m.d);
        else if (m.k === 'bye') c._emit('close');
      };
      addEventListener('beforeunload', () => ch.postMessage({ to: 'host', from: me, k: 'bye' }));
      ch.postMessage({ to: 'host', from: me, k: 'hello', meta });
    });
    if (!window.Peer) return Promise.reject(new Error('通信の部品（PeerJS）が読み込めませんでした'));
    return new Promise((res, rej) => {
      const p = new Peer(PEER_OPT);
      let done = false;
      const t = setTimeout(() => { p.destroy(); rej(new Error('つながりませんでした（時間切れ）')); }, 20000);
      p.on('open', () => {
        const c = p.connect(PFX + code, { metadata: meta, reliable: true, serialization: 'json' });
        c.on('open', () => { clearTimeout(t); done = true; res(wrapConn(c)); });
      });
      // つながった後のエラー（接続サーバーとの切断など）で Peer を壊すと、卓との通信まで切れる
      p.on('error', e => { if (done) { console.warn(e); return; } clearTimeout(t); p.destroy(); rej(e); });
      p.on('disconnected', () => { if (done && !p.destroyed) setTimeout(() => p.reconnect(), 2000); });
    });
  }
};
const netErr = e => e && e.type === 'peer-unavailable' ? '部屋が見つかりません（コードを確かめてください）'
  : e && e.type === 'unavailable-id' ? 'そのコードの部屋はもう使われています'
  : e && e.type === 'network' || e && e.type === 'server-error' ? '接続サーバーにつながりませんでした'
  : (e && e.message) || String(e);

// ---------------------------------------------------------------------
//  状態
// ---------------------------------------------------------------------
const B = {
  role: null,       // 'host' | 'player' | 'spect'
  code: '', seat: null, name: store.get('name', ''),
  S: null,          // 公開の盤面（管理役が正本）
  priv: null,       // 自分の本国と手札 { game, deck:[{u,id}], hand:[{u,id}] }  ※0番目が本国の一番上
  conns: [],        // 管理役：[{conn, seat, name, role}]
  hostConn: null, lost: false, prev: null,
  rec: []           // 管理役：操作の記録（将来の再生・台本式対戦用。裏向きの中身を含むので配らない）
};
const mySeat = () => B.seat ?? 0;
const isPlayer = () => B.role === 'host' || B.role === 'player';
const privKey = () => `gw.priv.${B.code}.${B.seat}`;
function savePriv() { try { localStorage.setItem(privKey(), JSON.stringify(B.priv)); } catch (e) {} }
function loadPriv() { try { return JSON.parse(localStorage.getItem(privKey())); } catch (e) { return null; } }

// ---------------------------------------------------------------------
//  管理役：操作を盤面に当てる
// ---------------------------------------------------------------------
function findCard(S, u) {
  for (let s = 0; s < S.seats.length; s++) for (const z in S.seats[s].z) {
    const arr = S.seats[s].z[z];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].u === u) return { arr, i, c: arr[i], seat: s, zone: z, parent: null };
      const subs = arr[i].s || [];
      for (let j = 0; j < subs.length; j++) if (subs[j].u === u) return { arr: subs, i: j, c: subs[j], seat: s, zone: z, parent: arr[i] };
    }
  }
  return null;
}
// セットは親（場に置いてあるカード）の s に平らに並べる。セット中のカードの上にさらにセットした物は on に乗せ先の u（何段でも）
function setDesc(g, u) {   // g.s の中で u に（何段か上に）乗っているカードの u
  const set = new Set([u]); let grow = true;
  while (grow) { grow = false; for (const x of g.s || []) if (x.on && set.has(x.on) && !set.has(x.u)) { set.add(x.u); grow = true; } }
  set.delete(u); return set;
}
function takeOut(f) {      // findCard の結果を場から抜く → [カード, そのカードに乗っていた物...]（乗っていた物は on をカードに合わせる）
  const card = f.c; let subs;
  if (f.parent) { const d = setDesc(f.parent, card.u); subs = f.parent.s.filter(x => d.has(x.u)); f.parent.s = f.parent.s.filter(x => x !== card && !d.has(x.u)); }
  else { f.arr.splice(f.i, 1); subs = card.s || []; }
  card.s = []; delete card.on;
  subs.forEach(x => { if (!x.on) x.on = card.u; });
  return [card, ...subs];
}
function putOnto(t, cards) {   // cards をカード t（findCard の結果）にセット。t がセット中のカードなら、その上に乗せる（何段でも）
  const g = t.parent || t.c; if (!g.s) g.s = [];
  const inside = new Set(cards.map(c => c.u));
  cards.forEach(c => {
    c.s = [];
    if (c.on && inside.has(c.on)) return;   // 一緒に動くカードの上に乗っている物はそのまま
    if (t.parent) c.on = t.c.u; else delete c.on;
  });
  let at = g.s.length;
  if (t.parent) { const d = setDesc(g, t.c.u); at = g.s.indexOf(t.c) + 1; g.s.forEach((x, i) => { if (d.has(x.u)) at = Math.max(at, i + 1); }); }
  g.s.splice(at, 0, ...cards);
  return g;
}
function flatSets(S) {      // 前の不具合（セット中のカードにセットすると、その下に入って見えなくなった）で埋もれた物を平らに戻す
  S.seats.forEach(st => Object.values(st.z).forEach(arr => arr.forEach(g => {
    if (!(g.s || []).some(x => (x.s || []).length)) return;
    const out = [];
    const walk = (x, on) => { const k = x.s || []; x.s = []; if (on && on !== g.u) x.on = on; out.push(x); k.forEach(y => walk(y, x.u)); };
    g.s.forEach(x => walk(x, x.on));
    g.s = out;
  })));
}
function endTurnNow(S) {
  clearTm(S);
  S.endAsk = null; S.sent = null;
  const nx = (S.active + 1) % S.seats.length;
  S.active = nx; S.turn = (S.turn || 0) + 1; S.phase = 0;
  eachCard(S.seats[nx], c => c.r = false);
  log(`── 第${S.turn}ターン ${S.seats[nx].name || `席${nx + 1}`}のターン（${PHASES[0]}：全リロール）──`, 'turn');
}
function log(msg, cls = '') { const S = B.S; S.log.push({ m: msg, c: cls }); if (S.log.length > 300) S.log.splice(0, S.log.length - 300); }
const zoneLabel = (seat, z) => (B.S.seats[seat].name || `席${seat + 1}`) + 'の' + ZONES[z];

function apply(a, who) {
  if (a.t !== 'counts') { B.rec.push({ t: Date.now(), seat: who.seat, name: who.name, a: JSON.parse(JSON.stringify(a)) }); if (B.rec.length > 5000) B.rec.shift(); }
  const S = B.S, nm = who.name || '？';
  flatSets(S);
  const seatObj = who.seat != null ? S.seats[who.seat] : null;
  if (a.t === 'chat') { log(`${nm}：${String(a.msg).slice(0, 200)}`, 'chat'); return; }
  if (!seatObj) return '観戦者は操作できません';
  if (a.dn != null) { seatObj.dn = a.dn; seatObj.hn = a.hn; }
  switch (a.t) {
    case 'counts': return;
    case 'note': log(`${nm}が${a.msg}`); return;
    case 'ready': seatObj.ready = true; seatObj.deckName = a.deckName || ''; seatObj.sl = typeof a.sl === 'string' && /^SLV\|[\w-]{1,60}$/.test(a.sl) ? a.sl : null; seatObj.dt = Math.max(0, a.dt | 0) || null; log(`${nm}が「${seatObj.deckName}」で準備しました`, 'sys'); return;
    case 'enter': {   // 手札・本国から場へ
      const tz = S.seats[a.seat ?? who.seat]?.z[a.zone]; if (!tz) return;
      const cards = a.cards.map(c => ({ u: c.u, id: c.id, o: who.seat, r: false, f: !!a.f && !PILES.includes(a.zone), s: [], ...(a.vb && a.zone === 'deploy' ? { vb: true } : {}) }));
      if (a.vb && a.zone === 'deploy') { log(`${nm}が${a.src === 'hand' ? '手札' : '本国'}の『${cname(cards[0])}』をヴァリアブルで配備エリアへ（逆向き・${(BY_ID.get(cards[0].id) || {}).c || ''}の特殊G、Gのプレイとして）`); tz.push(...cards); return; }
      let onto = null;
      if (a.onto) { const t = findCard(S, a.onto); if (t && !t.c.coin) { onto = t.c; putOnto(t, cards); } else tz.push(...cards); }
      else tz.push(...cards);
      const from = a.src === 'deck' ? '本国の上から' : '手札から';
      const names = cards.length > 3 || SECRET.includes(a.zone) ? `${cards.length}枚` : cards.map(c => `『${c.f ? '裏向きのカード' : cname(c)}』`).join('');
      log(`${nm}が${from}${names}を${onto ? `『${cname(onto)}』にセット` : zoneLabel(a.seat ?? who.seat, a.zone) + 'へ'}`);
      return;
    }
    case 'cast': {    // 手札のカード（コマンド）をプレイ：資源の分だけ本国の上から捨て山へ、カードは「プレイ中」（席の cmd）へ。盤の真ん中に出る
      const c0 = a.cards && a.cards[0]; if (!c0) return;
      const pay = (a.pay || []).map(c => ({ u: c.u, id: c.id, o: who.seat, r: false, f: false, s: [] }));
      seatObj.z.discard.push(...pay);
      S.castN = (S.castN || 0) + 1;
      const card = { u: c0.u, id: c0.id, o: who.seat, r: false, f: false, s: [], at: S.castN, pay: pay.length };
      seatObj.z.cmd.push(card);
      log(`${nm}が手札から『${cname(card)}』をプレイ${pay.length ? `（資源${pay.length}：本国の上から${pay.length}枚を捨て山へ）` : ''}${a.short ? '　※国力が足りていないかもしれません' : ''}`);
      return;
    }
    case 'resolve': { // プレイ中のカードの効果を解決し終えた（how:'cut'＝打ち消された、'manual'＝自動にしない）→ 持ち主のジャンクヤードへ
      const f = findCard(S, a.u); if (!f || f.zone !== 'cmd' || f.parent) return;
      // 自動解決のカード（AUTO_FX）：効果を動かす席（ふつうは持ち主。密約は引く人）がいるか先に見る
      const fx = !a.how && AUTO_FX[f.c.id], fxSeat = fx && fx.k === 'draw2' && S.seats[a.ds] ? a.ds | 0 : f.c.o;
      if (fx && !canReach(fxSeat)) return `${S.seats[fxSeat].name || '持ち主'}がいないので自動では解決できません（「手で解決」を使ってください）`;
      f.arr.splice(f.i, 1);
      const c = f.c, cs = [c, ...(c.s || [])]; cs.forEach(x => { x.r = false; x.f = false; x.s = []; delete x.on; delete x.cn; delete x.tm; delete x.at; delete x.pay; });
      cs.forEach(x => S.seats[x.o].z.junk.push(x));
      log(`${nm}が『${cname(c)}』を${a.how === 'cut' ? '打ち消されたものとして' : fx ? '解決し（自動）、' : '解決し、'}ジャンクヤードへ`);
      if (fx) autoHost(fx, c, fxSeat);
      return;
    }
    // ── 自動解決：ブリーフィングの「表にしたカード」を相手が選ぶ（S.pick）
    case 'fxShow': {
      const cards = (a.cards || []).filter(x => x && BY_ID.has(x.id)).slice(0, 10).map(x => ({ u: String(x.u), id: x.id }));
      const src = String(a.src || '').slice(0, 30);
      if (!cards.length) { log(`${nm}の『${src}』：本国がないので何も起きませんでした`); return; }
      const others = S.seats.map((x, i) => i).filter(i => i !== who.seat && S.seats[i].name && canReach(i));
      const ch = others.length ? others[0] : who.seat;
      S.pick = { k: rid(), seat: who.seat, ch, cards, n: Math.max(1, Math.min(a.n | 0, cards.length)), src };
      log(`${nm}が『${src}』で本国の上${cards.length}枚を表にしました：${cards.map(x => `『${BY_ID.get(x.id).n}』`).join('')}。${S.seats[ch].name || '相手'}が手札に移す${S.pick.n}枚を選びます`);
      return;
    }
    case 'fxPick': {
      const P = S.pick; if (!P) return;
      if (!canReach(P.seat)) return `${S.seats[P.seat].name || '持ち主'}がいないので動かせません`;
      if (a.cancel) {
        if (who.seat !== P.seat && who.seat !== P.ch) return;
        sendFx(P.seat, { t: 'briefDone', us: [] }); S.pick = null;
        log(`${nm}が『${P.src}』の選択を取りやめました（表にしたカードは本国の上へ）`); return;
      }
      if (who.seat !== P.ch) return `選ぶのは${S.seats[P.ch].name || '相手'}です`;
      const us = [...new Set(a.us || [])].filter(u => P.cards.some(c => c.u === u));
      if (us.length !== P.n) return `${P.n}枚選んでください`;
      sendFx(P.seat, { t: 'briefDone', us }); S.pick = null;
      const rest = P.cards.length - us.length;
      log(`${nm}が${us.map(u => `『${BY_ID.get(P.cards.find(c => c.u === u).id).n}』`).join('')}を選びました（${S.seats[P.seat].name || '持ち主'}の手札へ${rest ? `。残り${rest}枚は本国の上へ` : ''}）`);
      return;
    }
    case 'move': {    // 場から場へ
      const f = findCard(S, a.u); if (!f) return;
      const tz = S.seats[a.seat]?.z[a.zone]; if (!tz && !a.onto) return;
      if (a.onto) { if (a.onto === a.u || (f.c.s || []).some(x => x.u === a.onto) || (f.parent && setDesc(f.parent, a.u).has(a.onto))) return; }
      if (f.c.coin) {   // 場のコイン：カードに乗せる／捨て札置き場へ動かすと消える／ほかの置き場へ
        const tc = a.onto && findCard(S, a.onto);
        if (a.onto && (!tc || (tc.c.coin && tc.c.coin !== f.c.coin))) return;
        if (!a.onto && !tz) return;
        f.arr.splice(f.i, 1);
        if (tc && tc.c.coin) { tc.c.n += f.c.n; log(`${nm}が『${f.c.coin}』${f.c.n}枚をまとめました（${tc.c.n}枚）`); }
        else if (tc) { const cn = tc.c.cn || (tc.c.cn = {}); cn[f.c.coin] = (cn[f.c.coin] || 0) + f.c.n; log(`${nm}が『${f.c.coin}』${f.c.n}枚を『${cname(tc.c)}』の上に乗せました`); }
        else if (PILES.includes(a.zone)) log(`${nm}が『${f.c.coin}』${f.c.n}枚を取り除きました`);
        else { tz.push(f.c); log(`${nm}が『${f.c.coin}』を${zoneLabel(a.seat, a.zone)}へ`); }
        return;
      }
      if (a.onto) { const tc = findCard(S, a.onto); if (tc && tc.c.coin) return; }   // コインの下にはセットしない
      const t0 = a.onto && findCard(S, a.onto); if (a.onto && !t0) return;
      const moved = takeOut(f), card = moved[0], subs = moved.slice(1);
      if (a.onto) {
        const t = findCard(S, a.onto); if (!t) { tz.push(card); return; }
        card.v = false; card.vb = false; putOnto(t, moved);
        log(`${nm}が『${cname(card)}』${subs.length ? `（乗っていた${subs.length}枚ごと）` : ''}を『${cname(t.c)}』${t.parent ? `（『${cname(t.parent)}』のセット）` : ''}にセット`);
        return;
      }
      subs.forEach(x => { if (x.on === card.u) delete x.on; });
      if (PILES.includes(a.zone)) {   // 捨て札置き場へは表向き・リロール状態で、セットしていたカードも一緒に
        [card, ...subs].forEach(c => { c.r = false; c.f = false; c.v = false; c.vb = false; c.s = []; delete c.on; delete c.cn; delete c.tm; if (!c.tk) tz.push(c); });   // トークンは場を離れると消える
        log(`${nm}が『${cname(card)}』${subs.length ? `（セット${subs.length}枚ごと）` : ''}を${card.tk ? '取り除きました（トークンは場を離れると消えます）' : zoneLabel(a.seat, a.zone) + 'へ'}`);
      } else {
        card.s = subs; if (card.vb && !['deploy', 'G'].includes(a.zone)) card.vb = false; tz.push(card);
        log(`${nm}が『${cname(card)}』を${zoneLabel(a.seat, a.zone)}へ`);
      }
      return;
    }
    case 'swap': {    // 換装：手札のユニットと、場の自軍ユニット1枚を置き換える（場所・ロール状態・セット・コイン・一時修正を引き継ぐ。変形・ヴァリアブル・裏向きは引き継がない）
      const c0 = a.cards && a.cards[0], f = findCard(S, a.u); if (!c0 || !BY_ID.has(c0.id)) return;
      if (!f || f.parent || f.c.coin || f.seat !== who.seat || !SWAP_Z.includes(f.zone)) { gainBack(who.seat, c0); return '換装する場のユニットが見つかりません（手札に戻しました）'; }
      const old = f.c;
      if (!old.tk && !canReach(old.o)) { gainBack(who.seat, c0); return `${S.seats[old.o].name || '持ち主'}がいないので換装できません`; }
      const nc = { u: c0.u, id: c0.id, o: who.seat, r: a.rr ? false : !!old.r, f: false, s: old.s || [], ...(old.cn ? { cn: old.cn } : {}), ...(old.tm ? { tm: old.tm } : {}) };
      nc.s.forEach(x => { if (x.on === old.u) delete x.on; });
      f.arr[f.i] = nc;
      if (!old.tk) sendGain(old.o, { u: old.u, id: old.id }, 'hand');
      const kept = [nc.s.length ? `セット${nc.s.length}枚` : '', old.cn ? 'コイン' : '', old.tm ? '一時修正' : ''].filter(Boolean);
      log(`${nm}が換装：手札の『${cname(nc)}』と${zoneLabel(f.seat, f.zone)}の『${old.f && !old.tk ? '裏向きのカード' : cname(old)}』を置き換えました（${old.tk ? 'トークンは消えます' : `『${cname(old)}』は持ち主の手札へ`}。${old.r ? (a.rr ? 'ロール状態を引き継がずリロール' : 'ロール状態のまま') : 'リロール状態'}${kept.length ? '・' + kept.join('・') + 'を引き継ぎ' : ''}）`);
      return;
    }
    case 'leave': {   // 場から持ち主の手札・本国へ
      const f = findCard(S, a.u); if (!f) return;
      if (f.c.coin) { f.arr.splice(f.i, 1); log(`${nm}が『${f.c.coin}』${f.c.n}枚を取り除きました`); return; }
      const grp = f.parent ? [f.c, ...f.parent.s.filter(x => setDesc(f.parent, f.c.u).has(x.u))] : [f.c, ...(f.c.s || [])];
      const all = grp.filter(c => !c.tk);   // トークンは手札・本国へ行かず消える
      const owners = new Set(all.map(c => c.o));
      for (const o of owners) if (!canReach(o)) return `${S.seats[o].name || '持ち主'}がいないので動かせません`;
      takeOut(f);
      all.forEach(c => sendGain(c.o, { u: c.u, id: c.id }, a.to));
      const where = { hand: '手札', top: '本国の上', bottom: '本国の下' }[a.to];
      if (f.c.tk) { log(`${nm}がトークン『${cname(f.c)}』を取り除きました${all.length ? `（セットしていた${all.length}枚は持ち主の${where}へ）` : ''}`); return; }
      log(`${nm}が『${SECRET.includes(f.zone) ? ZONES[f.zone] + 'のカード' : cname(f.c)}』${all.length > 1 ? `（セット${all.length - 1}枚ごと）` : ''}を持ち主の${where}へ`);
      return;
    }
    case 'token': {   // トークン（効果で出るユニット・キャラ）を出す
      const d = cleanTok(a.def); if (!d) return;
      const seat = a.seat ?? who.seat, tz = S.seats[seat]?.z[a.zone]; if (!tz || PILES.includes(a.zone)) return;
      (S.tk || (S.tk = {}))[d.id] = d; BY_ID.set(d.id, d);
      const n = Math.max(1, Math.min(10, a.n | 0 || 1));
      const cards = Array.from({ length: n }, () => ({ u: rid() + rid(), id: d.id, o: who.seat, r: !!a.r, f: false, s: [], tk: 1 }));
      const t = a.onto && findCard(S, a.onto);
      if (t && !t.c.coin) putOnto(t, cards);
      else if (a.at > 0) tz.splice(Math.min(tz.length, a.at - 1), 0, ...cards);
      else tz.push(...cards);
      log(`${nm}が${t && !t.c.coin ? `『${cname(t.c)}』に` : zoneLabel(seat, a.zone) + 'に'}トークン『${d.n}』（${d.st.join('/')}）を${n}個出しました${a.at > 0 && !t ? `（${a.at}番目）` : ''}${a.r ? '（ロール状態）' : ''}`);
      return;
    }
    case 'coin': {    // カード（または場のコイン）の上のコインを増やす・減らす
      const f = findCard(S, a.u); if (!f) return;
      const name = String(a.name || 'コイン').slice(0, 20), d = Math.max(-99, Math.min(99, a.d | 0)); if (!d) return;
      if (f.c.coin) {
        f.c.n = (f.c.n || 1) + d;
        if (f.c.n <= 0) { f.arr.splice(f.i, 1); log(`${nm}が${zoneLabel(f.seat, f.zone)}の『${f.c.coin}』を取り除きました`); }
        else log(`${nm}が${zoneLabel(f.seat, f.zone)}の『${f.c.coin}』を${d > 0 ? d + '枚足しました' : -d + '枚減らしました'}（${f.c.n}枚）`);
        return;
      }
      const cn = f.c.cn || (f.c.cn = {}), was = cn[name] || 0;
      if (d < 0 && !was) return;
      cn[name] = Math.max(0, was + d); if (!cn[name]) delete cn[name];
      log(`${nm}が『${cname(f.c)}』の上に${d > 0 ? `『${name}』を${d}枚乗せました` : `ある『${name}』を${Math.min(was, -d)}枚取りました`}（${cn[name] || 0}枚）`);
      return;
    }
    case 'coinPut': { // 場にコインを単独で置く
      const tz = S.seats[a.seat ?? who.seat]?.z[a.zone]; if (!tz || PILES.includes(a.zone)) return;
      const name = String(a.name || 'コイン').slice(0, 20), n = Math.max(1, Math.min(99, a.n | 0 || 1));
      tz.push({ u: rid() + rid(), o: who.seat, coin: name, n, r: false, f: false, s: [] });
      log(`${nm}が${zoneLabel(a.seat ?? who.seat, a.zone)}に『${name}』を${n}枚置きました`);
      return;
    }
    case 'coinOff': { // カードの上のコインを外して、同じ置き場に単独で置く
      const f = findCard(S, a.u); if (!f || f.c.coin) return;
      const cn = f.c.cn || {}, n = cn[a.name]; if (!n) return;
      delete cn[a.name];
      S.seats[f.seat].z[f.zone].push({ u: rid() + rid(), o: who.seat, coin: a.name, n, r: false, f: false, s: [] });
      log(`${nm}が『${cname(f.c)}』の上の『${a.name}』${n}枚を外して${zoneLabel(f.seat, f.zone)}に置きました`);
      return;
    }
    case 'tmod': {    // 一時修正を付ける・消す
      const f = findCard(S, a.u); if (!f || f.c.coin) return;
      const d = [0, 1, 2].map(i => Math.max(-99, Math.min(99, (a.d || [])[i] | 0)));
      const m = String(a.m || '').trim().slice(0, 60), sx = !!a.s || !!m;
      if (!d.some(v => v) && !sx) { if (f.c.tm) { delete f.c.tm; log(`${nm}が『${cname(f.c)}』の一時修正を消しました`); } return; }
      f.c.tm = { d, s: sx, m, k: !!a.k };
      log(`${nm}が『${cname(f.c)}』に${tmTitle(f.c.tm)}`);
      return;
    }
    case 'zorder': {  // 置き場の中で左右に動かす（戦闘エリアは左が先頭）
      const f = findCard(S, a.u); if (!f || f.parent) return;
      const j = f.i + (a.d < 0 ? -1 : 1); if (j < 0 || j >= f.arr.length) return;
      [f.arr[f.i], f.arr[j]] = [f.arr[j], f.arr[f.i]];
      log(`${nm}が『${cname(f.c)}』を${ZONES[f.zone]}の${a.d < 0 ? '前（先頭の方）' : '後ろ'}へ（${j + 1}番目）`);
      return;
    }
    case 'roll': { const f = findCard(S, a.u); if (!f || f.c.coin) return; f.c.r = !f.c.r; log(`${nm}が『${cname(f.c)}』を${f.c.r ? 'ロール' : 'リロール'}`); return; }
    case 'transform': { const f = findCard(S, a.u); if (!f) return; const x = BY_ID.get(f.c.id); if (!x || !x.alt) return; f.c.v = !f.c.v; log(`${nm}が『${cname(f.c)}』を${f.c.v ? `変形（${x.alt.name || '変形形態'}）` : '元の形態に戻す'}`); return; }
    case 'vari': {   // ヴァリアブル：配備エリアへ逆向き・リロール状態で出して特殊G扱いに（もう一度で普通に戻す）
      const f = findCard(S, a.u); if (!f || f.c.coin || f.parent || f.c.f) return;
      const x = BY_ID.get(f.c.id); if (!x) return;
      if (f.c.vb) { f.c.vb = false; log(`${nm}が『${x.n}』のヴァリアブルをやめました（普通の向きに）`); return; }
      f.arr.splice(f.i, 1);
      Object.assign(f.c, { vb: true, r: false, v: false });
      S.seats[f.c.o].z.deploy.push(f.c);
      log(`${nm}が${ZONES[f.zone]}の『${x.n}』をヴァリアブルで配備エリアへ（逆向き・${x.c}の特殊G、Gのプレイとして）`);
      return;
    }
    case 'flip': { const f = findCard(S, a.u); if (!f) return; f.c.f = !f.c.f; log(`${nm}が『${cname(f.c)}』を${f.c.f ? '裏' : '表'}向きに`); return; }
    case 'turn': {
      clearTm(S);
      eachCard(seatObj, c => c.r = false);
      S.turn = (S.turn || 0) + 1; S.active = who.seat;
      log(`── 第${S.turn}ターン ${nm}のターン（全リロール${a.drew ? '・1枚ドロー' : ''}）──`, 'turn');
      return;
    }
    // ── ゲームの始め：最初の手札・引き直し・手札を決める
    case 'start': seatObj.su = 'mull'; seatObj.mull = 0; log(`${nm}が最初の手札を${a.n}枚引きました`, 'sys'); return;
    case 'mull': seatObj.mull = (seatObj.mull || 0) + 1; log(`${nm}が手札を引き直しました（${seatObj.mull}回目・${a.n}枚）`, 'sys'); return;
    case 'keep': seatObj.su = 'done'; log(`${nm}がこの手札で始めます（${a.n}枚）`, 'sys'); return;
    case 'reveal': {  // 手札などを全員に見せる（見せたい物の中身を本人が送ってくる）
      const ids = (a.ids || []).filter(id => BY_ID.has(id)).slice(0, 60);
      S.reveal = { k: rid(), seat: who.seat, name: nm, what: String(a.what || '手札').slice(0, 20), ids };
      log(`${nm}が${S.reveal.what}を公開：${ids.map(id => `『${BY_ID.get(id).n}』`).join('') || '（なし）'}`);
      return;
    }
    // ── 手札の公開（公開したまま）。見せているカードの中身は本人が送ってくる。seat.sh = { c:[{u,id}], pt:指定されたu }
    case 'show': {
      const old = seatObj.sh || { c: [] }, had = new Set(old.c.map(x => x.u));
      const cards = (a.cards || []).filter(x => x && BY_ID.has(x.id)).slice(0, 60).map(x => ({ u: String(x.u), id: x.id }));
      if (!cards.length) {
        seatObj.sh = null;
        if (old.c.length) log(`${nm}が手札の公開を終えました`);
        return;
      }
      const added = cards.filter(x => !had.has(x.u));
      seatObj.sh = { c: cards, pt: cards.some(x => x.u === old.pt) ? old.pt : null };
      if (added.length) log(`${nm}が手札${a.all ? 'を全部' : 'の' + added.length + '枚を'}公開しています：${added.map(x => `『${BY_ID.get(x.id).n}』`).join('')}（公開中${cards.length}枚／手札${seatObj.hn}枚）`);
      return;
    }
    case 'point': {   // 公開されている相手の手札の1枚を指定する（ハンデスなど）
      const tg = S.seats[a.seat], sh = tg && tg.sh; if (!sh) return;
      const x = sh.c.find(x => x.u === a.u);
      if (!x || sh.pt === a.u) { sh.pt = null; log(`${nm}が手札の指定を外しました`); return; }
      sh.pt = a.u;
      log(`${nm}が${tg.name || '相手'}の手札の『${BY_ID.get(x.id).n}』を指定しました`);
      return;
    }
    // ── ターンとフェイズ
    case 'first': {
      const s = a.random ? Math.floor(Math.random() * S.seats.length) : who.seat;
      S.first = s; S.active = s; S.turn = 1; S.phase = 0;
      eachCard(S.seats[s], c => c.r = false);
      log(`── ${S.seats[s].name || `席${s + 1}`}が先攻${a.random ? '（ランダム）' : ''}。第1ターン ${PHASES[0]} ──`, 'turn');
      return;
    }
    case 'phase':
      if (S.active == null) return '先に先攻を決めてください';
      if (who.seat !== S.active) return '手番の人だけがフェイズを進められます';
      S.phase = Math.max(0, Math.min(PHASES.length - 1, a.p | 0));
      log(`${PHASES[S.phase]}${a.drew != null ? `（${a.drew ? a.drew + '枚ドロー' : '先攻1ターン目なので引かない'}）` : ''}`, 'phase');
      return;
    // ターンエンド（2026-11-16）：手番の人が押すと、まず相手に「エンド前にやることはありますか？」と聞く（S.endAsk）。
    // 相手が「ない」で本当に終わる。「ある」なら相手が済ませて「済んだ」を押すまで待つ。相手がいない時・a.force ならすぐ終わる
    case 'endTurn': {
      if (who.seat !== S.active) return '手番の人だけがターンを終えられます';
      const opp = S.seats.map((x, i) => i).filter(i => i !== who.seat && S.seats[i].name && S.seats[i].su === 'done' && canReach(i));
      if (!a.force && opp.length) {
        if (S.endAsk) return '相手の返事を待っています';
        S.endAsk = { k: rid(), seat: who.seat, ch: opp[0], wait: false };
        S.phase = PHASES.length - 1;
        log(`${nm}がターンを終えようとしています。${S.seats[opp[0]].name || '相手'}に、エンド前にやることがあるか確かめています`, 'phase');
        return;
      }
      if (a.force && S.endAsk) log(`${nm}が相手の返事を待たずにターンを終えました`);
      endTurnNow(S);
      return;
    }
    case 'endAns': {  // ターンエンドの確認への返事。ok：ない／済んだ → 終わる。wait：やることがある。cancel：手番の人が取りやめ
      const E = S.endAsk; if (!E) return;
      if (a.cancel) { if (who.seat !== E.seat) return; S.endAsk = null; log(`${nm}がターンエンドを取りやめました`); return; }
      if (who.seat !== E.ch) return `返事をするのは${S.seats[E.ch].name || '相手'}です`;
      if (a.wait) { E.wait = true; log(`${nm}：エンド前にやることがあります（済んだら「済んだ」を押します）`, 'phase'); return; }
      log(`${nm}：${E.wait ? 'エンド前にやることが済みました' : 'エンド前にやることはありません'}`, 'phase');
      endTurnNow(S);
      return;
    }
    // 効果で本国の下などへ送ったカードを、盤の真ん中に見せる（貯めG など。2026-11-16）。見た人が「OK」で閉じる（自分の画面だけ）
    case 'sent': {
      const ids = (a.ids || []).filter(id => BY_ID.has(id)).slice(0, 10);
      if (!ids.length) return;
      S.sent = { k: rid(), seat: who.seat, ids, src: String(a.src || '').slice(0, 30), to: String(a.to || '本国の下').slice(0, 20) };
      log(`${nm}が${String(a.msg || '').slice(0, 200)}`);
      return;
    }
    // ── 捨て山（非公開）を持ち主が触る。見ている間だけ、見ているカードの中身を持ち主に送る（seat.pk）
    case 'dpeek': {
      const arr = seatObj.z.discard;
      if (a.off) { seatObj.pk = null; return; }
      if (!a.n) { seatObj.pk = 'all'; log(`${nm}が捨て山を全部見ています（${arr.length}枚）`); }
      else { seatObj.pk = arr.slice(-a.n).map(c => c.u); log(`${nm}が捨て山の上から${seatObj.pk.length}枚を見ています`); }
      return;
    }
    case 'pdraw': {   // 捨て山の上から手札へ
      const arr = seatObj.z.discard, n = Math.min(a.n | 0, arr.length);
      if (n < 1) return '捨て山がありません';
      const got = arr.slice(-n).reverse();
      for (const o of new Set(got.map(c => c.o))) if (!canReach(o)) return `${S.seats[o].name || '持ち主'}がいないので動かせません`;
      arr.splice(arr.length - n, n);
      got.forEach(c => sendGain(c.o, { u: c.u, id: c.id }, 'hand'));
      log(`${nm}が捨て山の上から${n}枚を手札に加えました`);
      return;
    }
    case 'precover': {   // 捨て山の上からN枚を本国へ。heal＝回復（上へ1枚ずつ、裏向きのまま）。to：'top'|'bottom'
      const arr = seatObj.z.discard, want = Math.max(1, a.n | 0), n = Math.min(want, arr.length);
      if (n < 1) return '捨て山がありません';
      const got = arr.slice(-n).reverse();   // got[0] が捨て山の一番上
      for (const o of new Set(got.map(c => c.o))) if (!canReach(o)) return `${S.seats[o].name || '持ち主'}がいないので動かせません`;
      arr.splice(arr.length - n, n);
      if (seatObj.pk && seatObj.pk !== 'all') seatObj.pk = seatObj.pk.filter(u => !got.some(c => c.u === u));
      const to = a.to === 'bottom' ? 'bottom' : 'top';
      got.forEach(c => sendGain(c.o, { u: c.u, id: c.id }, to));
      const short = n < want ? `（捨て山が${n}枚しかなかったので${n}枚）` : '';
      log(a.heal ? `${nm}が本国を${n}回復しました${short}` : `${nm}が捨て山の上から${n}枚を本国の${to === 'top' ? '上' : '下'}へ戻しました${short}`);
      return;
    }
    case 'preorder': {   // 置き場の中の並べ替え（d：上へ+1／下へ-1、to：'top'|'bottom'）
      const f = findCard(S, a.u); if (!f || f.parent || !PILES.includes(f.zone)) return;
      const [c] = f.arr.splice(f.i, 1), L = f.arr.length;
      const j = a.to === 'top' ? L : a.to === 'bottom' ? 0 : Math.max(0, Math.min(L, f.i + (a.d | 0)));
      f.arr.splice(j, 0, c);
      log(`${nm}が${zoneLabel(f.seat, f.zone)}の並びを変えました`);
      return;
    }
    case 'pmove': {     // 捨て山の何枚かをまとめて動かす（us：捨て山の上から順。to：dtop/dbottom＝捨て山の上/下、top/bottom＝本国の上/下）
      const arr = seatObj.z.discard;
      let got = a.n ? arr.slice(-Math.max(1, a.n | 0)).reverse() : (a.us || []).map(u => arr.find(c => c.u === u)).filter(Boolean);
      if (!got.length) return '捨て山がありません';
      if (['top', 'bottom'].includes(a.to)) for (const o of new Set(got.map(c => c.o))) if (!canReach(o)) return `${S.seats[o].name || '持ち主'}がいないので動かせません`;
      got.forEach(c => arr.splice(arr.indexOf(c), 1));
      const n = got.length;
      if (a.to === 'dbottom') { arr.unshift(...got.slice().reverse()); log(`${nm}が${a.n ? `捨て山の上から${n}枚` : `見ていた${n}枚`}を捨て山の下へ送りました${a.n ? '' : '（好きな順で）'}`); return; }
      if (a.to === 'dtop') { arr.push(...got.slice().reverse()); log(`${nm}が見ていた${n}枚を捨て山の上に好きな順で置きました`); return; }
      if (seatObj.pk && seatObj.pk !== 'all') seatObj.pk = seatObj.pk.filter(u => !got.some(c => c.u === u));
      if (a.to === 'top') got.slice().reverse().forEach(c => sendGain(c.o, { u: c.u, id: c.id }, 'top'));
      else got.forEach(c => sendGain(c.o, { u: c.u, id: c.id }, 'bottom'));
      log(`${nm}が捨て山の${a.n ? '上から' : '見ていた'}${n}枚を本国の${a.to === 'top' ? '上' : '下'}へ（この並びのまま）`);
      return;
    }
    case 'pshuffle': { const z = PILES.includes(a.zone) ? a.zone : 'discard'; shuffle(seatObj.z[z]); if (z === 'discard') seatObj.pk = null; log(`${nm}が${ZONES[z]}を切りました`); return; }
    case 'rerollAll': eachCard(seatObj, c => c.r = false); log(`${nm}が自分のカードを全てリロール`); return;
    case 'newGame':
      if (who.seat !== 0) return '新しいゲームは部屋を作った人だけが始められます';
      S.game++; S.turn = 0; S.active = null; S.phase = null; S.first = null; S.reveal = null; S.pick = null;
      S.seats.forEach(s => { s.z = emptyZones(); s.ready = false; s.dn = 0; s.hn = 0; s.deckName = ''; s.sl = null; s.su = null; s.mull = 0; s.pk = null; s.sh = null; });
      S.endAsk = null; S.sent = null; S.pick = null;
      log('── 新しいゲーム。デッキを選んで準備してください ──', 'turn');
      return;
  }
}
// ターン終了：一時修正を消す（「ターン終了で消さない」にした物とコインは残す）
function clearTm(S) {
  let n = 0;
  S.seats.forEach(s => eachCard(s, c => { if (c.tm && !c.tm.k) { delete c.tm; n++; } }));
  if (n) log(`ターン終了：一時修正を消しました（${n}枚）`, 'sys');
}
function eachCard(seatObj, fn) { Object.values(seatObj.z).forEach(arr => arr.forEach(c => { fn(c); (c.s || []).forEach(fn); })); }
function canReach(seat) { return seat === mySeat() || B.conns.some(x => x.seat === seat); }
// 自動解決の続きを、効果を動かす席のブラウザへ（本国・手札はその人のブラウザにしかないため）
function sendFx(seat, m) {
  if (seat === mySeat() && B.role === 'host') setTimeout(() => handleFx(m), 0);   // apply の途中で act を呼ばないように後回し
  else B.conns.filter(x => x.seat === seat).forEach(x => x.conn.send({ k: 'fx', m }));
}
const gainBack = (seat, c) => sendGain(seat, { u: c.u, id: c.id }, 'hand');   // 断られた操作のカードを手札へ返す
function sendGain(seat, card, to) {
  if (seat === mySeat()) gain(card, to);
  else B.conns.filter(x => x.seat === seat).forEach(x => x.conn.send({ k: 'gain', card, to }));
}
// 見る人ごとに、他人の裏向きカードの中身を消して送る
function viewFor(seat) {
  const s = JSON.parse(JSON.stringify(B.S));
  // 捨て山は、持ち主が見ている（pk）カードだけ持ち主に中身を送る。相手・観戦者には送らない
  s.seats.forEach((st, si) => Object.entries(st.z).forEach(([z, arr]) => {
    const peek = si === seat && st.pk ? (st.pk === 'all' ? null : new Set(st.pk)) : undefined;
    const hide = x => (SECRET.includes(z) && !(peek === null || (peek && peek.has(x.u)))) || (x.f && x.o !== seat);
    arr.forEach(c => { if (hide(c)) c.id = null; (c.s || []).forEach(x => { if (hide(x)) x.id = null; }); });
  }));
  return s;
}
function broadcast() {
  if (B.priv) { B.S.seats[0].dn = B.priv.deck.length; B.S.seats[0].hn = B.priv.hand.length; }
  B.S.spect = B.conns.filter(x => x.role === 'spect').map(x => x.name);
  B.conns.forEach(x => { try { x.conn.send({ k: 'state', s: viewFor(x.seat) }); } catch (e) {} });
  try { localStorage.setItem('gw.hostroom', JSON.stringify({ code: B.code, S: B.S, rec: B.rec.slice(-2000), t: Date.now() })); } catch (e) {}
  render();
}

// 自分の操作を出す（管理役なら自分で当てる）
function act(a) {
  if (B.priv && isPlayer()) { a.dn = B.priv.deck.length; a.hn = B.priv.hand.length; }
  if (B.role === 'host') {
    const err = apply(a, { seat: 0, name: B.name });
    if (err) toast(err);
    broadcast();
  } else if (B.hostConn && !B.lost) B.hostConn.send({ k: 'act', a });
  else toast('つながっていません');
}
const online = () => B.role === 'host' || (B.hostConn && !B.lost);

// ---------------------------------------------------------------------
//  自分の本国・手札
// ---------------------------------------------------------------------
function gain(card, to) {
  if (!B.priv) return;
  if (to === 'hand') B.priv.hand.push(card);
  else if (to === 'top') B.priv.deck.unshift(card);
  else B.priv.deck.push(card);
  savePriv(); render();
  if (B.role !== 'host') act({ t: 'counts' });
}
function draw(n) {
  if (!B.priv) return 0;
  const got = B.priv.deck.splice(0, n);
  B.priv.hand.push(...got); savePriv();
  if (got.length) drawSE(got.length);
  return got.length;
}
// ドローの効果音（2026-11-16）。音のファイルは使わず、ブラウザでその場で作る（カードをめくる「シュッ」）。卓の右上の「音」で消せる
let audioCtx = null;
const seOn = () => store.get('se', '1') !== '0';
function drawSE(n) {
  if (!seOn()) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ac = audioCtx, len = Math.floor(ac.sampleRate * .09);
    const buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { const t = i / len; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2) * Math.min(1, t * 12); }
    for (let k = 0; k < Math.min(n, 4); k++) {
      const t0 = ac.currentTime + k * .1;
      const src = ac.createBufferSource(); src.buffer = buf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = .9;
      bp.frequency.setValueAtTime(1800, t0); bp.frequency.exponentialRampToValueAtTime(5200, t0 + .08);
      const g = ac.createGain(); g.gain.value = .55;
      src.connect(bp).connect(g).connect(ac.destination); src.start(t0);
      const o = ac.createOscillator(), og = ac.createGain();   // 最後に「パチッ」と置く音
      o.type = 'triangle'; o.frequency.setValueAtTime(900, t0 + .07); o.frequency.exponentialRampToValueAtTime(300, t0 + .11);
      og.gain.setValueAtTime(.0001, t0 + .07); og.gain.exponentialRampToValueAtTime(.25, t0 + .075); og.gain.exponentialRampToValueAtTime(.0001, t0 + .12);
      o.connect(og).connect(ac.destination); o.start(t0 + .07); o.stop(t0 + .13);
    }
  } catch (e) {}
}
// ターン開始の帯（2026-11-21）：ターンが変わった時、横から帯が滑り込んで反対へ抜ける。
// 手番の人には「YOUR TURN」、相手には「OPPONENT'S TURN」、観戦には「○○のターン」。音も3種（「音」で消せる）
let turnSeen;   // 最後に見たターン（undefined＝まだ盤面を見ていない）
function turnBanner(S) {
  const key = S && S.active != null && S.turn > 0 ? `${S.game}:${S.turn}:${S.active}` : null;
  if (key === turnSeen) return;
  const first = turnSeen === undefined; turnSeen = key;
  if (!key || first) return;   // 入った直後（途中の盤面）には出さない
  const act = S.active, who = esc(S.seats[act]?.name || `席${act + 1}`);
  const kind = !isPlayer() ? 'spec' : act === mySeat() ? 'mine' : 'opp';
  const big = kind === 'mine' ? 'YOUR TURN' : kind === 'opp' ? "OPPONENT'S TURN" : `TURN ${S.turn}`;
  const sub = kind === 'mine' ? `第${S.turn}ターン　あなたのターンです` : `第${S.turn}ターン　${who}のターン`;
  document.querySelectorAll('.tbanner').forEach(x => x.remove());
  const el = document.createElement('div');
  el.className = `tbanner ${kind}`;
  el.innerHTML = `<div class="tbband"><div class="tbin"><i class="tbtag">${kind === 'spec' ? 'TURN CHANGE' : `TURN ${S.turn}`}</i><b>${big}</b><span>${sub}</span></div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
  turnSE(kind);
}
function turnSE(kind) {
  if (!seOn()) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ac = audioCtx, t0 = ac.currentTime + .02;
    // 帯が通る「ヒュオッ」（雑音を低→高へ）
    const len = Math.floor(ac.sampleRate * .45), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { const t = i / len; d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * t) * .9; }
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(kind === 'opp' ? 500 : 700, t0); bp.frequency.exponentialRampToValueAtTime(kind === 'opp' ? 1600 : 3200, t0 + .4);
    const g = ac.createGain(); g.gain.value = .35;
    src.connect(bp).connect(g).connect(ac.destination); src.start(t0);
    // 音の並び：自分＝明るく上がる3音、相手＝低く下がる2音、観戦＝短い2音
    const notes = kind === 'mine' ? [[523, 0], [659, .09], [784, .18], [1047, .27]] : kind === 'opp' ? [[392, 0], [294, .16]] : [[587, 0], [880, .12]];
    const typ = kind === 'opp' ? 'sawtooth' : 'triangle';
    notes.forEach(([f, dt], i) => {
      const o = ac.createOscillator(), og = ac.createGain(), lp = ac.createBiquadFilter();
      o.type = typ; o.frequency.value = f; lp.type = 'lowpass'; lp.frequency.value = kind === 'opp' ? 1400 : 4000;
      const ts = t0 + .12 + dt, dur = i === notes.length - 1 ? .55 : .16;
      og.gain.setValueAtTime(.0001, ts); og.gain.exponentialRampToValueAtTime(kind === 'opp' ? .16 : .2, ts + .015); og.gain.exponentialRampToValueAtTime(.0001, ts + dur);
      o.connect(lp).connect(og).connect(ac.destination); o.start(ts); o.stop(ts + dur + .02);
    });
  } catch (e) {}
}
const takeFrom = (arr, u) => { const i = arr.findIndex(c => c.u === u); return i < 0 ? null : arr.splice(i, 1)[0]; };
const takeFromHand = u => takeFrom(B.priv.hand, u);
const takeFromDeck = u => takeFrom(B.priv.deck, u);
const takeFromLook = u => takeFrom(B.priv.look || (B.priv.look = []), u);
function playFrom(take, src, u, zone, opt = {}) {
  if (!online()) { toast('つながっていません'); return; }
  const c = take(u); if (!c) return;
  savePriv(); act({ t: 'enter', cards: [c], zone, seat: opt.seat ?? mySeat(), f: opt.f, onto: opt.onto, src, vb: opt.vb });
}
const playFromHand = (u, zone, opt) => playFrom(takeFromHand, 'hand', u, zone, opt);
const playFromDeck = (u, zone, opt) => playFrom(takeFromDeck, 'deck', u, zone, opt);
const playFromLook = (u, zone, opt) => playFrom(takeFromLook, 'deck', u, zone, opt);
// コマンドのプレイ（2026-11-16 叩き台）：①国力の条件を見る ②資源の分だけ本国の上から捨て山へ・カードを盤の真ん中へ
// ③効果は人が解決して「解決した」を押す ④持ち主のジャンクヤードへ（apply の cast / resolve）
const myPow = () => VS && B.priv && VS.seats[mySeat()].su ? gPower(mySeat()) : null;
function castLabel(x) {
  const pw = myPow(), ok = pw ? canPay(x, pw, B.priv.deck.length) : null, res = (x.k && x.k[2]) || 0;
  return `プレイする（${res ? `資源${res}：本国の上から${res}枚を捨て山へ` : '資源なし'}）${ok === false ? '　※国力が足りないかも' : ''}`;
}
function castFromHand(u) {
  if (!online()) { toast('つながっていません'); return; }
  const c = B.priv.hand.find(c => c.u === u); if (!c) return;
  const x = BY_ID.get(c.id), res = (x && x.k && x.k[2]) || 0, pw = myPow();
  if (B.priv.deck.length < res) { toast(`本国が${res}枚ないので資源を払えません`); return; }
  takeFromHand(u);
  const pay = B.priv.deck.splice(0, res);
  savePriv(); render();
  act({ t: 'cast', cards: [c], pay, short: !!(pw && canPay(x, pw, B.priv.deck.length + res) === false) });
}
function startWithDeck(d) {
  const list = [];
  Object.entries(d.cards).forEach(([id, n]) => { if (BY_ID.has(id)) for (let i = 0; i < n; i++) list.push({ u: `${B.seat}${rid()}${list.length}`, id }); });
  if (!list.length) { toast('このデッキは空です'); return; }
  B.priv = { game: B.S.game, deck: shuffle(list), hand: [], look: [] };
  savePriv(); act({ t: 'ready', deckName: d.name, dt: list.length, sl: d.sl || null });
  toast('本国を切りました。「ゲームスタート」で最初の手札を引きます');
}

// ---------------------------------------------------------------------
//  部屋に入る・作る
// ---------------------------------------------------------------------
function newCode() { return 'GW-' + String(Math.floor(1000 + Math.random() * 9000)); }
async function createRoom(resume) {
  const name = $('bName').value.trim(); if (!name) { toast('名前を入れてください'); return; }
  B.name = name; store.set('name', name);
  let code = resume ? resume.code : newCode(), hostObj = null, err = null;
  for (let tries = 0; tries < (resume ? 6 : 4); tries++) {
    lobbyMsg(resume ? `部屋 ${code} を開き直しています…` : '部屋を作っています…');
    try { hostObj = await Net.host(code, onConn); break; }
    catch (e) {
      err = e;
      if (e && e.type === 'unavailable-id') { if (resume) await new Promise(r => setTimeout(r, 3000)); else code = newCode(); continue; }
      break;
    }
  }
  if (!hostObj) { lobbyMsg('部屋を作れませんでした：' + netErr(err)); return; }
  B.role = 'host'; B.code = code; B.seat = 0;
  if (resume) { B.S = resume.S; B.rec = resume.rec || []; fillZones(B.S); }
  else B.S = { code, game: 1, turn: 0, active: null, seats: [emptySeat(), emptySeat()], log: [], spect: [] };
  B.S.seats[0].name = name; B.S.seats[0].online = true; B.S.seats[0].pk = null;
  B.S.seats.forEach((s, i) => { if (i) s.online = false; });
  B.priv = loadPriv(); if (B.priv && B.priv.game !== B.S.game) B.priv = null;
  log(resume ? `${name}が部屋 ${code} を開き直しました` : `${name}が部屋 ${code} を作りました`, 'sys');
  broadcast();
}
function onConn(conn) {
  conn.on('open', () => {
    const m = conn.metadata || {}, name = String(m.name || '名無し').slice(0, 20);
    let seat = null, role = 'spect';
    if (m.role === 'player') {
      // 同じ名前なら席を取り戻す（再読み込みで入り直した時。古い接続は切れたものとして外す）
      let i = B.S.seats.findIndex((s, i) => i > 0 && s.name === name);
      if (i > 0) B.conns.filter(y => y.seat === i).forEach(y => { y.seat = null; y.role = 'gone'; try { y.conn.close(); } catch (e) {} });
      if (i < 0) i = B.S.seats.findIndex((s, i) => i > 0 && !s.name);
      if (i < 0) i = B.S.seats.findIndex((s, i) => i > 0 && !s.online);
      if (i > 0) { seat = i; role = 'player'; const s = B.S.seats[i]; if (s.name !== name) { s.name = name; } s.online = true; s.pk = null; }
    }
    const x = { conn, seat, name, role }; B.conns.push(x);
    conn.send({ k: 'welcome', seat, role, code: B.code });
    log(role === 'player' ? `${name}が対戦者として入りました` : `${name}が観戦に来ました${m.role === 'player' ? '（対戦の席が埋まっています）' : ''}`, 'sys');
    broadcast();
    conn.on('data', d => {
      if (!d || d.k !== 'act') return;
      const err = apply(d.a, { seat: x.seat, name: x.name });
      if (err) conn.send({ k: 'err', msg: err });
      broadcast();
    });
    conn.on('close', () => {
      B.conns = B.conns.filter(y => y !== x);
      if (x.role === 'gone') return;
      if (x.seat != null && !B.conns.some(y => y.seat === x.seat)) B.S.seats[x.seat].online = false;
      log(`${name}が抜けました`, 'sys'); broadcast();
    });
  });
}
async function joinRoom(role) {
  const name = $('bName').value.trim(); if (!name) { toast('名前を入れてください'); return; }
  let code = $('bCode').value.trim().toUpperCase().replace(/\s/g, '');
  if (/^\d{4}$/.test(code)) code = 'GW-' + code;
  if (!/^GW-\d{4}$/.test(code)) { toast('部屋コードは GW-1234 の形です'); return; }
  B.name = name; store.set('name', name);
  lobbyMsg(`${code} につないでいます…`);
  let conn;
  try { conn = await Net.join(code, { role, name }); }
  catch (e) { lobbyMsg('入れませんでした：' + netErr(e)); return; }
  B.hostConn = conn; B.code = code; B.lost = false; B.role = role;
  conn.on('data', d => {
    if (!d) return;
    if (d.k === 'welcome') {
      B.seat = d.seat; B.role = d.role;
      if (role === 'player' && d.role === 'spect') toast('対戦の席が埋まっていたので観戦で入りました');
      B.priv = d.seat != null ? loadPriv() : null;
    } else if (d.k === 'state') {
      B.S = d.s;
      if (B.priv && B.priv.game !== B.S.game) { B.priv = null; savePriv(); }
      render();
    } else if (d.k === 'gain') gain(d.card, d.to);
    else if (d.k === 'fx') handleFx(d.m);
    else if (d.k === 'err') toast(d.msg);
  });
  conn.on('close', () => { B.lost = true; render(); });
}
function lobbyMsg(m) { const el = $('bMsg'); if (el) el.textContent = m; }

// ---------------------------------------------------------------------
//  画面
// ---------------------------------------------------------------------
const root = $('battle');
let VS = null; // 自分に見える盤面（管理役でも相手の裏向きカードは見えない）
function renderLobby() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('gw.hostroom')); } catch (e) {}
  if (saved && Date.now() - saved.t > 24 * 3600e3) saved = null;
  root.innerHTML = `<div class="blobby">
    <h2>対戦卓</h2>
    <div class="box">
      <div class="row"><span style="width:4em">名前</span><input id="bName" maxlength="20" value="${esc(B.name)}" placeholder="卓で表示する名前"></div>
    </div>
    <div class="box">
      <b>部屋を作る</b>
      <div class="note">部屋コードが出るので、LINEなどで相手と観戦の人に送ってください。あなたのブラウザが盤面の管理役になります（閉じると卓が止まります）。</div>
      <div class="row"><button id="bCreate" class="primary">部屋を作る</button>
      ${saved ? `<button id="bResume">前の部屋 ${esc(saved.code)} を開き直す</button>` : ''}</div>
    </div>
    <div class="box">
      <b>部屋に入る</b>
      <div class="row"><input id="bCode" class="code-in" placeholder="GW-1234" maxlength="7"></div>
      <div class="row"><button id="bJoinP" class="primary">対戦者で入る</button><button id="bJoinS">観戦で入る</button></div>
    </div>
    <div class="note" id="bMsg">${LOCAL ? '（試験モード：同じブラウザのタブ同士でつながります）' : ''}</div>
  </div>`;
  $('bCreate').onclick = () => createRoom(null);
  if (saved) $('bResume').onclick = () => createRoom(saved);
  $('bJoinP').onclick = () => joinRoom('player');
  $('bJoinS').onclick = () => joinRoom('spect');
  $('bCode').onkeydown = e => { if (e.key === 'Enter') joinRoom('player'); };
}

// 裏向きのカード。持ち主の席のデッキにスリーブ（裏面の画像、デッキ構築で設定）があればそれを出す（2026-11-17）
let slvTry = 0;
function backFace(seat, txt = 'GW') {
  const s = seat != null && (VS || B.S)?.seats?.[seat], k = s && s.sl;
  const u = k ? Images.raw(k) : null;
  if (k && !u && Date.now() - slvTry > 30000) { slvTry = Date.now(); Images.sync(); }   // 相手のスリーブがまだ届いていなければ取りに行く
  if (!u) return `<div class="mc back">${txt}</div>`;
  return `<div class="mc back slv"><img src="${esc(u)}" alt="スリーブ">${txt === 'GW' ? '' : `<span class="bl">${txt}</span>`}</div>`;
}
function miniFace(c, o) {
  const x = c.id && BY_ID.get(c.id);
  if (!x) return backFace(o);
  const u = Images.url(x);
  if (u) return `<div class="mc" data-c="${x.c}"><img src="${esc(u)}" alt="${esc(x.n)}" loading="lazy"></div>`;
  return `<div class="mc" data-c="${x.c}" style="--cc:var(--c-${x.c})">
    ${x.k && x.k[0] != null ? `<span class="mcost">${esc(costStr(x))}</span>` : `<span class="mcost">${esc(TYPE_NAME[x.t] || x.t)}</span>`}
    <span class="mname">${esc(x.n)}</span>
    ${x.st ? `<span class="mst">${esc(x.st.join('/'))}</span>` : ''}
    ${x.alt ? `<span class="malt">${esc(/^[（(【《\[]/.test((x.alt.text || [])[0] || '(') ? '' : x.alt.text[0])} ${esc((x.alt.stats || []).join('/'))}</span>` : ''}</div>`;
}
// カードの上の +1/+1/+1 コインなど（枚数分）
function coinMods(cs) {
  const out = [];
  for (const c of cs) for (const [k, n] of Object.entries(c.cn || {})) { const m = COIN_ST.exec(k); if (m) for (let i = 0; i < n; i++) out.push(m.slice(1)); }
  return out;
}
const coinBadges = c => { const e = Object.entries(c.cn || {}); return e.length ? `<div class="coins">${e.map(([k, n]) => `<span class="coin" title="${esc(k)} ${n}枚">${esc(coinShort(k))}${n > 1 ? `<b>×${n}</b>` : ''}</span>`).join('')}</div>` : ''; };
// カードの今の戦闘力：変形・セットしたカード・+1/+1/+1 コイン・一時修正を全部足した物。数字でない所（*）はそのまま
function cardStats(g) {
  const base = g.id && BY_ID.get(g.id);
  const st = g.v && base && base.alt ? base.alt.stats : base && base.st;   // 変形中は変形後の数字
  if (!st) return null;
  const tot = st.slice();
  const add = arr => arr.forEach((v, i) => { v = String(v); if (/^[+\-±]?\d+$/.test(v) && /^-?\d+$/.test(tot[i])) tot[i] = String(+tot[i] + +v.replace('±', '')); });
  for (const x of g.s || []) { const c = x.id && BY_ID.get(x.id); if (c && c.st) add(c.st); }
  for (const x of g.s || []) if (!x.f && fxOf(x.id).trBoost) { const n = trCount(x.o ?? g.o); add([n, n, n]); }   // シールド・キャノン（自動）
  coinMods([g, ...(g.s || [])]).forEach(add);
  [g, ...(g.s || [])].forEach(x => x.tm && add(x.tm.d));
  return tot;
}
const hasTm = g => [g, ...(g.s || [])].some(x => x.tm && x.tm.d.some(v => v));
// セットグループ・コイン・一時修正で元の数字から変わっている時だけ合計を返す
function groupStats(g) {
  if (!(g.s || []).length && !coinMods([g]).length && !hasTm(g)) return null;
  return cardStats(g);
}
// 部隊戦闘力：戦闘エリアの先頭のユニットの格闘力＋2番目からのユニットの射撃力の合計
function forceOf(arr) {
  const us = arr.filter(c => !c.coin && !c.f && c.id && UNIT_T.includes((BY_ID.get(c.id) || {}).t));
  if (!us.length) return null;
  const num = v => /^-?\d+$/.test(v) ? +v : null;
  let total = 0, unk = false;
  const parts = us.map((c, i) => {
    const st = cardStats(c) || [], v = num(st[i ? 1 : 0]);
    if (v == null) unk = true; else total += v;
    return `${i ? '射撃' : '先頭 格闘'} ${st[i ? 1 : 0] ?? '?'}『${cname(c)}』`;
  });
  return { total, unk, lead: us[0].u, note: parts.join('\n＋ ') };
}
// 場のカード（ロール中は横向き、セットしたカードは下に名札で）
function slot(c, src, lead = false) {
  if (c.coin) return `<div class="slot ctok" draggable="${isPlayer()}" data-src="${src}" data-u="${esc(c.u)}" data-coin="1" title="${esc(c.coin)} ${c.n}枚（カードに落とすと乗せます）"><div class="mc ctk"><span>${esc(c.coin.replace(/コイン$/, '') || 'コイン')}</span><b>×${c.n}</b></div></div>`;
  const known = c.id && BY_ID.get(c.id);
  const depth = x => { let d = 0, y = x; while (y && y.on && d < 20) { y = (c.s || []).find(z => z.u === y.on); d++; } return d; };
  const subs = (c.s || []).map(x => { const on = x.on && (c.s || []).find(z => z.u === x.on), dp = depth(x); return `<div class="sub${x.r ? ' r' : ''}${dp ? ' on' : ''}" style="${dp ? `--dp:${dp}` : ''}" draggable="${isPlayer()}" data-src="${src}" data-u="${esc(x.u)}" ${x.id ? `data-cid="${esc(x.id)}"` : ''} title="${on ? `『${esc(on.f && !on.id ? '裏向きのカード' : cname(on))}』の上にセットしているカード` : 'セットしているカード'}。押すとこのカードだけ動かせます（手札・本国・捨て山など）。このカードの上にさらにセットするには、ここへ落とします">${dp ? '↳'.repeat(Math.min(dp, 3)) : ''}${esc(x.f && !x.id ? '裏向き' : cname(x))}${Object.keys(x.cn || {}).length ? ` ●${Object.values(x.cn).reduce((a, b) => a + b, 0)}` : ''}${x.tm ? ` <span class="tms" title="${esc(tmTitle(x.tm))}">${esc(tmLabel(x.tm))}</span>` : ''}${!x.f && fxOf(x.id).trBoost ? (n => ` <span class="tms auto" title="自動：場・自軍ハンガー・自軍ジャンクヤードの「名称:TR」のユニット${n}枚（5まで）→ +${n}/+${n}/+${n}（合計に足しています）">自動+${n}</span>`)(trCount(x.o ?? c.o)) : ''}</div>`; }).join('');
  const tot = !c.f ? groupStats(c) : null;
  const tmc = hasTm(c) ? ' tm' : '';
  // 場のユニットは今の戦闘力（変形・セット・コイン・一時修正込み）をカードの下に大きく（2026-11-17）。元から変わった数字は色を変える
  const now = src === 'pub' && !c.f && !c.vb && known && UNIT_T.includes(known.t) ? cardStats(c) : null;
  const base = now && (c.v && known.alt ? known.alt.stats : known.st) || [];
  const ust = now ? `<div class="ust${tmc}${tot ? ' grp' : ''}" title="${tot ? (subs ? 'セットグループの合計' : '今の戦闘力') + '（格闘/射撃/耐久。セット・コイン・一時修正込み）' : '格闘/射撃/耐久'}">${(subs && tot) ? '<small>計</small>' : ''}${now.map((v, i) => `<b class="${String(v) === String(base[i]) ? '' : (+v > +base[i] ? 'up' : +v < +base[i] ? 'dn' : 'ch')}">${esc(v)}</b>`).join('<i>/</i>')}</div>`
    : tot ? `<div class="gst ov${tmc}" title="コイン・一時修正込みの戦闘力">[${esc(tot.join(']['))}]</div>` : '';
  const v = c.v && !c.f && known && known.alt;
  const tmb = c.tm ? `<div class="tmb" title="${esc(tmTitle(c.tm))}">${esc(tmLabel(c.tm))}</div>` : '';
  const vb = c.vb && !c.f && known;
  return `<div class="slot${c.r ? ' r' : ''}${v ? ' v' : ''}${vb ? ' vb' : ''}${lead ? ' lead1' : ''}${c.tk ? ' tok' : ''}${now ? ' hst' : ''}" draggable="${isPlayer()}" data-src="${src}" data-u="${esc(c.u)}" ${known ? `data-cid="${esc(c.id)}"` : ''}>${lead ? '<span class="leadtag">先頭</span>' : ''}${c.tk ? '<span class="tktag" title="トークン（場を離れると消えます）">トークン</span>' : ''}${vb ? `<span class="vbtag" style="--cc:var(--c-${known.c})" title="ヴァリアブル：${known.c}の特殊G（国力${known.c}1）として扱います">G ${known.c}</span>` : ''}${(c.f && known) ? backFace(c.o, '裏') : miniFace(c, c.o)}${coinBadges(c)}${tmb}${ust}${subs ? `<div class="subs">${subs}</div>` : ''}</div>`;
}
function zoneHtml(seat, z, cls = '') {
  const arr = VS.seats[seat].z[z];
  if (PILES.includes(z)) {
    const top = arr[arr.length - 1];
    const face = !top ? '' : SECRET.includes(z) ? stackHtml(seat, arr.length) : slot(top, 'pub').replace('draggable="true"', 'draggable="false"');
    return `<div class="zone pile" data-seat="${seat}" data-zone="${z}" data-pile="1"><div class="zl">${ZONES[z]}</div><div class="zc">${face}</div><span class="num${arr.length ? '' : ' zero'}">${arr.length}</span></div>`;
  }
  const bat = BATTLE.includes(z), fo = bat ? forceOf(arr) : null;
  const lead = bat && !fo ? '<div class="leadbox" title="戦闘エリアは左が先頭です（カードのメニューで前後を入れ替え）"><span>先頭</span></div>' : '';
  const force = fo ? `<b class="bforce${fo.unk ? ' unk' : ''}" title="${ZONES[z]}の部隊戦闘力＝先頭のユニットの格闘力＋2番目からのユニットの射撃力（コイン・一時修正込み）\n${esc(fo.note)}${fo.unk ? '\n数字でない所（*など）は0として数えています' : ''}"><small>部隊戦闘力</small><em>${fo.total}</em>${fo.unk ? '<i>＋?</i>' : ''}</b>` : '';
  const add = isPlayer() && seat === mySeat() && !['cmd', 'hangar'].includes(z) ? `<span class="zadd" data-coinzone="${z}" title="この置き場にコインやトークン（ボルジャーノンコインなど、効果で出るユニット）を置きます（カードの上に乗せるのはカードのメニューか、コインをカードへドラッグ）">＋コイン</span>` : '';
  return `<div class="zone ${cls}${bat ? ' bat' : ''}" data-seat="${seat}" data-zone="${z}"><div class="zl">${force}<span class="znm">${ZEN[z] ? `<i class="zen">${ZEN[z]}</i>` : ''}${bat ? ZONES[z].replace(/^戦闘エリア（(.+)）$/, '$1') : ZONES[z]}${arr.length ? `<span class="zcnt">${arr.length}</span>` : ''}</span>${add}</div><div class="zc">${lead}${arr.map(c => slot(c, 'pub', !!fo && c.u === fo.lead)).join('')}</div></div>`;
}
// 本国・捨て山はカードの束に見せる（2026-11-16）。厚みは デッキの枚数（ready の dt）に対する今の枚数の割合
function deckTotal(seat) {
  const s = VS.seats[seat]; if (s.dt) return s.dt;
  let n = (seat === B.seat && B.priv ? B.priv.deck.length + B.priv.hand.length : (s.dn || 0) + (s.hn || 0));
  Object.values(s.z).forEach(arr => arr.forEach(c => { if (!c.coin && !c.tk) n += 1 + (c.s || []).length; }));
  return Math.max(n, 1);
}
const stackHtml = (seat, n, attrs = '') => n ? `<div class="slot stk" ${attrs} style="--h:${Math.min(1, n / deckTotal(seat)).toFixed(3)}" title="${n}枚（デッキ${deckTotal(seat)}枚の${Math.round(Math.min(1, n / deckTotal(seat)) * 100)}%）">${backFace(seat)}</div>` : '';
function deckPile(seat) {
  const s = VS.seats[seat], mine = seat === B.seat && B.priv;
  const n = mine ? B.priv.deck.length : s.dn;
  return `<div class="zone pile" data-seat="${seat}" data-zone="deck" ${mine ? 'data-mydeck="1"' : ''}><div class="zl">本国</div><div class="zc">${stackHtml(seat, n, mine ? 'draggable="true" data-src="decktop"' : '')}</div><span class="num${n ? '' : ' zero'}">${n}</span></div>`;
}
function rowHtml2(seat) {
  return `<div class="bhalf${VS.active === seat ? ' active' : ''}">
    ${gZoneHtml(seat)}<div class="piles">${zoneHtml(seat, 'junk')}${zoneHtml(seat, 'removed')}</div>${zoneHtml(seat, 'deploy', 'dep')}</div>`;
}
// コマンド・ハンガー（自分は手札の右に。相手と観戦の見る席は名前の行に小さく）
function sideZones(seat, mini) {
  return `<div class="bside2${mini ? ' mini' : ''}">${zoneHtml(seat, 'hangar', 'hang')}</div>`;
}
// ---------------------------------------------------------------------
//  G 置き場：基本Gは色ごとの束（例「緑×4」）、特殊G・裏向き・セット付きは1枚ずつ。
//  上に「今発生している国力」。カードの gp（[色, 数, 条件]、tools/build_cards_js.py が文面から読む）で数える
// ---------------------------------------------------------------------
const GCOL = ['白', '青', '緑', '黒', '赤', '茶', '紫'];
// ---------------------------------------------------------------------
//  カードの効果の自動反映：文面から決まった形の効果を見つけて、卓の数に足す。
//  FX_RULES に { k: 名前, re: 文面の形 } を足せば増やせる（見つけた物は fxOf(id).名前 が true）
// ---------------------------------------------------------------------
const FX_RULES = [
  // 貯めG：「このカードは○国力Xを発生する。…Xの値は、このカードの上のコインの個数+1とする」
  { k: 'gpCoin', re: /国力Xを発生する。[^/]*Xの値は、このカードの上のコインの個数\+1とする/ },
  // 貯めGの「手札のユニットとコマンド以外を表にして本国の下に移す。その場合、このカードの上にコイン1個」
  { k: 'tame', re: /手札にあるユニットとコマンド以外のカード1枚を、表にしてから持ち主の本国の下に移す。その場合、このカードの上にコイン1個を乗せる/ },
  // シールド・キャノン（O-81）：セットされているユニットは +X/+X/+X。X＝場・自軍ハンガー・自軍ジャンクヤードの「名称:TR」のユニットの枚数（5まで）
  { k: 'trBoost', re: /\+X\/\+X\/\+Xを得る。Xの値は、5を上限とする、場、自軍ハンガー、自軍ジャンクヤードにある、「名称:TR」であるユニットの枚数/ }
];
const fxCache = new Map();
function fxOf(id) {
  if (!id) return {};
  if (fxCache.has(id)) return fxCache.get(id);
  const x = BY_ID.get(id), txt = x ? (x.x || []).join('/') : '', fx = {};
  for (const r of FX_RULES) if (r.re.test(txt)) fx[r.k] = true;
  fxCache.set(id, fx);
  return fx;
}
// よく使うコマンドの自動解決（2026-11-16 試し版）。同じ名前で違う版があるので id で絞る。
// 「解決する（自動）」で効果を動かしてからジャンクヤードへ（apply の resolve → autoHost / handleFx）
const AUTO_FX = {
  'C-22|黒い覇道': { k: 'destroy', d: 'Gとユニット以外のカード1枚を選んで破壊（持ち主のジャンクヤードへ）' },
  'C-73|ブリーフィング': { k: 'brief', d: '本国の上3枚を表にし、相手が選んだ2枚を手札へ（残りは本国の上）' },
  'C-7|密約': { k: 'draw2', d: 'プレイヤー1人がカード2枚を引く' },
  'C-8|サラサ再臨': { k: 'sarasa', d: '本国の上5枚から1枚を手札へ、残りは好きな順で本国の下へ' },
  'C-2|宝物没収': { k: 'pdraw2', d: '捨て山の上のカード2枚を引く' }
};
const coinCount = c => Object.values(c.cn || {}).reduce((a, b) => a + b, 0);
// シールド・キャノンの X：場（両者の配備・戦闘エリア・リング）と、持ち主のハンガー・ジャンクヤードにある、名前に「TR」を含む表向きのユニットの枚数（5まで）
function trCount(seat) {
  const S = VS || B.S; if (!S) return 0;
  const isTR = c => { const x = !c.coin && !c.f && !c.vb && c.id && BY_ID.get(c.id); return !!x && UNIT_T.includes(x.t) && /TR/.test(x.n); };
  let n = 0;
  S.seats.forEach((st, si) => ['deploy', ...BATTLE, ...(si === seat ? ['hangar', 'junk'] : [])].forEach(z => (st.z[z] || []).forEach(c => { if (isTR(c)) n++; })));
  return Math.min(5, n);
}
// 今そのGが出している国力の数（貯めGはコインの個数+1）
const gpAmount = (c, gp) => !c.vb && fxOf(c.id).gpCoin ? coinCount(c) + 1 : gp[1];
const gOpen = new Set();       // 束を広げて見ている席（自分の画面だけ）
function gPower(seat) {
  const pow = {}, cnt = {}, roll = {}, fx = {}; let unk = 0;
  const z = VS.seats[seat].z;
  for (const c of [...z.G, ...(z.deploy || []).filter(c => c.vb)]) {   // ヴァリアブルで出したカードも、その色の特殊Gとして数える
    if (c.coin) continue;
    const x = !c.f && c.id && BY_ID.get(c.id), gp = x && (c.vb ? [x.c, 1, ''] : x.gp);
    if (!gp) { unk++; continue; }
    const [col, , cond] = gp, k = gpAmount(c, gp);
    if (k !== gp[1]) fx[col] = (fx[col] || 0) + k - gp[1];   // 効果で増えた分（見出しに出す）
    cnt[col] = (cnt[col] || 0) + 1;
    if (c.r) roll[col] = (roll[col] || 0) + 1;
    const off = (cond === 'R' && c.r) || (cond === 'myTurn' && VS.active !== seat)
      || (cond === 'myDeploy' && !(VS.active === seat && VS.phase === 2));
    if (!off) pow[col] = (pow[col] || 0) + k;
  }
  return { pow, cnt, roll, unk, fx };
}
// 手札のカードが今の国力で出せるか（合計国力・指定国力を満たし、資源の分だけ本国がある）。G やコストのない物は null
function canPay(x, pw, deckN) {
  if (!x || x.t === 'G' || !x.k || x.k[0] == null) return null;
  const pow = pw.pow, total = Object.values(pow).reduce((a, b) => a + b, 0);
  const [need, sum, res] = x.k, col = x.c === '無' ? null : x.c;
  if (total < (sum || 0) || deckN < (res || 0)) return false;
  if (col ? (pow[col] || 0) < need : total < need) return false;
  if (x.d) {
    if (x.d[0] === '任意') { if (total < (col ? need : 0) + x.d[1]) return false; }
    else if ((pow[x.d[0]] || 0) < x.d[1]) return false;
  }
  return true;
}
function gSummary(seat) {
  const arr = VS.seats[seat].z.G, { pow, cnt, roll, unk, fx } = gPower(seat);
  const cols = GCOL.filter(c => cnt[c]);
  const total = Object.values(pow).reduce((a, b) => a + b, 0);
  const chips = cols.map(c => {
    const p = pow[c] || 0, more = cnt[c] !== p - (fx[c] || 0) ? `<small>/${cnt[c]}枚</small>` : '';
    const tm = fx[c] ? `<small class="gfx" title="貯めG（上のコインの個数+1）で増えている分">貯+${fx[c]}</small>` : '';
    // 基本Gはロールしていても国力を出す。ロールの数は茶（Gをロールして使う効果が多い）だけ見出しに出す
    const r = c === '茶' ? `<small class="rl">ロール${roll[c] || 0}</small>` : '';
    return `<span class="gchip${p ? '' : ' zero'}" style="--cc:var(--c-${c})" title="${c}：国力${p}（${cnt[c]}枚${roll[c] ? `、ロール${roll[c]}` : ''}${fx[c] ? `、うち貯めGで+${fx[c]}` : ''}）">${c}${p}${more}${tm}${r}</span>`;
  }).join('') + (unk ? `<span class="gchip unk" title="出す国力がデータで分からないG（裏向き・効果で決まる物など）。人が判断してください">？${unk}</span>` : '');
  const tog = arr.length ? `<span class="gtog" data-gtog="${seat}">${gOpen.has(seat) ? '束ねる' : '広げる'}</span>` : '';
  const nv = (VS.seats[seat].z.deploy || []).filter(c => c.vb).length;
  return `<div class="zl gsum" title="今発生している国力 ${total}${nv ? `（配備エリアのヴァリアブル${nv}枚を含む）` : ''}">G<b>${arr.length ? arr.length + '枚' : ''}${nv ? `<small title="配備エリアにヴァリアブルで出したカード">+V${nv}</small>` : ''}</b>${chips}${tog}</div>`;
}
function gZoneHtml(seat) {
  const arr = VS.seats[seat].z.G;
  let body;
  if (gOpen.has(seat)) body = arr.map(c => slot(c, 'pub')).join('');
  else {
    const loose = [], bun = {};
    for (const c of arr) {
      const x = !c.f && !(c.s || []).length && c.id && BY_ID.get(c.id);
      if (x && x.basic) (bun[x.c] = bun[x.c] || []).push(c); else loose.push(c);
    }
    body = GCOL.filter(col => bun[col]).map(col => {
      const cs = bun[col], nr = cs.filter(c => c.r).length;
      const rep = [...cs].reverse().find(c => !c.r) || cs[cs.length - 1];   // ダブルクリック・ドラッグはリロール中の1枚から
      return `<div class="gb${nr === cs.length ? ' allr' : ''}" draggable="${isPlayer()}" data-src="pub" data-gb="${col}" data-seat="${seat}" data-u="${esc(rep.u)}" data-cid="BASIC|${col}" style="--cc:var(--c-${col})" title="基本G（${col}）${cs.length}枚。ダブルクリックで1枚ロール、押すとメニュー">
        <span class="gbc">${col}</span><span class="gbn">×${cs.length}</span>${nr ? `<span class="gbr">ロール${nr}</span>` : ''}</div>`;
    }).join('') + loose.map(gSlim).join('');
  }
  return `<div class="zone g" data-seat="${seat}" data-zone="G">${gSummary(seat)}<div class="zc">${body}</div></div>`;
}
// 束ねている時の特殊G・裏向きなど：細い札にする（ロールは横にせず暗くして「ロール」と書く）
function gSlim(c) {
  if (c.coin) return slot(c, 'pub');
  const x = !c.f && c.id && BY_ID.get(c.id), col = x ? (x.gp ? x.gp[0] : x.c) : null;
  const subs = (c.s || []).length ? `<span class="gss">+${c.s.length}</span>` : '';
  const tame = x && fxOf(c.id).gpCoin ? `<span class="gtame" title="貯めG：コイン${coinCount(c)}個 → ${x.gp ? x.gp[0] : x.c}国力${coinCount(c) + 1}">●${coinCount(c)}<b>${coinCount(c) + 1}</b></span>` : '';
  return `<div class="gb gsl${c.r ? ' allr' : ''}" draggable="${isPlayer()}" data-src="pub" data-u="${esc(c.u)}" ${x ? `data-cid="${esc(c.id)}"` : ''} style="--cc:${col ? `var(--c-${col})` : '#2b3550'}" title="${esc(x ? x.n : '裏向きのカード')}">
    <span class="gsn">${esc(x ? x.n : '裏')}</span>${tame}${subs}${c.r ? '<span class="gbr">R</span>' : ''}</div>`;
}
function gbMenu(seat, col, x, y) {
  const cs = VS.seats[seat].z.G.filter(c => !c.f && !(c.s || []).length && c.id === 'BASIC|' + col);
  if (!cs.length) return;
  const up = [...cs].reverse().find(c => !c.r), dn = cs.find(c => c.r);
  menu(x, y, `基本G（${col}）×${cs.length}${seat === B.seat ? '' : `（${B.S.seats[seat].name}のG）`}`, [
    ...up ? [['1枚ロール', () => act({ t: 'roll', u: up.u })]] : [],
    ...dn ? [['1枚リロール', () => act({ t: 'roll', u: dn.u })]] : [], '-',
    ['1枚を動かす…', () => pubMenu((up || cs[cs.length - 1]).u, x, y)],
    ['束を広げる', () => { gOpen.add(seat); render(); }]
  ], { cid: 'BASIC|' + col });;
}
function seatStrip(seat, me) {
  const s = VS.seats[seat];
  const status = !s.name ? '<span class="off">（空席）</span>' : s.online ? '' : '<span class="off">（切断中）</span>';
  const act = VS.active === seat ? '<span class="act">● ターンプレイヤー</span>' : '';
  const hand = me ? '' : ` 手札 <b>${s.hn}</b>枚 ${s.hn ? '<span style="letter-spacing:-2px">' + '▮'.repeat(Math.min(s.hn, 20)) + '</span>' : ''}`;
  return `<div class="bstrip"><b>${esc(s.name || `席${seat + 1}`)}</b>${status}${act}<span>${s.ready ? esc(s.deckName) : (s.name ? '準備中…' : '')}</span><span>${hand}</span></div>`;
}
function phaseBar(S, me) {
  // 左端の縦長の欄：今どのフェイズか
  if (S.active == null) return `<div class="bphase"><b>準備中</b><span class="note">${S.seats.every(s => s.su === 'done') ? '両者の手札が決まりました。先攻を決めてください' : '両者が「ゲームスタート」で手札を決めたら、先攻を決めます'}</span></div>`;
  const mine = S.active === me && isPlayer();
  return `<div class="bphase${mine ? ' mine' : ''}"><b>第${S.turn}ターン</b><span class="who">${mine ? 'あなた' : esc(S.seats[S.active].name || `席${S.active + 1}`)}<br>のターン</span>
    ${PHASES.map((p, i) => `<span class="ph${i === S.phase ? ' on' : ''}${i < S.phase ? ' done' : ''}${i >= 3 && i <= 6 ? ' bt' : ''}" ${mine ? `data-ph="${i}" title="押すとこのフェイズにします"` : ''}>${p.replace(/(フェイズ|ステップ)$/, '<small>$1</small>')}</span>`).join('')}
    ${mine ? `<div class="phbtn">${S.phase < PHASES.length - 1 ? `<button id="bNext" class="primary" title="次へ：${PHASES[S.phase + 1]}">次へ ▼</button>` : ''}<button id="bEnd" ${S.phase === PHASES.length - 1 ? 'class="primary"' : ''}>ターンエンド</button></div>` : isPlayer() ? '<span class="note" style="text-align:center">相手のターンです</span>' : ''}</div>`;
}
// 公開中の手札を管理役へ知らせる（手札が変わって公開中のカードが出ていったら、その分も）
function syncShow() {
  if (!B.priv || !isPlayer() || !online()) return;
  const hand = B.priv.hand, keep = new Set(hand.map(c => c.u));
  const sh = (B.priv.show || []).filter(u => keep.has(u));
  if (sh.length !== (B.priv.show || []).length) { B.priv.show = sh; savePriv(); }
  const cards = hand.filter(c => sh.includes(c.u)).map(c => ({ u: c.u, id: c.id }));
  const sig = JSON.stringify(cards), cur = JSON.stringify(((B.S.seats[mySeat()] || {}).sh || { c: [] }).c);
  if (sig === cur) { B.shSent = sig; return; }
  if (B.shSent === sig) return;   // 送った物が戻ってくるのを待っている
  B.shSent = sig;
  act({ t: 'show', cards, all: !!B.showAll });
  B.showAll = false;
}
function setShow(us, all) { B.priv.show = us; B.showAll = all; savePriv(); syncShow(); render(); }
// 相手（観戦なら両者）の公開中の手札。ふだんは盤の上に大きく重ねて出す（2026-11-16）。
// 「小さくする」で前の1行に畳め、公開されるカードが変わるとまた大きく出る
const shMin = {}, shSig = {};
function shownRow(seat, big) {
  const s = VS.seats[seat], sh = s.sh; if (!sh || !sh.c.length) return '';
  const sig = sh.c.map(c => c.u).join(',');
  if (shSig[seat] !== sig) { shSig[seat] = sig; shMin[seat] = false; }
  if (!!shMin[seat] === !!big) return '';
  const rest = Math.max(0, s.hn - sh.c.length);
  const canPt = isPlayer() && seat !== mySeat();
  const who = esc(s.name || `席${seat + 1}`);
  // 「指定」ボタンはカードの下に直接（2026-11-16：メニューを開かなくても押せるように。Edge で指定できなかった件）
  const ptb = c => canPt ? `<button class="mini ptbtn${sh.pt === c.u ? ' on' : ''}" data-ptbtn="${esc(c.u)}" data-seat="${seat}">${sh.pt === c.u ? '指定を外す' : '指定する'}</button>` : '';
  const cards = sh.c.map(c => `<div class="shcard">${slot({ u: c.u, id: c.id }, 'shown').replace(/draggable="(true|false)"/, 'draggable="false"').replace('class="slot', `data-seat="${seat}" class="slot${sh.pt === c.u ? ' pt' : ''}`)}${ptb(c)}</div>`).join('')
    + (rest ? `<div class="slot">${backFace(seat, `裏<br>×${rest}`)}</div>` : '');
  const cnt = `<span class="shn">${sh.c.length}</span>枚${rest ? `<span class="shr">（ほかに裏 ${rest}枚）</span>` : '<span class="shr">（全部）</span>'}`;
  if (big) return `<div class="bshown big" style="--n:${sh.c.length + (rest ? 1 : 0)}"><div class="shh"><span class="hudtag">OPEN HAND</span><b>${who}</b>の手札を公開中　${cnt}${canPt ? '<span class="shhint">押すと指定（ハンデスなど）・乗せると右に大きく</span>' : ''}<button class="mini shmin" data-shtog="${seat}" title="1行に畳みます（公開中のカードが変わるとまた大きく出ます）">小さくする ▲</button></div>
    <div class="zc">${cards}</div></div>`;
  return `<div class="bshown"><div class="zl"><span><b>${who}</b>の手札を公開中　${cnt}</span><button class="mini" data-shtog="${seat}">大きく見る ▼</button></div>
    <div class="zc">${cards}</div></div>`;
}
function shownOverlay(seats) {
  const h = seats.map(x => shownRow(x, true)).filter(Boolean);
  return h.length ? `<div class="bshowov${h.length > 1 ? ' two' : ''}">${h.join('')}</div>` : '';
}
// プレイ中のカード（両者の cmd）を盤の真ん中に大きく。後からプレイした物ほど右（先に解決する）
let castMin = false, castSig = '';
function castOverlay() {
  const list = [];
  VS.seats.forEach((st, si) => (st.z.cmd || []).forEach(c => list.push({ c, si })));
  if (!list.length) { castSig = ''; return ''; }
  list.sort((a, b) => (a.c.at || 0) - (b.c.at || 0));
  const sig = list.map(x => x.c.u).join(',');
  if (sig !== castSig) { castSig = sig; castMin = false; }
  const last = list[list.length - 1].c.u;
  const cards = list.map(({ c, si }, i) => {
    const who = esc(VS.seats[si].name || `席${si + 1}`), mine = isPlayer() && si === mySeat(), top = c.u === last;
    const fx = AUTO_FX[c.id], opn = esc(VS.seats[1 - si]?.name || '相手');
    const res = !fx ? `<button class="primary mini" data-resolve="${esc(c.u)}" title="効果を解決し終えたら押します。カードは${who}のジャンクヤードへ">解決した</button>`
      : fx.k === 'draw2' ? `<button class="primary mini" data-resolve="${esc(c.u)}" data-ds="${si}" title="自動：${who}が2枚引いて、カードはジャンクヤードへ">${who}が2枚引く</button><button class="primary mini" data-resolve="${esc(c.u)}" data-ds="${1 - si}" title="自動：${opn}が2枚引いて、カードはジャンクヤードへ">${opn}が2枚引く</button><button class="mini" data-resolve="${esc(c.u)}" data-how="manual" title="自動にしないで、手で解決した時">手で解決</button>`
      : `<button class="primary mini" data-resolve="${esc(c.u)}" title="自動：${esc(fx.d)}。カードは${who}のジャンクヤードへ">解決する（自動）</button><button class="mini" data-resolve="${esc(c.u)}" data-how="manual" title="自動にしないで、手で解決した時">手で解決</button>`;
    const btn = isPlayer() ? `<div class="cbtn">${res}
      <button class="mini" data-resolve="${esc(c.u)}" data-how="cut" title="打ち消された時。カードは${who}のジャンクヤードへ">打ち消された</button>
      ${mine ? `<button class="mini" data-castback="${esc(c.u)}" title="間違えた時。カードは手札へ戻ります（払った資源は捨て山に残ります）">手札に戻す</button>` : ''}</div>` : '';
    return `<div class="citem${top ? ' top' : ''}${si === mySeat() && B.role !== 'spect' ? ' me' : ''}"><div class="ch"><span class="cno">${i + 1}</span><b>${who}</b>${c.pay ? `<small>資源${c.pay}</small>` : ''}${top && list.length > 1 ? '<span class="cfirst">先に解決</span>' : ''}</div>${AUTO_FX[c.id] ? `<div class="cauto" title="「解決する（自動）」で卓が動かします">自動：${esc(AUTO_FX[c.id].d)}</div>` : ''}
      ${slot(c, 'pub').replace(/draggable="(true|false)"/, 'draggable="false"').replace('data-src="pub"', 'data-src="cast"')}${btn}</div>`;
  }).join('');
  if (castMin) return `<div class="bcast min"><span class="hudtag">COMMAND</span><span>プレイ中 <b>${list.length}</b>枚：${list.map(x => '『' + esc(cname(x.c)) + '』').join('')}</span><button class="mini" data-casttog="1">大きく見る ▼</button></div>`;
  return `<div class="bcast" style="--n:${list.length}"><div class="shh"><span class="hudtag">COMMAND</span>プレイ中のカード<span class="shr">効果を解決したら「解決した」でジャンクヤードへ${list.length > 1 ? '・右から先に解決' : ''}</span><button class="mini shmin" data-casttog="1" title="盤を見たい時に畳みます">小さくする ▲</button></div><div class="zc">${cards}</div></div>`;
}
// 効果で送ったカード（貯めGで本国の下へ など）を盤の真ん中に。「OK」でその人の画面だけ閉じる
let sentSeen = '';
function sentOverlay() {
  const T = VS.sent; if (!T || T.k === sentSeen) return '';
  const who = esc(VS.seats[T.seat].name || `席${T.seat + 1}`);
  const cards = T.ids.map((id, i) => `<div class="citem">${slot({ u: 'sent' + i, id }, 'pub').replace(/draggable="(true|false)"/, 'draggable="false"').replace('data-src="pub"', 'data-src="cast"')}</div>`).join('');
  return `<div class="bcast bsent" style="--n:${T.ids.length}"><div class="shh"><span class="hudtag">${esc(T.src || 'EFFECT')}</span><b>${who}</b>が${esc(T.to)}へ送ったカード<span class="shr">表にして${esc(T.to)}へ（記録にも出ています）</span><button class="primary mini" data-sentok="${esc(T.k)}">OK</button></div><div class="zc">${cards}</div></div>`;
}
// ターンエンドの確認（相手に「エンド前にやることはありますか？」）
function endOverlay() {
  const E = VS.endAsk; if (!E) return '';
  const me = mySeat(), ask = esc(VS.seats[E.seat].name || '手番の人'), chn = esc(VS.seats[E.ch].name || '相手');
  let body;
  if (isPlayer() && me === E.ch) body = E.wait
    ? `<span class="shr">やることが済んだら押してください</span><button class="primary" data-endans="ok">済んだ（ターンエンドへ）</button>`
    : `<button class="primary" data-endans="ok">ない（ターンエンドへ）</button><button data-endans="wait">ある（少し待って）</button>`;
  else if (isPlayer() && me === E.seat) body = `<span class="shr">${chn}の返事を待っています${E.wait ? '（エンド前にやることがあるそうです）' : ''}</span><button class="mini" data-endans="force" title="相手がいない時など">待たずにエンド</button><button class="mini" data-endans="cancel">取りやめ</button>`;
  else body = `<span class="shr">${chn}の返事を待っています</span>`;
  return `<div class="bendask"><span class="hudtag">TURN END</span><div class="eq"><b>${ask}</b>がターンを終えようとしています。${me === E.ch && isPlayer() ? 'あなた' : chn}は、エンド前にやることはありますか？</div><div class="ebtn">${body}</div></div>`;
}
function render() {
  if (!B.S) { renderLobby(); return; }
  regTokens(B.S);
  VS = B.role === 'host' ? viewFor(0) : B.S;
  turnBanner(VS);
  const me = mySeat(), op = 1 - me, S = VS;
  const st = root.querySelector('.blog')?.scrollTop, atBottom = (() => { const l = root.querySelector('.blog'); return !l || l.scrollTop + l.clientHeight >= l.scrollHeight - 4; })();
  const chatVal = $('bChatIn')?.value || '', chatFocus = document.activeElement?.id === 'bChatIn';
  const nVal = $('bN')?.value || '1';
  const roleTxt = B.role === 'host' ? '対戦者（部屋の管理役）' : B.role === 'player' ? '対戦者' : '観戦者';
  const mySh = new Set(B.priv && B.priv.show || []), myPt = (S.seats[me].sh || {}).pt;
  const showing = B.priv && mySh.size && S.seats[me].su;
  let ctl = '';
  if (isPlayer()) {
    if (!B.priv) {
      const opts = decks.slice().sort((a, b) => b.updated - a.updated).map(d => `<option value="${d.id}" ${d.id === curId ? 'selected' : ''}>${esc(d.name)}（${Object.values(d.cards).reduce((a, b) => a + b, 0)}枚）</option>`).join('');
      ctl = `<span>デッキ</span><select id="bDeck">${opts}</select><button id="bReady" class="primary">このデッキで準備（本国を切る）</button>`;
    } else if (!S.seats[me].su) {
      ctl = `<button id="bStart" class="primary">ゲームスタート（${HAND0}枚引く）</button><span class="note">相手の準備を待たずに引いて大丈夫です</span>`;
    } else if (S.seats[me].su === 'mull') {
      const n = mullN(S.seats[me].mull);
      ctl = `<b>最初の手札</b><button id="bReveal">手札を公開</button><button id="bMull" ${n < 1 ? 'disabled' : ''}>引き直す（${n}枚）</button><button id="bKeep" class="primary">この手札で始める</button>
        <span class="note">Gがない時は公開して1度だけ${HAND0}枚で引き直せます。さらに引き直すと1枚ずつ減ります</span>`;
    } else {
      const mine = S.active === me;
      ctl = (S.active == null ? `<button id="bFirst" class="primary">自分が先攻</button><button id="bFirstR">先攻をランダムで決める</button>`
          : '') + `
        <input type="number" id="bN" min="1" max="50" value="${esc(nVal)}" title="枚数"><span>枚を</span>
        <button id="bDraw">引く</button><button id="bMill" title="戦闘ダメージ・資源など">本国→捨て山</button><button id="bBanish" title="本国の上から枚数ぶんを表向きで除外へ">本国→除外</button><button id="bHeal" title="回復：捨て山の上から枚数ぶんを、裏向きのまま1枚ずつ本国の上へ">回復</button><button id="bLook" title="サーチ：上から見て選び、残りを上か下へ好きな順で戻す">上から見る</button>
        ${B.priv.look?.length ? `<button id="bLookOpen" class="primary">見ているカード（${B.priv.look.length}）</button>` : ''}
        ${B.priv.fx && B.priv.fx.t !== 'brief' ? `<button id="bFxOpen" class="primary">『${esc(B.priv.fx.src)}』の続き</button>` : ''}
        <span class="sep"></span>
        <button id="bShuffle">本国を切る</button><button id="bSearch">本国を全部見る</button><button id="bReroll">全リロール</button><button id="bRandH" title="手札から枚数ぶんを無作為に選びます（無作為に廃棄する効果など）。選んだ後にどこへ移すか決めます">手札から無作為に</button>${showing ? '<button id="bShowOff2">手札の公開を終える</button>' : '<button id="bShowAll" title="公開を終えるまで、相手と観戦に手札が見えます（あとで引いたカードは見せません）">手札を公開</button>'}`;
    }
  } else ctl = `<span class="note">観戦中です。カードに乗せると右に大きく出ます。</span>`;

  const pw = B.priv && S.seats[me].su ? gPower(me) : null;
  // 手札は扇状（手に持っている形）：真ん中から離れるほど傾けて下げる。--i は真ん中からの位置
  // 端のカードの傾きは枚数で増やし、最大 ±14度。下がる量は端で カードの高さの 8%（--t2）
  const hn = B.priv ? B.priv.hand.length : 0, half = (hn - 1) / 2, fanMax = Math.min(14, half * 3.5);
  const myHand = B.priv ? B.priv.hand.map((c, i) => {
    const t = half ? (i - half) / half : 0;
    let h = slot(c, 'hand').replace('<div class="slot', `<div style="--a:${(t * fanMax).toFixed(2)}deg;--t2:${(t * t).toFixed(3)};--z:${i + 1}" class="slot`);
    if (pw && canPay(BY_ID.get(c.id), pw, B.priv.deck.length)) h = h.replace('class="slot', 'title="今の国力で出せます" class="slot ok');
    return mySh.has(c.u) ? h.replace('class="slot', `class="slot shown${myPt === c.u ? ' pt' : ''}`) : h;
  }).join('') : '';
  root.innerHTML = `
  <div class="bboard">
    ${phaseBar(S, me)}
    <div class="bmain">
    ${B.lost ? `<div class="bbanner">部屋の管理役との接続が切れました。<button id="bRejoin">入り直す</button></div>` : ''}
    <div class="btop">${seatStrip(op, false)}${sideZones(op, true)}</div>
    ${shownRow(op)}
    ${rowHtml2(op)}
    <div class="bmid">
      <div class="bfield bg-space">${zoneHtml(op, 'space')}${zoneHtml(me, 'space')}</div>
      <div class="bring2"><div class="rp">${zoneHtml(op, 'discard')}${deckPile(op)}</div><div class="rp">${deckPile(me)}${zoneHtml(me, 'discard')}</div></div>
      <div class="bfield bg-ring">${zoneHtml(op, 'ring')}${zoneHtml(me, 'ring')}</div>
      <div class="bfield bg-earth">${zoneHtml(op, 'earth')}${zoneHtml(me, 'earth')}</div>
    </div>
    ${B.role === 'spect' ? rowHtml2(me) + `<div class="btop">${seatStrip(me, true)}${sideZones(me, true)}</div>` + shownRow(me) : ''}
    ${B.role !== 'spect' ? `<div class="bme${VS.active === me ? ' active' : ''}">${gZoneHtml(me)}<div class="piles">${zoneHtml(me, 'junk')}${zoneHtml(me, 'removed')}</div>${zoneHtml(me, 'deploy', 'dep')}<div class="bhand"><div class="zone hz" data-seat="${me}" data-zone="hand"><div class="zl"><b>${esc(S.seats[me].name)}</b>${S.active === me ? ' <span style="color:var(--accent)">● あなたのターン</span>' : ''}　<span class="znm"><i class="zen">HAND</i>手札<span class="zcnt">${B.priv ? B.priv.hand.length : 0}</span></span>${showing ? `<span class="shnote">● ${mySh.size}枚を公開中</span><button id="bShowOff" class="mini">公開を終える</button>` : '※自分にだけ見えます'}</div><div class="zc fan" style="--n:${Math.max(hn, 1)}">${myHand}</div></div></div>${sideZones(me, false)}</div>` : ''}
    <div class="bctl">${ctl}</div>
    ${shownOverlay(B.role === 'spect' ? [op, me] : [op])}
    ${castOverlay()}
    ${pickOverlay()}
    ${sentOverlay()}
    ${endOverlay()}
    </div>
  </div>
  <div class="bside">
    <div class="binfo">
      <div>部屋コード <span class="roomcode" id="bCodeCopy" title="クリックでコピー">${esc(B.code)}</span></div>
      <div>${esc(B.name)}：${roleTxt}　観戦 ${S.spect.length}人${S.spect.length ? `（${esc(S.spect.join('、'))}）` : ''}</div>
      <div class="hostbtn"><button id="bReload" class="ghost mini" title="卓を読み込み直します（画面がおかしい時・新しい版にする時）。同じ部屋・同じ席にそのまま入り直します">再読み込み</button><button id="bSe" class="ghost mini" title="ドローの効果音">音 ${seOn() ? 'ON' : 'OFF'}</button></div>
      ${B.role === 'host' ? `<div class="hostbtn"><button id="bRec" class="ghost mini" title="操作の記録をファイルに保存（将来の再生用）">記録を保存</button><button id="bNew" class="ghost mini">新しいゲーム</button></div>` : ''}
    </div>
    <div class="bprev" id="bPrev"><div class="note" style="align-self:center">カードに乗せると大きく出ます</div></div>
    <div class="blog" id="bLog">${S.log.map(l => `<div class="${l.c}">${esc(l.m)}</div>`).join('')}</div>
    <div class="bchat"><input id="bChatIn" placeholder="ひとこと（全員に見えます）" maxlength="200"><button id="bChatGo">送る</button></div>
  </div>`;
  const lg = $('bLog'); lg.scrollTop = atBottom ? lg.scrollHeight : st;
  $('bChatIn').value = chatVal; if (chatFocus) $('bChatIn').focus();
  if (B.prev) showPrev(B.prev.cid, B.prev.u);
  wire();
  if (dlg.open && B.pileView) { const pl = dlg.querySelector('.plist'), sc = pl && pl.scrollTop; openPile(B.pileView.seat, B.pileView.z); const p2 = dlg.querySelector('.plist'); if (p2) p2.scrollTop = sc || 0; }
  checkReveal(S);
  syncShow();
  markSwap();
}

// ---------------------------------------------------------------------
//  操作（ボタン・クリックメニュー・ドラッグ）
// ---------------------------------------------------------------------
function N() { return Math.max(1, Math.min(50, +($('bN')?.value) || 1)); }
function wire() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('bReady', () => { const d = decks.find(x => x.id === $('bDeck').value); if (d) startWithDeck(d); });
  on('bStart', () => { const n = draw(HAND0); render(); act({ t: 'start', n }); });
  on('bMull', () => {
    const n = mullN(VS.seats[mySeat()].mull); if (n < 1) return;
    B.priv.deck.push(...B.priv.hand); B.priv.hand = []; shuffle(B.priv.deck);
    const got = draw(n); render(); act({ t: 'mull', n: got });
  });
  on('bKeep', () => act({ t: 'keep', n: B.priv.hand.length }));
  on('bReveal', () => act({ t: 'reveal', ids: B.priv.hand.map(c => c.id), what: '手札' }));
  on('bShowAll', () => { if (!B.priv.hand.length) return toast('手札がありません'); setShow(B.priv.hand.map(c => c.u), true); });
  on('bShowOff', () => setShow([], false));
  on('bShowOff2', () => setShow([], false));
  on('bFirst', () => act({ t: 'first' }));
  on('bFirstR', () => act({ t: 'first', random: true }));
  on('bNext', () => nextPhase());
  on('bEnd', () => act({ t: 'endTurn' }));
  on('bLookOpen', () => openLook());
  on('bSe', () => { store.set('se', seOn() ? '0' : '1'); render(); if (seOn()) drawSE(1); });
  on('bReload', () => {
    if (B.role === 'host' && B.conns.length && !(B.rlAsk && Date.now() - B.rlAsk < 5000)) { B.rlAsk = Date.now(); toast('あなたは部屋の管理役です。読み込み直す間、相手と観戦の人も一度切れます（相手は「入り直す」で戻れます）。もう一度押すと読み込み直します'); return; }
    try { sessionStorage.setItem('gw.rejoin', JSON.stringify({ role: B.role, code: B.code, name: B.name, t: Date.now() })); } catch (e) {}
    location.reload();
  });
  on('bFxOpen', () => openFx());
  on('bDraw', () => { const n = draw(N()); render(); act({ t: 'note', msg: `${n}枚引きました` }); });
  on('bMill', () => {
    if (!online()) return toast('つながっていません');
    const got = B.priv.deck.splice(0, N()); savePriv();
    if (got.length) act({ t: 'enter', cards: got, zone: 'discard', src: 'deck' });
  });
  on('bBanish', () => {
    if (!online()) return toast('つながっていません');
    const got = B.priv.deck.splice(0, N()); savePriv();
    if (!got.length) return toast('本国がありません');
    act({ t: 'enter', cards: got, zone: 'removed', src: 'deck' });
  });
  on('bRandH', e => randomHand(N(), e));
  on('bHeal', () => {
    if (!online()) return toast('つながっていません');
    if (!VS.seats[mySeat()].z.discard.length) return toast('捨て山がありません');
    act({ t: 'precover', n: N(), heal: true });
  });
  on('bLook', () => {
    const got = B.priv.deck.splice(0, N()); if (!got.length) return toast('本国がありません');
    B.priv.look = (B.priv.look || []).concat(got); savePriv();
    act({ t: 'note', msg: `本国の上から${got.length}枚を見ています` }); openLook();
  });
  on('bSearch', () => { act({ t: 'note', msg: '本国を全部見ました' }); openDeckView(0); });
  on('bShuffle', () => { shuffle(B.priv.deck); savePriv(); act({ t: 'note', msg: '本国を切りました' }); });
  on('bReroll', () => act({ t: 'rerollAll' }));
  on('bNew', () => {
    const b = $('bNew');
    if (!b.dataset.arm) { b.dataset.arm = 1; b.textContent = 'もう一度押すと盤面を消します'; setTimeout(() => { if (b.isConnected) { delete b.dataset.arm; b.textContent = '新しいゲーム'; } }, 3000); return; }
    B.priv = null; savePriv(); act({ t: 'newGame' });
  });
  on('bRejoin', () => { const code = B.code, role = B.role === 'spect' ? 'spect' : 'player'; B.S = null; B.hostConn = null; render(); $('bCode').value = code; joinRoom(role); });
  on('bRec', () => {
    const blob = new Blob([JSON.stringify({ code: B.code, seats: B.S.seats.map(s => s.name), rec: B.rec }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `gw-record-${B.code}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`; a.click();
  });
  on('bCodeCopy', async () => { try { await navigator.clipboard.writeText(B.code); toast('部屋コードをコピーしました'); } catch (e) {} });
  const sendChat = () => { const v = $('bChatIn').value.trim(); if (!v) return; $('bChatIn').value = ''; act({ t: 'chat', msg: v }); };
  on('bChatGo', sendChat);
  $('bChatIn').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) sendChat(); };
}
// 右の大きい表示。場のセットグループに乗せた時は、グループの全部と合計を出す
function prevHtml(cid, u) {
  const f = u && VS && findCard(VS, u), g = f && (f.parent || f.c);
  if (g && (g.s || []).length) {
    const list = [g, ...g.s].filter(x => x.id && BY_ID.has(x.id)), tot = g.f ? null : groupStats(g);
    if (list.length) return `<div class="grp"><div class="gh">セットグループ ${g.s.length + 1}枚${tot ? `　合計 <b>[${esc(tot.join(']['))}]</b>` : ''}</div>${list.map(x => cardFace(BY_ID.get(x.id), { v: x === g && g.v && !g.f })).join('')}</div>`;
  }
  const c = BY_ID.get(cid); if (!c) return null;
  const tm = f && f.c.tm, st = f && !f.c.f && groupStats(f.c);
  return (tm || st ? `<div class="grp"><div class="gh">${tm ? `<b class="tmt">${esc(tmTitle(tm))}</b>　` : ''}${st ? `今の数字 <b>[${esc(st.join(']['))}]</b>` : ''}</div>` : '') + cardFace(c, { v: !!(f && f.c.v && !f.c.f) }) + (tm || st ? '</div>' : '');
}
function showPrev(cid, u) {
  const el = $('bPrev'); if (!el) return;
  const h = prevHtml(cid, u); if (h == null) return;
  B.prev = { cid, u }; el.innerHTML = h;
}
// 「詳しく見る」：画面いっぱいに大きく出す。どこかを押すか Esc で戻る
const zoomEl = document.createElement('div'); zoomEl.className = 'bzoom';
let zoomAt = null;   // 詳しく見るで出しているカード（Ctrl+V で画像を入れる先）
function zoomCard(cid, u) {
  const h = prevHtml(cid, u); if (h == null) return;
  zoomAt = { cid, u };
  const host = document.querySelector('dialog[open]') || document.body; if (zoomEl.parentNode !== host) host.appendChild(zoomEl);
  zoomEl.innerHTML = `<div class="zin">${h}</div><div class="zhint">押すか Esc で戻ります　／　Ctrl+V でコピーした画像をこのカードの画像にします</div>`;
  zoomEl.classList.add('on');
  const zin = zoomEl.firstChild, w = zin.offsetWidth, hh = zin.offsetHeight;
  zin.style.zoom = Math.max(1, Math.min((innerWidth * .96) / w, (innerHeight * .92) / hh)).toFixed(3);
}
function zoomClose() { zoomEl.classList.remove('on'); zoomEl.innerHTML = ''; zoomAt = null; }
// 対戦中のカードに画像を入れる（デッキ構築のカード詳細と同じ置き場。カード番号 id ごと）
async function battleSetImage(cid, blob) {
  const c = BY_ID.get(cid); if (!c || !blob) return;
  await setImageFor(cid, blob);
  if (B.S) render();
  if (zoomAt && zoomAt.cid === cid) zoomCard(zoomAt.cid, zoomAt.u);
  if (B.prev && B.prev.cid === cid) showPrev(B.prev.cid, B.prev.u);
}
async function battlePasteImage(cid) {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('read なし');
    for (const it of await navigator.clipboard.read()) {
      const ty = it.types.find(t => t.startsWith('image/'));
      if (ty) { await battleSetImage(cid, await it.getType(ty)); return; }
    }
    toast('クリップボードに画像がありません（画像を右クリック→「画像をコピー」してから）');
  } catch (err) { toast('このブラウザでは読めませんでした。「詳しく見る」を開いて Ctrl+V で貼ってください'); }
}
const imgPick = document.createElement('input'); imgPick.type = 'file'; imgPick.accept = 'image/*'; imgPick.style.display = 'none';
document.body.appendChild(imgPick);
function battlePickImage(cid) {
  imgPick.onchange = () => { const f = imgPick.files[0]; imgPick.value = ''; if (f) battleSetImage(cid, f); };
  imgPick.click();
}
document.addEventListener('paste', e => {
  if (!zoomAt || !zoomEl.classList.contains('on')) return;
  const it = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (!it) { toast('クリップボードに画像がありません'); return; }
  e.preventDefault(); battleSetImage(zoomAt.cid, it.getAsFile());
});
zoomEl.onclick = zoomClose;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && zoomEl.classList.contains('on')) { e.preventDefault(); e.stopPropagation(); zoomClose(); } }, true);
root.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-u],[data-cid]'); if (!t) return;
  if (t.dataset.src === 'pub' && t.dataset.u) showPrev(t.dataset.cid, t.dataset.u);
  else if (t.dataset.cid) showPrev(t.dataset.cid);
});

// クリックメニュー
const ctx = document.createElement('div'); ctx.id = 'bctx'; document.body.appendChild(ctx);
function menu(x, y, title, items, zoom) {
  if (zoom && zoom.cid && BY_ID.has(zoom.cid)) items = [['詳しく見る', () => zoomCard(zoom.cid, zoom.u)], ...items.length ? ['-'] : [], ...items,
    '-', ['画像を貼る（コピーした画像）', () => battlePasteImage(zoom.cid)], ['画像をファイルから選ぶ…', () => battlePickImage(zoom.cid)]];
  const host = document.querySelector('dialog[open]') || document.body; if (ctx.parentNode !== host) host.appendChild(ctx);
  ctx.innerHTML = `<div class="hd">${esc(title)}</div>` + items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}">${esc(it[0])}</button>`).join('');
  ctx.classList.add('on');
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.min(x + 10, innerWidth - w - 8) + 'px'; ctx.style.top = Math.max(8, Math.min(y + 10, innerHeight - h - 8)) + 'px';  // 少しずらす（ダブルクリックの2回目がメニューに当たらないように）
  ctx.onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; ctx.classList.remove('on'); items[+b.dataset.i][1](); };
}
document.addEventListener('mousedown', e => { if (!ctx.contains(e.target)) ctx.classList.remove('on'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') ctx.classList.remove('on'); });

function coinPick(x, y, title, fn, tok) {
  menu(x, y, title, [...tok ? [['トークン（ユニット・キャラ）を出す…', tok], '-'] : [], ...COINS.map(n => [n, () => fn(n)]), ['ほかの名前…', () => { const n = (prompt('コインの名前（例：暴走コイン）', '') || '').trim(); if (n) fn(/コイン$/.test(n) ? n : n + 'コイン'); }]]);
}
function coinMenu(f, x, y) {
  const c = f.c, u = c.u;
  menu(x, y, `${c.coin} ×${c.n}（${zoneLabel(f.seat, f.zone)}）`, [
    ['1枚足す', () => act({ t: 'coin', u, d: 1 })],
    ['1枚減らす', () => act({ t: 'coin', u, d: -1 })], '-',
    ...['deploy', 'space', 'earth', 'ring', 'G'].filter(z => z !== f.zone).map(z => [`${ZONES[z]}へ`, () => act({ t: 'move', u, seat: f.seat, zone: z })]),
    ...BATTLE.includes(f.zone) || f.zone === 'deploy' ? [['左へ（前へ）', () => act({ t: 'zorder', u, d: -1 })], ['右へ（後ろへ）', () => act({ t: 'zorder', u, d: 1 })]] : [], '-',
    ['取り除く', () => act({ t: 'leave', u, to: 'hand' })]
  ]);
}
function pubMenu(u, x, y) {
  const f = findCard(VS, u); if (!f) return;
  if (f.c.coin) return coinMenu(f, x, y);
  const c = f.c, owner = c.o, mine = owner === B.seat;
  const cn = Object.entries(c.cn || {});
  const vx = !c.f && variN(BY_ID.get(c.id));
  const items = [
    [c.r ? 'リロール（縦に）' : 'ロール（横に）', () => act({ t: 'roll', u })],
    ...vx && !f.parent ? [[c.vb ? 'ヴァリアブルをやめる（普通の向き・G扱いをやめる）' : `ヴァリアブル(${vx})：配備エリアへ逆向きで出す（${BY_ID.get(c.id).c}の特殊G）`, () => act({ t: 'vari', u })]] : [],
    ...((BY_ID.get(c.id) || {}).alt && !c.f ? [[c.v ? '元の形態に戻す' : `変形（${BY_ID.get(c.id).alt.name || '変形形態'}）`, () => act({ t: 'transform', u })]] : []),
    [c.f ? '表にする' : '裏にする', () => act({ t: 'flip', u })], '-',
    ...MOVE_TO.filter(z => !(z === f.zone && f.seat === owner && !f.parent)).map(z => [`${ZONES[z]}へ`, () => act({ t: 'move', u, seat: owner, zone: z })]),
    '-',
    ['持ち主の手札へ', () => act({ t: 'leave', u, to: 'hand' })],
    ['持ち主の本国の上へ', () => act({ t: 'leave', u, to: 'top' })],
    ['持ち主の本国の下へ', () => act({ t: 'leave', u, to: 'bottom' })]
  ];
  if (f.parent) items.unshift([`セットを外す（${ZONES[f.zone]}に置く）`, () => act({ t: 'move', u, seat: f.seat, zone: f.zone })]);
  // セットしているカードを1枚ずつ動かす（そのカードだけのメニューを開く）
  if (!f.parent && (c.s || []).length) items.push('-', ...c.s.map(sc => [`セット中の『${sc.f && !sc.id ? '裏向きのカード' : cname(sc)}』だけ動かす…`, () => pubMenu(sc.u, x, y)]));
  // 文面にトークン（〇〇コイン{UNIT、…}）があるカード
  const tts = !c.f ? tokTemplates(BY_ID.get(c.id), cname(c)) : [];
  if (tts.length && isPlayer()) items.push('-', ...tts.map(d => [`トークン『${d.n}』（${d.st.join('/')}）を出す…`, () => openTok({ def: d, zone: BATTLE.includes(f.zone) ? f.zone : 'deploy' })]));
  if (!f.parent && f.arr.length > 1 && (BATTLE.includes(f.zone) || f.zone === 'deploy')) {
    const order = [];
    if (f.i > 0) order.push([`左へ（前へ）${BATTLE.includes(f.zone) && f.i === 1 ? '：先頭にする' : ''}`, () => act({ t: 'zorder', u, d: -1 })]);
    if (f.i < f.arr.length - 1) order.push(['右へ（後ろへ）', () => act({ t: 'zorder', u, d: 1 })]);
    items.splice(items.indexOf('-'), 0, ...order);
  }
  // 貯めG：手札のユニットとコマンド以外を表にして本国の下へ、このカードの上にコイン1個（ロールもする）
  if (!c.f && mine && owner === B.seat && fxOf(c.id).tame && B.priv) {
    const ok = B.priv.hand.filter(h => { const hx = BY_ID.get(h.id); return hx && !UNIT_T.includes(hx.t) && hx.t !== 'C'; });
    items.unshift(['貯める（手札1枚を本国の下へ・コイン+1）…', () => {
      if (!ok.length) return menu(x, y, '貯められる手札がありません（ユニットとコマンド以外）', [['閉じる', () => {}]]);
      menu(x, y, `『${cname(c)}』に貯める手札（表にして本国の下へ）`, ok.map(h => [cname(h), () => {
        B.priv.deck.push(takeFromHand(h.u)); savePriv();
        if (!c.r) act({ t: 'roll', u });
        act({ t: 'coin', u, name: 'コイン', d: 1 });
        act({ t: 'sent', ids: [h.id], src: cname(c), to: '本国の下', msg: `『${cname(h)}』を表にして本国の下に移し、『${cname(c)}』にコインを1個乗せました（貯めG：${(BY_ID.get(c.id).gp || [BY_ID.get(c.id).c])[0]}国力${coinCount(c) + 2}）` });
        render();
      }]), { cid: c.id });
    }], '-');
  }
  const coinItems = [['コインを乗せる…', () => coinPick(x, y, `『${cname(c)}』に乗せるコイン`, n => act({ t: 'coin', u, name: n, d: 1 }))]];
  for (const [k, n] of cn) coinItems.push([`${k}（${n}枚）を1枚足す`, () => act({ t: 'coin', u, name: k, d: 1 })], [`${k}を1枚取る`, () => act({ t: 'coin', u, name: k, d: -1 })], [`${k}を外して場に置く`, () => act({ t: 'coinOff', u, name: k })]);
  items.push('-', ...coinItems);
  items.push('-', [`一時修正（+1/+0/-1・※）…${c.tm ? `　今：${tmLabel(c.tm)}` : ''}`, () => openTm(u)]);
  if (c.tm) items.push(['一時修正を消す', () => act({ t: 'tmod', u })]);
  menu(x, y, cname(c) + (mine ? '' : `（${B.S.seats[owner].name}のカード）`), items, { cid: c.id, u });
}
function handMenu(u, x, y, title, first) {
  const c = B.priv.hand.find(c => c.u === u); if (!c) return;
  const x0 = BY_ID.get(c.id), isCmd = x0 && x0.t === 'C';
  menu(x, y, title || cname(c), [
    ...first ? [...first, '-'] : [],
    ...isCmd ? [[castLabel(x0), () => castFromHand(u)], '-'] : [],
    ...variN(BY_ID.get(c.id)) ? [[`ヴァリアブル(${variN(BY_ID.get(c.id))})：配備エリアへ逆向きで出す（${BY_ID.get(c.id).c}の特殊G・Gのプレイ）`, () => playFromHand(u, 'deploy', { vb: true })], '-'] : [],
    ...['deploy', 'G', 'space', 'earth', 'hangar'].map(z => [`${ZONES[z]}へ出す`, () => playFromHand(u, z)]),
    ...x0 && x0.t === 'U' ? [['換装：場の自軍ユニットと入れ替える…', () => startSwap(u)]] : [],
    ['裏向きで配備エリアへ', () => playFromHand(u, 'deploy', { f: true })],
    ...(B.priv.show || []).includes(u)
      ? [['このカードの公開をやめる', () => setShow(B.priv.show.filter(x => x !== u), false)]]
      : [['このカードを公開する（公開したまま）', () => setShow([...(B.priv.show || []), u], false)],
         ['このカードを1度だけ見せる', () => act({ t: 'reveal', ids: [c.id], what: '手札のカード' })]],
    ...(B.priv.show || []).length ? [['手札の公開を全部終える', () => setShow([], false)]] : [], '-',
    ...['discard', 'junk', 'removed'].map(z => [`${ZONES[z]}へ`, () => playFromHand(u, z)]), '-',
    ['本国の上に戻す', () => { B.priv.deck.unshift(takeFromHand(u)); savePriv(); render(); act({ t: 'note', msg: '手札を1枚本国の上に戻しました' }); }],
    ['本国の下に戻す', () => { B.priv.deck.push(takeFromHand(u)); savePriv(); render(); act({ t: 'note', msg: '手札を1枚本国の下に戻しました' }); }]
  ], { cid: c.id, u });
}
// 換装（2026-11-21）：手札のユニットを選んでから、場の自軍ユニットを押して入れ替える。換装できるか（名称・タイミング・1ターン1回）は人が判断
let swapU = null;
const swapOk = f => f && !f.parent && !f.c.coin && f.seat === mySeat() && SWAP_Z.includes(f.zone);
function startSwap(u) {
  const c = B.priv && B.priv.hand.find(c => c.u === u); if (!c) return;
  const n = VS.seats[mySeat()] ? SWAP_Z.reduce((k, z) => k + VS.seats[mySeat()].z[z].filter(x => !x.coin).length, 0) : 0;
  if (!n) return toast('換装できる場の自軍ユニットがありません（配備エリア・戦闘エリア宇宙/地球）');
  swapU = u; render();
}
function endSwap() { if (swapU) { swapU = null; render(); } }
function swapPick(t, x, y) {   // 換装先（場のユニット）を押した
  const c = B.priv && B.priv.hand.find(c => c.u === swapU), f = VS && findCard(VS, t);
  if (!c) return endSwap();
  if (!swapOk(f)) return toast('配備エリアか戦闘エリア（宇宙・地球）の自軍ユニットを押してください（Esc でやめる）');
  const go = rr => {
    if (!online()) return toast('つながっていません');
    const h = takeFromHand(swapU); swapU = null; if (!h) return render();
    savePriv(); render(); act({ t: 'swap', cards: [h], u: t, rr });
  };
  const tn = f.c.f && !f.c.id ? '裏向きのカード' : cname(f.c);
  menu(x, y, `換装：手札の『${cname(c)}』⇄ 場の『${tn}』`, [
    [`入れ替える${f.c.r ? '（ロール状態のまま）' : ''}`, () => go(false)],
    ...f.c.r ? [['入れ替えてリロールする', () => go(true)]] : [],
    ['別のユニットを選ぶ', () => {}],
    ['換装をやめる', endSwap]
  ], { cid: f.c.id, u: t });
}
function markSwap() {
  const on = !!(swapU && B.priv && B.priv.hand.some(c => c.u === swapU)); if (!on) swapU = null;
  root.classList.toggle('swapping', on);
  let bar = document.getElementById('swapBar');
  if (!on) { if (bar) bar.remove(); return; }
  root.querySelectorAll('.slot[data-src="pub"][data-u]').forEach(el => { if (swapOk(findCard(VS, el.dataset.u))) el.classList.add('swapok'); });
  root.querySelectorAll('.slot[data-src="hand"][data-u]').forEach(el => { if (el.dataset.u === swapU) el.classList.add('swapsrc'); });
  if (!bar) { bar = document.createElement('div'); bar.id = 'swapBar'; document.body.appendChild(bar); }
  const c = B.priv.hand.find(c => c.u === swapU);
  bar.innerHTML = `換装：手札の『${esc(cname(c))}』と入れ替える場の自軍ユニットを押してください <button id="swapNo">やめる（Esc）</button>`;
  bar.querySelector('#swapNo').onclick = endSwap;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && swapU && !ctx.classList.contains('on')) endSwap(); }, true);
// 手札から無作為に n 枚選ぶ（無作為に廃棄する効果など）。選んだことを先に記録に出してから、移す先を決める
function randomHand(n, e) {
  if (!B.priv || !online()) return toast('つながっていません');
  const hand = B.priv.hand.slice(); if (!hand.length) return toast('手札がありません');
  const rnd = k => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % k; };
  for (let i = hand.length - 1; i > 0; i--) { const j = rnd(i + 1); [hand[i], hand[j]] = [hand[j], hand[i]]; }
  const got = hand.slice(0, Math.min(n, hand.length)), us = got.map(c => c.u);
  act({ t: 'note', msg: `手札${B.priv.hand.length}枚から無作為に${got.length}枚選びました` });
  const r = e && e.target && e.target.getBoundingClientRect ? e.target.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2 };
  const x = r.left, y = r.top - 10;
  const send = (zone, label) => {
    if (!online()) return toast('つながっていません');
    const cards = us.map(takeFromHand).filter(Boolean); if (!cards.length) return;
    savePriv(); render(); act({ t: 'enter', cards, zone, src: 'hand' });
  };
  const items = [
    [`${ZONES.junk}へ（廃棄）`, () => send('junk')],
    [`${ZONES.discard}へ`, () => send('discard')],
    [`${ZONES.removed}へ`, () => send('removed')], '-',
    ['公開する（公開したまま）', () => setShow([...new Set([...(B.priv.show || []), ...us])], false)],
    ['本国の下に戻す', () => { us.map(takeFromHand).filter(Boolean).forEach(c => B.priv.deck.push(c)); savePriv(); render(); act({ t: 'note', msg: `無作為に選んだ手札${us.length}枚を本国の下に戻しました` }); }],
    ['手札に残す（選んだだけ）', () => {}]
  ];
  if (got.length === 1) return handMenu(got[0].u, x, y, `無作為に選んだ手札：『${cname(got[0])}』`, items);
  menu(x, y, `無作為に選んだ手札${got.length}枚：${got.map(c => `『${cname(c)}』`).join('')}`, items);
}
function deckCardMenu(u, x, y, after) {
  const c = B.priv.deck.find(c => c.u === u); if (!c) return;
  const done = () => { savePriv(); render(); after(); };
  menu(x, y, cname(c), [
    ['手札に加える', () => { B.priv.hand.push(takeFromDeck(u)); done(); act({ t: 'note', msg: '本国から1枚手札に加えました' }); }],
    ...['deploy', 'G', 'hangar', 'discard', 'junk', 'removed'].map(z => [`${ZONES[z]}へ出す`, () => { playFromDeck(u, z); after(); }]), '-',
    ['一番上へ', () => { B.priv.deck.unshift(takeFromDeck(u)); done(); }],
    ['一番下へ', () => { B.priv.deck.push(takeFromDeck(u)); done(); act({ t: 'note', msg: '本国の1枚を一番下にしました' }); }]
  ], { cid: c.id, u });
}

// 一時修正の窓
const tmDlg = document.createElement('dialog'); tmDlg.id = 'tmDlg'; document.body.appendChild(tmDlg);
function openTm(u) {
  const f = findCard(VS, u); if (!f) return;
  const tm = f.c.tm || { d: [0, 0, 0], s: false, m: '', k: false }, d = tm.d.slice();
  const LB = ['格闘', '射撃', '耐久'], PRE = [[1, 1, 1], [-1, -1, -1], [2, 2, 2], [-2, -2, -2], [1, 0, 0], [0, 1, 0], [0, 0, 1], [3, 0, 0]];
  tmDlg.innerHTML = `<h3>一時修正：『${esc(cname(f.c))}』</h3>
    <p class="note">コマンドや能力で一時的に変わった分を書いておく所です。カードと部隊戦闘力の数字に足します。ターン終了で自動で消えます（コインは消えません）。</p>
    <div class="tmrow">${LB.map((l, i) => `<div class="tmst"><span>${l}</span><button data-a="${i}" data-v="-1">−</button><b id="tmv${i}"></b><button data-a="${i}" data-v="1">＋</button></div>`).join('')}</div>
    <div class="tmpre"><span class="note">足す：</span>${PRE.map((p, i) => `<button class="mini" data-p="${i}">${fmtMod(p)}</button>`).join('')}<button class="mini ghost" data-p="z">0に戻す</button></div>
    <div class="tmm"><label><input type="checkbox" id="tmS"> ※を付ける</label><input id="tmM" maxlength="60" placeholder="※のメモ（例：強襲を得る、この戦闘中は破壊されない）"></div>
    <label class="note"><input type="checkbox" id="tmK"> ターン終了で消さない（長く続く効果の時）</label>
    <div class="row"><span id="tmNow" class="note" style="margin-right:auto"></span>${f.c.tm ? '<button id="tmDel" class="ghost">消す</button>' : ''}<button id="tmNo" class="ghost">やめる</button><button id="tmOk" class="primary">決定</button></div>`;
  const q = s => tmDlg.querySelector(s);
  q('#tmS').checked = !!tm.s; q('#tmM').value = tm.m || ''; q('#tmK').checked = !!tm.k;
  const show = () => {
    d.forEach((v, i) => q('#tmv' + i).textContent = (v >= 0 ? '+' : '') + v);
    const st = cardStats({ ...f.c, tm: { d } });
    q('#tmNow').textContent = st ? `修正後 [${st.join('][')}]` : '';
  };
  q('#tmM').oninput = () => { if (q('#tmM').value.trim()) q('#tmS').checked = true; };
  tmDlg.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.a) { d[+b.dataset.a] += +b.dataset.v; show(); return; }
    if (b.dataset.p) { if (b.dataset.p === 'z') d.fill(0); else PRE[+b.dataset.p].forEach((v, i) => d[i] += v); show(); return; }
    if (b.id === 'tmNo') tmDlg.close();
    if (b.id === 'tmDel') { tmDlg.close(); act({ t: 'tmod', u }); }
    if (b.id === 'tmOk') { tmDlg.close(); act({ t: 'tmod', u, d, s: q('#tmS').checked, m: q('#tmM').value, k: q('#tmK').checked }); }
  };
  show(); tmDlg.showModal();
}

// トークンの窓：呼び名・名称・特徴・地形・格闘/射撃/耐久・テキスト・画像を決めて出す
const tkDlg = document.createElement('dialog'); tkDlg.id = 'tkDlg'; document.body.appendChild(tkDlg);
const TK_STORE = 'tokens';   // 前に出したトークン（このブラウザ）
const TK_PRESET = [{ n: 'ボルジャーノンコイン', nm: 'ボルジャーノン', t: 'U', c: '無', tr: ['ボルジャーノン系'], tg: ['宇宙', '地球'], st: ['2', '0', '2'], x: [] }];
function tokPresets() {
  const seen = new Set(), out = [];
  const add = d => { const c = cleanTok(d); if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); } };
  // 場・コマンド・ハンガーにあるカードの文面から
  if (VS) VS.seats.forEach(st => Object.entries(st.z).forEach(([z, arr]) => { if (z !== 'discard') arr.forEach(c => [c, ...(c.s || [])].forEach(x => !x.tk && x.id && tokTemplates(BY_ID.get(x.id), cname(x)).forEach(add))); }));
  Object.values((VS && VS.tk) || {}).forEach(add);
  (store.get(TK_STORE, []) || []).forEach(add);
  TK_PRESET.forEach(add);
  return out.slice(0, 24);
}
function openTok(o = {}) {
  if (!isPlayer()) return;
  let d = cleanTok(o.def || TK_PRESET[0]), blob = null;
  const zones = ['deploy', ...BATTLE];
  const pre = tokPresets();
  tkDlg.innerHTML = `<h3>トークン（コイン）を出す</h3>
    <p class="note">効果で出るユニット（例：機械人形部隊のボルジャーノンコイン {UNIT、「名称:ボルジャーノン」、「特徴:ボルジャーノン系」、地形適性「宇宙」「地球」、2/0/2}）を、カードと同じように場に出します。ロール・セット・コイン・一時修正・部隊戦闘力も普通のカードと同じです。場を離れる（捨て山・手札などへ動かす）と消えます。</p>
    ${pre.length ? `<div class="tkpre"><span class="note">選ぶ：</span>${pre.map((p, i) => `<button class="mini" data-pre="${i}" title="${esc(p.x.join(' '))}">${esc(p.n)} ${esc(p.st.join('/'))}</button>`).join('')}</div>` : ''}
    <div class="tkrow"><label>文面から読む<input id="tkTxt" placeholder="〇〇コイン{UNIT、「名称:〇〇」、地形適性「宇宙」「地球」、2/0/2} を貼る"></label><button id="tkRead" class="mini">読む</button></div>
    <div class="tkform">
      <div class="tkimg" id="tkImg" title="この画面で Ctrl+V でも画像を貼れます"></div>
      <div class="tkf">
        <label>呼び名<input id="tkN" maxlength="30"></label>
        <label>名称<input id="tkNm" maxlength="30" placeholder="（なければ空）"></label>
        <label>種類<select id="tkT"><option value="U">ユニット</option><option value="CH">キャラクター</option></select></label>
        <label>色<select id="tkC">${TK_COLORS.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label>特徴<input id="tkTr" maxlength="60" placeholder="ボルジャーノン系（空白か、で区切る）"></label>
        <div class="tkchk">地形適性 <label><input type="checkbox" id="tkS">宇宙</label><label><input type="checkbox" id="tkE">地球</label></div>
        <div class="tkchk">格闘 <input id="tk0" class="n" maxlength="4"> 射撃 <input id="tk1" class="n" maxlength="4"> 耐久 <input id="tk2" class="n" maxlength="4"></div>
        <label>テキスト<textarea id="tkX" rows="2" maxlength="400" placeholder="（あれば。1行ずつ）"></textarea></label>
        <div class="tkchk"><button id="tkPick" class="mini">画像を選ぶ</button><button id="tkPaste" class="mini">クリップボードから貼る</button><span class="note" id="tkImgNote"></span></div>
      </div>
    </div>
    <div class="tkchk">出す所 <select id="tkZ">${zones.map(z => `<option value="${z}">${ZONES[z]}</option>`).join('')}</select>
      位置 <input id="tkAt" class="n" placeholder="後ろ" title="左から何番目に入れるか（空なら一番後ろ。戦闘エリアは左が先頭）">番目
      <input id="tkCnt" class="n" value="1">個　<label><input type="checkbox" id="tkR">ロール状態で</label></div>
    <div class="row"><button id="tkNo" class="ghost">やめる</button><button id="tkOk" class="primary">出す</button></div>
    <input type="file" id="tkFile" accept="image/*" hidden>`;
  const q = sel => tkDlg.querySelector(sel);
  const fill = x => {
    q('#tkN').value = x.n; q('#tkNm').value = x.nm || ''; q('#tkT').value = x.t; q('#tkC').value = x.c;
    q('#tkTr').value = (x.tr || []).join(' '); q('#tkS').checked = (x.tg || []).includes('宇宙'); q('#tkE').checked = (x.tg || []).includes('地球');
    x.st.forEach((v, i) => q('#tk' + i).value = v); q('#tkX').value = (x.x || []).filter(l => !/^名称：/.test(l)).join('\n');
    blob = null; showImg();
  };
  const read = () => cleanTok({ n: q('#tkN').value, nm: q('#tkNm').value, t: q('#tkT').value, c: q('#tkC').value, tr: q('#tkTr').value,
    tg: [q('#tkS').checked && '宇宙', q('#tkE').checked && '地球'].filter(Boolean), st: [0, 1, 2].map(i => q('#tk' + i).value), x: q('#tkX').value });
  const showImg = () => {
    const cur = read(), u = blob ? URL.createObjectURL(blob) : cur && Images.url(cur);
    q('#tkImg').innerHTML = u ? `<img src="${esc(u)}" alt="">` : '<span>画像なし</span>';
    q('#tkImgNote').textContent = blob ? '出す時にこの画像を入れます' + (Images.shareOn ? '（みんなの画像）' : '') : u ? 'このトークンの画像があります' : '';
  };
  fill(d);
  q('#tkZ').value = zones.includes(o.zone) ? o.zone : 'deploy';
  tkDlg.oninput = e => { if (['tkN', 'tk0', 'tk1', 'tk2'].includes(e.target.id) && !blob) showImg(); };
  const setBlob = b => { if (b) { blob = b; showImg(); } };
  q('#tkFile').onchange = e => { setBlob(e.target.files[0]); e.target.value = ''; };
  tkDlg.onpaste = e => {
    const it = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (it) { e.preventDefault(); setBlob(it.getAsFile()); }
  };
  tkDlg.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pre) { fill(pre[+b.dataset.pre]); return; }
    if (b.id === 'tkRead') { const t = tokTemplates({ x: [q('#tkTxt').value] }); if (t.length) fill(cleanTok(t[0])); else toast('{UNIT、…、2/0/2} の形が見つかりませんでした'); return; }
    if (b.id === 'tkPick') { q('#tkFile').click(); return; }
    if (b.id === 'tkPaste') {
      try { for (const it of await navigator.clipboard.read()) { const ty = it.types.find(t => t.startsWith('image/')); if (ty) { setBlob(await it.getType(ty)); return; } } toast('クリップボードに画像がありません'); }
      catch (err) { toast('このブラウザでは読めませんでした。この画面で Ctrl+V を押して貼ってください'); }
      return;
    }
    if (b.id === 'tkNo') { tkDlg.close(); return; }
    if (b.id === 'tkOk') {
      const def = read(); if (!def) { toast('呼び名を入れてください'); return; }
      tkDlg.close();
      act({ t: 'token', def, zone: q('#tkZ').value, n: +q('#tkCnt').value || 1, at: +q('#tkAt').value || 0, r: q('#tkR').checked, onto: o.onto });
      const list = (store.get(TK_STORE, []) || []).filter(x => x && tkId(cleanTok(x) || { n: '', st: [] }) !== def.id);
      store.set(TK_STORE, [def, ...list].slice(0, 20));
      if (blob) try {   // 画像はトークンの id ごと（カード詳細と同じ置き場）
        if (Images.shareOn) await Images.putShared(def.id, await shrink(blob, 600, 0.8)); else await Images.put(def.id, await shrink(blob));
        render(); toast('トークンの画像を入れました');
      } catch (err) { toast(err.message || '画像を入れられませんでした'); }
    }
  };
  tkDlg.showModal();
}

// 本国・捨て札置き場の一覧
const dlg = document.createElement('dialog'); dlg.id = 'pileDlg'; document.body.appendChild(dlg);
function openList(title, note, cards, onCard, extra = '', under = null, onBtn = null, idx = i => i + 1) {
  dlg.innerHTML = `<h3>${esc(title)}</h3><p class="note">${esc(note)}</p>
    <div class="plist">${cards.map((c, i) => `<div><div class="idx">${idx(i)}</div>${slot(c, 'list').replace(/draggable="true"/g, 'draggable="false"')}${under ? under(c, i) : ''}</div>`).join('') || '<div class="note">（なし）</div>'}</div>
    <div class="row">${extra}<button id="pClose" class="primary">閉じる</button></div>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('#pClose').onclick = () => dlg.close();
  dlg.querySelector('.plist').onclick = e => {
    const b = e.target.closest('button[data-b]'); if (b) { onBtn && onBtn(b.dataset.b, b.dataset.u); return; }
    const s = e.target.closest('[data-u]'); if (s) onCard(s.dataset.u, e.clientX, e.clientY);
  };
  dlg.querySelector('.plist').onmouseover = e => { const t = e.target.closest('[data-cid]'); if (t) showPrev(t.dataset.cid); };
}
let deckViewN = 0;
function openDeckView(n) {
  deckViewN = n; B.pileView = null;
  const cards = n ? B.priv.deck.slice(0, n) : B.priv.deck;
  openList(n ? `本国の上${cards.length}枚` : `本国（${cards.length}枚）`, '左が一番上です。カードを押すと動かせます。中身はあなたにしか見えません。', cards,
    (u, x, y) => deckCardMenu(u, x, y, () => openDeckView(deckViewN)),
    n ? '' : '<button id="pShuf" style="margin-right:auto">切ってから閉じる</button>');
  const s = dlg.querySelector('#pShuf');
  if (s) s.onclick = () => { shuffle(B.priv.deck); savePriv(); act({ t: 'note', msg: '本国を切りました' }); dlg.close(); };
}
function openPile(seat, z) {
  B.pileView = { seat, z };
  const st = VS.seats[seat], arr = st.z[z];
  // 自分の捨て山を見ている時：見ているカードだけ並べ、並べ替えと手札へのボタンを付ける
  if (z === 'discard' && seat === mySeat() && isPlayer() && st.pk) {
    const cards = arr.filter(c => c.id), hidden = arr.length - cards.length;
    const under = c => { const i = arr.indexOf(c); return `<div class="lk"><button data-b="down" data-u="${esc(c.u)}" ${i ? '' : 'disabled'} title="1枚下へ">◀</button><button data-b="hand" data-u="${esc(c.u)}">手札へ</button><button data-b="up" data-u="${esc(c.u)}" ${i < arr.length - 1 ? '' : 'disabled'} title="1枚上へ">▶</button></div>`; };
    openList(`${zoneLabel(seat, z)}（${arr.length}枚）を見ています`,
      `中身はあなたにだけ見えています（相手と観戦の人には見えません）。右が一番上です。◀ ▶ で並べ替え、カードを押すと手札や場へ動かせます。残りは下のボタンでまとめて捨て山の下などへ送れます。${hidden ? `この下にまだ${hidden}枚あります（見ていません）。` : ''}閉じると見るのをやめます。`,
      cards, (u, x, y) => discardCardMenu(u, x, y),
      `<div class="pbulk"><span class="note">見ている${cards.length}枚を今の並びのまま：</span><button id="pDBot" title="サラサ再臨・月のマウンテンサイクルなどの「残りを捨て山の下に戻す」">捨て山の下へ</button><button id="pDTop" title="上に戻す（並べ替えた順で）">捨て山の上へ</button><button id="pHTop">本国の上へ</button><button id="pHBot">本国の下へ</button></div><button id="pShufD" style="margin-right:auto">切ってから閉じる</button>`, under,
      (b, u) => b === 'hand' ? act({ t: 'leave', u, to: 'hand' }) : act({ t: 'preorder', u, d: b === 'up' ? 1 : -1 }),
      i => `上から${arr.length - arr.indexOf(cards[i])}`);
    // 見ているカードをまとめて（今の並びのまま。us は捨て山の上から順）
    const us = () => cards.slice().reverse().map(c => c.u);
    dlg.querySelector('#pDBot').onclick = () => act({ t: 'pmove', us: us(), to: 'dbottom' });
    dlg.querySelector('#pDTop').onclick = () => act({ t: 'pmove', us: us(), to: 'dtop' });
    dlg.querySelector('#pHTop').onclick = () => act({ t: 'pmove', us: us(), to: 'top' });
    dlg.querySelector('#pHBot').onclick = () => act({ t: 'pmove', us: us(), to: 'bottom' });
    dlg.querySelector('#pShufD').onclick = () => { act({ t: 'pshuffle', zone: 'discard' }); dlg.close(); };
    return;
  }
  const note = (SECRET.includes(z) ? '非公開の置き場なので、中身は見えません。' + (seat === mySeat() && isPlayer() ? '自分の捨て山は、束を押して「見る」を選ぶと中身を見られます。' : '') : '') + '右が一番上です。' + (isPlayer() ? 'カードを押すと動かせます。' : '');
  openList(`${zoneLabel(seat, z)}（${arr.length}枚）`, note, arr, isPlayer() ? (u, x, y) => { pubMenu(u, x, y); } : () => {});
}
// 閉じたら捨て山を見るのをやめる
dlg.addEventListener('close', () => {
  const pv = B.pileView; B.pileView = null;
  if (pv && pv.z === 'discard' && pv.seat === mySeat() && isPlayer() && VS && VS.seats[pv.seat].pk) act({ t: 'dpeek', off: true });
});
// 自分の捨て山の束を押した時
function discardPileMenu(x, y) {
  const me = mySeat(), arr = VS.seats[me].z.discard, n = N();
  const look = k => { act({ t: 'dpeek', n: k }); openPile(me, 'discard'); };
  menu(x, y, `捨て山（${arr.length}枚）`, [
    ['上の1枚を手札へ（ドロー）', () => act({ t: 'pdraw', n: 1 })],
    ...(n > 1 ? [[`上から${n}枚を手札へ`, () => act({ t: 'pdraw', n })]] : []),
    '-',
    [`${n}回復（上から${n}枚を本国の上へ）`, () => act({ t: 'precover', n, heal: true })],
    [`上から${n}枚を本国の上へ戻す`, () => act({ t: 'precover', n, to: 'top' })],
    [`上から${n}枚を本国の下へ戻す`, () => act({ t: 'precover', n, to: 'bottom' })],
    [`上から${n}枚を捨て山の下へ送る（見ないで）`, () => act({ t: 'pmove', n, to: 'dbottom' })],
    '-',
    ['上の1枚を見る', () => look(1)],
    ...(n > 1 ? [[`上から${n}枚を見る`, () => look(n)]] : []),
    ['全部見る（並べ替え・取り出し）', () => look(0)],
    ['切る', () => act({ t: 'pshuffle', zone: 'discard' })],
    '-',
    ['見ないで一覧を開く', () => openPile(me, 'discard')]
  ]);
}
// 見ている捨て山のカードを押した時
function discardCardMenu(u, x, y) {
  const f = findCard(VS, u); if (!f) return;
  const c = f.c;
  menu(x, y, cname(c), [
    ['手札に加える', () => act({ t: 'leave', u, to: 'hand' })],
    ...(c.id ? [['公開して手札に加える', () => { act({ t: 'reveal', ids: [c.id], what: '捨て山から手札に加えるカード' }); act({ t: 'leave', u, to: 'hand' }); }]] : []),
    ['本国の上へ', () => act({ t: 'leave', u, to: 'top' })],
    ['本国の下へ', () => act({ t: 'leave', u, to: 'bottom' })],
    '-',
    ...['deploy', 'G', 'hangar', 'space', 'earth', 'junk', 'removed'].map(z => [`${ZONES[z]}へ出す`, () => act({ t: 'move', u, seat: c.o, zone: z })]),
    '-',
    ['捨て山の一番上へ', () => act({ t: 'preorder', u, to: 'top' })],
    ['捨て山の一番下へ', () => act({ t: 'preorder', u, to: 'bottom' })]
  ], { cid: c.id, u });
}

// 最初の手札の枚数：1回目の引き直しまでは6枚、その後は1枚ずつ減る（m＝引き直した回数）
const mullN = m => (m || 0) === 0 ? HAND0 : Math.max(0, HAND0 - m);
// 次のフェイズへ。ドローフェイズに入る時は1枚引く（先攻の1ターン目は引かない）
function nextPhase() {
  const S = VS, p = S.phase + 1;
  if (p >= PHASES.length) return;
  if (p === 1) {
    const drew = S.turn === 1 && S.active === S.first ? 0 : draw(1);
    render(); act({ t: 'phase', p, drew });
  } else act({ t: 'phase', p });
}

// サーチ：本国の上から抜き出して見ているカード（B.priv.look。左が上から1枚目）
const lookDlg = document.createElement('dialog'); lookDlg.id = 'lookDlg'; lookDlg.className = 'pdlg'; document.body.appendChild(lookDlg);
function openLook() {
  const L = B.priv?.look || [];
  if (!L.length) { if (lookDlg.open) lookDlg.close(); render(); return; }
  lookDlg.innerHTML = `<h3>見ているカード（${L.length}枚）</h3>
    <p class="note">本国の上から抜き出したカードです（左が上から1枚目）。カードを押すと手札や場へ動かせます。◀ ▶ で並べ替えてから、残りをまとめて本国へ戻してください。中身はあなたにしか見えません。</p>
    <div class="plist">${L.map((c, i) => `<div><div class="idx">${i + 1}</div>${slot(c, 'look').replace(/draggable="true"/g, 'draggable="false"')}
      <div class="lk"><button data-mv="${i}" data-d="-1" ${i ? '' : 'disabled'}>◀</button><button data-hand="${esc(c.u)}">手札へ</button><button data-mv="${i}" data-d="1" ${i < L.length - 1 ? '' : 'disabled'}>▶</button></div></div>`).join('')}</div>
    <div class="row"><button id="lTop">残りを本国の上へ（左が一番上）</button><button id="lBot" class="primary">残りを本国の下へ（右が一番下）</button><button id="lClose" class="ghost" style="margin-left:auto">いったん閉じる</button></div>`;
  if (!lookDlg.open) lookDlg.showModal();
  const back = top => {
    const n = L.length;
    if (top) B.priv.deck.unshift(...L); else B.priv.deck.push(...L);
    B.priv.look = []; savePriv(); lookDlg.close();
    act({ t: 'note', msg: `見ていた残り${n}枚を本国の${top ? '上' : '下'}に好きな順で置きました` });
  };
  lookDlg.querySelector('#lTop').onclick = () => back(true);
  lookDlg.querySelector('#lBot').onclick = () => back(false);
  lookDlg.querySelector('#lClose').onclick = () => { lookDlg.close(); render(); };
  lookDlg.querySelector('.plist').onclick = e => {
    const mv = e.target.closest('[data-mv]'), hd = e.target.closest('[data-hand]');
    if (mv) { const i = +mv.dataset.mv, j = i + +mv.dataset.d; [L[i], L[j]] = [L[j], L[i]]; savePriv(); openLook(); return; }
    if (hd) { B.priv.hand.push(takeFromLook(hd.dataset.hand)); savePriv(); act({ t: 'note', msg: '見ているカードから1枚を手札に加えました' }); openLook(); return; }
    const sl = e.target.closest('[data-u]'); if (sl) lookMenu(sl.dataset.u, e.clientX, e.clientY);
  };
  lookDlg.querySelector('.plist').onmouseover = e => { const t = e.target.closest('[data-cid]'); if (t) showPrev(t.dataset.cid); };
}
function lookMenu(u, x, y) {
  const c = (B.priv.look || []).find(c => c.u === u); if (!c) return;
  const after = () => openLook();
  menu(x, y, cname(c), [
    ['手札に加える', () => { B.priv.hand.push(takeFromLook(u)); savePriv(); act({ t: 'note', msg: '見ているカードから1枚を手札に加えました' }); after(); }],
    ['公開して手札に加える', () => { B.priv.hand.push(takeFromLook(u)); savePriv(); act({ t: 'reveal', ids: [c.id], what: '手札に加えるカード' }); after(); }],
    ...['deploy', 'G', 'hangar', 'junk', 'discard', 'removed'].map(z => [`${ZONES[z]}へ出す`, () => { playFromLook(u, z); after(); }]), '-',
    ['これだけ本国の上へ', () => { B.priv.deck.unshift(takeFromLook(u)); savePriv(); act({ t: 'note', msg: '見ているカードを1枚本国の上に置きました' }); after(); }],
    ['これだけ本国の下へ', () => { B.priv.deck.push(takeFromLook(u)); savePriv(); act({ t: 'note', msg: '見ているカードを1枚本国の下に置きました' }); after(); }]
  ], { cid: c.id, u });
}

// ---------------------------------------------------------------------
//  よく使うコマンドの自動解決（AUTO_FX、2026-11-16 試し版）
//  管理役：autoHost（捨て山は盤面にあるのでその場で）。本国・手札が要る物は sendFx で効果を動かす人のブラウザへ → handleFx
// ---------------------------------------------------------------------
function autoHost(fx, c, seat) {
  const S = B.S, src = cname(c);
  if (fx.k === 'pdraw2') {   // 宝物没収：捨て山の上2枚を手札へ
    const st = S.seats[c.o], arr = st.z.discard, n = Math.min(2, arr.length);
    if (!n) { log(`『${src}』：捨て山がないので引けませんでした`); return; }
    const got = arr.splice(arr.length - n, n).reverse();
    if (st.pk && st.pk !== 'all') st.pk = st.pk.filter(u => !got.some(x => x.u === u));
    got.forEach(x => sendGain(x.o, { u: x.u, id: x.id }, 'hand'));
    log(`『${src}』：捨て山の上から${n}枚を手札に加えました${n < 2 ? '（捨て山が1枚だけでした）' : ''}`);
    return;
  }
  sendFx(seat, { t: fx.k === 'draw2' ? 'draw' : fx.k, n: 2, src });
}
// 効果を動かす人のブラウザで
function handleFx(m) {
  if (!B.priv || !m) return;
  const P = B.priv;
  if (P.fx && P.fx.cards && m.t !== 'briefDone' && m.t !== 'draw') { P.deck.unshift(...P.fx.cards); P.fx = null; }   // やりかけの物は本国の上へ戻してから
  if (m.t === 'draw') { const n = draw(m.n); render(); act({ t: 'note', msg: `『${m.src}』の効果でカードを${n}枚引きました` }); return; }
  if (m.t === 'sarasa') {
    const cards = P.deck.splice(0, 5);
    if (!cards.length) { savePriv(); act({ t: 'note', msg: `『${m.src}』：本国がないので何も起きませんでした` }); return; }
    P.fx = { t: 'sarasa', src: m.src, cards, sel: null }; savePriv();
    act({ t: 'note', msg: `『${m.src}』：本国の上から${cards.length}枚を見ています` });
    openFx(); return;
  }
  if (m.t === 'brief') {
    const cards = P.deck.splice(0, 3);
    P.fx = cards.length ? { t: 'brief', src: m.src, cards } : null; savePriv();
    act({ t: 'fxShow', cards, src: m.src, n: 2 }); return;
  }
  if (m.t === 'briefDone') {
    const F = P.fx; if (!F || F.t !== 'brief') return;
    const us = new Set(m.us || []), pick = F.cards.filter(c => us.has(c.u)), rest = F.cards.filter(c => !us.has(c.u));
    P.hand.push(...pick); P.deck.unshift(...rest); P.fx = null; savePriv(); render();
    act({ t: 'note', msg: pick.length ? `『${F.src}』：選ばれた${pick.length}枚を手札に加えました${rest.length ? `（残り${rest.length}枚は本国の上）` : ''}` : `『${F.src}』：表にした${rest.length}枚を本国の上に戻しました` });
    return;
  }
  if (m.t === 'destroy') { P.fx = { t: 'destroy', src: m.src, sel: null }; savePriv(); render(); openFx(); }
}
// 黒い覇道の対象：場の表向きのカードのうち、G・ユニット（ACE・ヴァリアブルも）とコイン以外。セットしているキャラも1枚ずつ
const FIELD_Z = ['deploy', 'space', 'earth', 'ring', 'hangar', 'G'];
function destroyTargets() {
  const out = [];
  VS.seats.forEach((st, si) => FIELD_Z.forEach(z => (st.z[z] || []).forEach(c => [c, ...(c.s || [])].forEach(x => {
    const k = !x.coin && !x.f && x.id && BY_ID.get(x.id);
    if (k && !['G', 'U', 'A'].includes(k.t) && !x.vb) out.push({ c: x, si, z });
  }))));
  return out;
}
const fxDlg = document.createElement('dialog'); fxDlg.id = 'fxDlg'; fxDlg.className = 'pdlg'; document.body.appendChild(fxDlg);
function openFx() {
  const F = B.priv && B.priv.fx;
  if (!F || F.t === 'brief') { if (fxDlg.open) fxDlg.close(); render(); return; }
  const card = (c, i, extra = '') => `<div class="${F.sel === c.u ? 'fxsel' : ''}" data-fx="${esc(c.u)}">${slot(c, 'list').replace(/draggable="(true|false)"/g, 'draggable="false"')}${extra}</div>`;
  let body, ok;
  if (F.t === 'sarasa') {
    const L = F.cards;
    body = `<p class="note">本国の上から${L.length}枚です（左が上から1枚目）。手札に入れる1枚を押して選び、残りは ◀ ▶ で並べてください。残りは左から順に本国の下へ入ります（右端が一番下）。中身はあなたにしか見えません。</p>
      <div class="plist">${L.map((c, i) => card(c, i, `<div class="lk"><button data-mv="${i}" data-d="-1" ${i ? '' : 'disabled'}>◀</button><span class="idx">${F.sel === c.u ? '手札へ' : i + 1}</span><button data-mv="${i}" data-d="1" ${i < L.length - 1 ? '' : 'disabled'}>▶</button></div>`)).join('')}</div>`;
    ok = `<button id="fxOk" class="primary" ${F.sel ? '' : 'disabled'}>選んだ1枚を手札へ・残り${L.length - 1}枚を本国の下へ</button>`;
  } else {
    const T = destroyTargets(), me = mySeat();
    body = `<p class="note">Gとユニット以外の、場のカードです。破壊する1枚を押して選んでください（持ち主のジャンクヤードへ行きます）。</p>
      <div class="plist">${T.map(({ c, si, z }, i) => card(c, i, `<div class="idx">${si === me ? '自分' : '相手'}の${esc(ZONES[z])}</div>`)).join('') || '<div class="note">（対象になるカードがありません）</div>'}</div>`;
    ok = `<button id="fxOk" class="primary" ${F.sel && T.some(x => x.c.u === F.sel) ? '' : 'disabled'}>選んだカードを破壊する</button>`;
  }
  fxDlg.innerHTML = `<h3>『${esc(F.src)}』の効果</h3>${body}
    <div class="row">${ok}<button id="fxNo" class="ghost">効果をやめる${F.t === 'sarasa' ? '（本国の上へ戻す）' : ''}</button><button id="fxClose" class="ghost" style="margin-left:auto">いったん閉じる</button></div>`;
  if (!fxDlg.open) fxDlg.showModal();
  const done = msg => { B.priv.fx = null; savePriv(); fxDlg.close(); render(); if (msg) act({ t: 'note', msg }); };
  fxDlg.querySelector('#fxClose').onclick = () => { fxDlg.close(); render(); };
  fxDlg.querySelector('#fxNo').onclick = () => {
    if (F.t === 'sarasa') { B.priv.deck.unshift(...F.cards); done(`『${F.src}』の効果をやめました（見ていた${F.cards.length}枚は本国の上へ元の順で）`); }
    else done(`『${F.src}』の効果をやめました（対象なし）`);
  };
  fxDlg.querySelector('#fxOk').onclick = () => {
    if (F.t === 'sarasa') {
      const pick = F.cards.find(c => c.u === F.sel); if (!pick) return;
      const rest = F.cards.filter(c => c !== pick);
      B.priv.hand.push(pick); B.priv.deck.push(...rest);
      done(`『${F.src}』：1枚を手札に加え、残り${rest.length}枚を好きな順で本国の下に置きました`);
    } else {
      const t = destroyTargets().find(x => x.c.u === F.sel); if (!t) { openFx(); return; }
      act({ t: 'note', msg: `『${F.src}』で『${cname(t.c)}』を破壊しました` });
      act({ t: 'move', u: t.c.u, seat: t.c.o ?? t.si, zone: 'junk' });
      done();
    }
  };
  fxDlg.querySelector('.plist').onclick = e => {
    const mv = e.target.closest('[data-mv]');
    if (mv) { const L = F.cards, i = +mv.dataset.mv, j = i + +mv.dataset.d; [L[i], L[j]] = [L[j], L[i]]; savePriv(); openFx(); return; }
    const f = e.target.closest('[data-fx]'); if (f) { F.sel = F.sel === f.dataset.fx ? null : f.dataset.fx; savePriv(); openFx(); }
  };
  fxDlg.querySelector('.plist').onmouseover = e => { const t = e.target.closest('[data-cid]'); if (t) showPrev(t.dataset.cid); };
}
// ブリーフィング：表にしたカードを盤の真ん中に。選ぶ人（相手）は押して選び「手札へ」
let pickSel = new Set(), pickK = '';
function pickOverlay() {
  const P = VS.pick; if (!P) { pickK = ''; return ''; }
  if (P.k !== pickK) { pickK = P.k; pickSel = new Set(); }
  const me = mySeat(), chooser = isPlayer() && me === P.ch, owner = esc(VS.seats[P.seat].name || '持ち主'), chn = esc(VS.seats[P.ch].name || '相手');
  const cards = P.cards.map(c => `<div class="citem${pickSel.has(c.u) ? ' fxsel' : ''}" ${chooser ? `data-pk="${esc(c.u)}"` : ''}>${slot(c, 'pub').replace(/draggable="(true|false)"/, 'draggable="false"').replace('data-src="pub"', 'data-src="cast"')}${chooser ? `<div class="cbtn"><span class="mini">${pickSel.has(c.u) ? '✓ 手札へ' : '押して選ぶ'}</span></div>` : ''}</div>`).join('');
  const btn = chooser ? `<button class="primary mini" data-pk="!ok" ${pickSel.size === P.n ? '' : 'disabled'}>この${P.n}枚を${owner}の手札へ</button>` : `<span class="shr">${chn}が選んでいます</span>`;
  const cancel = isPlayer() && (me === P.seat || me === P.ch) ? `<button class="mini" data-pk="!no" title="間違えた時など。表にしたカードは本国の上へ戻ります">取りやめ</button>` : '';
  return `<div class="bcast bpick" style="--n:${P.cards.length}"><div class="shh"><span class="hudtag">${esc(P.src)}</span>${owner}の本国の上${P.cards.length}枚<span class="shr">${chooser ? `手札に移す${P.n}枚を選んでください（あなたが選びます）` : `${chn}が${P.n}枚を選んで${owner}の手札へ`}</span>${btn}${cancel}</div><div class="zc">${cards}</div></div>`;
}
function pickClick(k) {
  const P = VS.pick; if (!P || !isPlayer()) return;
  if (k === '!no') { act({ t: 'fxPick', cancel: 1 }); return; }
  if (mySeat() !== P.ch) return;
  if (k === '!ok') { if (pickSel.size === P.n) act({ t: 'fxPick', us: [...pickSel] }); return; }
  if (pickSel.has(k)) pickSel.delete(k); else if (pickSel.size < P.n) pickSel.add(k);
  render();
}

// 公開されたカード（手札の公開など）を、公開した本人以外に出す
const revDlg = document.createElement('dialog'); revDlg.id = 'revDlg'; revDlg.className = 'pdlg'; document.body.appendChild(revDlg);
function checkReveal(S) {
  const rv = S.reveal;
  if (B.seenReveal === undefined) { B.seenReveal = rv ? rv.k : null; return; }   // 入った時に前の公開は出さない
  if (!rv || rv.k === B.seenReveal) return;
  B.seenReveal = rv.k;
  if (rv.seat === B.seat && isPlayer()) return;
  revDlg.innerHTML = `<h3>${esc(rv.name)}が${esc(rv.what)}を公開しました（${rv.ids.length}枚）</h3>
    <div class="plist">${rv.ids.map(id => `<div>${slot({ u: 'rv' + id, id }, 'list').replace(/draggable="(true|false)"/g, 'draggable="false"')}<div class="idx">${esc(cname({ id }))}</div></div>`).join('') || '<div class="note">（なし）</div>'}</div>
    <div class="row"><button class="primary" id="rvClose">閉じる</button></div>`;
  revDlg.querySelector('#rvClose').onclick = () => revDlg.close();
  revDlg.querySelector('.plist').onmouseover = e => { const t = e.target.closest('[data-cid]'); if (t) showPrev(t.dataset.cid); };
  if (!revDlg.open) revDlg.showModal();
}

// 盤面のクリック
root.addEventListener('click', e => {
  if (!B.S || ctx.contains(e.target)) return;
  if (swapU) {   // 換装の相手選び中：場のユニットを押すと入れ替えのメニュー、ほかを押すとやめる
    const t = e.target.closest('.slot[data-src="pub"][data-u]');
    if (t) { swapPick(t.dataset.u, e.clientX, e.clientY); return; }
    if (e.target.closest('[data-src="hand"][data-u]')) { endSwap(); return; }
  }
  // カードの左上（「詳細」の印）を押すと、メニューを出さずに「詳しく見る」。右の大きい表示を押しても同じ
  const ptb = e.target.closest('[data-ptbtn]');
  if (ptb) { if (isPlayer()) act({ t: 'point', seat: +ptb.dataset.seat, u: ptb.dataset.ptbtn }); return; }
  const mc = e.target.closest('.slot[data-cid]:not([data-src="shown"]) > .mc:not(.back)');
  if (mc) {
    const r = mc.getBoundingClientRect(), sl = mc.parentNode;
    if (e.clientX - r.left < r.width * .5 && e.clientY - r.top < r.height * .25 && !sl.classList.contains('r')) { zoomCard(sl.dataset.cid, sl.dataset.src === 'pub' ? sl.dataset.u : undefined); return; }
  }
  if (e.target.closest('#bPrev') && B.prev) { zoomCard(B.prev.cid, B.prev.u); return; }
  const sok = e.target.closest('[data-sentok]');
  if (sok) { sentSeen = sok.dataset.sentok; render(); return; }
  const ea = e.target.closest('[data-endans]');
  if (ea) {
    const k = ea.dataset.endans;
    if (k === 'force') act({ t: 'endTurn', force: true });
    else act({ t: 'endAns', ok: k === 'ok', wait: k === 'wait', cancel: k === 'cancel' });
    return;
  }
  const ctg = e.target.closest('[data-casttog]');
  if (ctg) { castMin = !castMin; render(); return; }
  const rsv = e.target.closest('[data-resolve]');
  if (rsv) { if (isPlayer()) act({ t: 'resolve', u: rsv.dataset.resolve, how: rsv.dataset.how, ds: rsv.dataset.ds != null ? +rsv.dataset.ds : undefined }); return; }
  const pk = e.target.closest('[data-pk]');
  if (pk) { pickClick(pk.dataset.pk); return; }
  const cbk = e.target.closest('[data-castback]');
  if (cbk) { if (isPlayer()) act({ t: 'leave', u: cbk.dataset.castback, to: 'hand' }); return; }
  const stg = e.target.closest('[data-shtog]');
  if (stg) { const k = stg.dataset.shtog; shMin[k] = !shMin[k]; render(); return; }
  const ph = e.target.closest('[data-ph]');
  if (ph) { act({ t: 'phase', p: +ph.dataset.ph }); return; }
  const pile = e.target.closest('[data-pile]');
  if (pile) {
    const seat = +pile.dataset.seat, z = pile.dataset.zone;
    if (z === 'discard' && seat === mySeat() && isPlayer()) discardPileMenu(e.clientX, e.clientY);
    else openPile(seat, z);
    return;
  }
  const deck = e.target.closest('[data-mydeck]');
  if (deck && B.priv) {
    menu(e.clientX, e.clientY, `本国（${B.priv.deck.length}枚）`, [
      ['1枚引く', () => { const n = draw(1); render(); act({ t: 'note', msg: `${n}枚引きました` }); }],
      ['上の1枚を見る', () => { act({ t: 'note', msg: '本国の上1枚を見ました' }); openDeckView(1); }],
      ['全部見る', () => { act({ t: 'note', msg: '本国を全部見ました' }); openDeckView(0); }],
      ['切る', () => { shuffle(B.priv.deck); savePriv(); act({ t: 'note', msg: '本国を切りました' }); }],
      ['上の1枚を捨て山へ', () => { const g = B.priv.deck.splice(0, 1); savePriv(); if (g.length) act({ t: 'enter', cards: g, zone: 'discard', src: 'deck' }); }],
      ['上の1枚を除外', () => { const g = B.priv.deck.splice(0, 1); savePriv(); if (g.length) act({ t: 'enter', cards: g, zone: 'removed', src: 'deck' }); }],
      ...N() > 1 ? [[`上から${N()}枚を除外`, () => { const g = B.priv.deck.splice(0, N()); savePriv(); if (g.length) act({ t: 'enter', cards: g, zone: 'removed', src: 'deck' }); }]] : []
    ]);
    return;
  }
  const tog = e.target.closest('[data-gtog]');
  if (tog) { const st = +tog.dataset.gtog; gOpen.has(st) ? gOpen.delete(st) : gOpen.add(st); render(); return; }
  if (!isPlayer()) {
    const v = e.target.closest('[data-cid]');
    if (v) menu(e.clientX, e.clientY, cname({ id: v.dataset.cid }), [], { cid: v.dataset.cid, u: v.dataset.src === 'pub' ? v.dataset.u : undefined });
    return;
  }
  const cz = e.target.closest('[data-coinzone]');
  if (cz) { const z = cz.dataset.coinzone; coinPick(e.clientX, e.clientY, `${ZONES[z]}に置くコイン`, n => act({ t: 'coinPut', zone: z, name: n, n: 1 }), () => openTok({ zone: z })); return; }
  const t = e.target.closest('[data-u]'); if (!t) return;
  if (t.dataset.gb) { gbMenu(+t.dataset.seat, t.dataset.gb, e.clientX, e.clientY); return; }
  if (t.dataset.src === 'shown') {
    const seat = +t.dataset.seat; if (seat === mySeat()) return;
    const sh = VS.seats[seat].sh, on = sh && sh.pt === t.dataset.u;
    menu(e.clientX, e.clientY, cname({ id: t.dataset.cid }) + `（${VS.seats[seat].name}の手札）`, [
      [on ? '指定を外す' : 'このカードを指定する（ハンデスなど）', () => act({ t: 'point', seat, u: t.dataset.u })]
    ], { cid: t.dataset.cid });
    return;
  }
  if (t.dataset.src === 'cast') { menu(e.clientX, e.clientY, cname({ id: t.dataset.cid }) + '（プレイ中）', [], { cid: t.dataset.cid }); return; }
  if (t.dataset.src === 'hand') handMenu(t.dataset.u, e.clientX, e.clientY);
  else if (t.dataset.src === 'pub') pubMenu(t.dataset.u, e.clientX, e.clientY);
});
root.addEventListener('dblclick', e => {
  if (!isPlayer()) return;
  const h = e.target.closest('[data-src="hand"][data-u]');
  if (h) { const c = B.priv && B.priv.hand.find(c => c.u === h.dataset.u), x = c && BY_ID.get(c.id); if (x && x.t === 'C') { ctx.classList.remove('on'); castFromHand(c.u); } return; }
  const t = e.target.closest('[data-src="pub"][data-u]'); if (t && !t.dataset.coin) { ctx.classList.remove('on'); act({ t: 'roll', u: t.dataset.u }); }
});

// ドラッグ
let drag = null;
root.addEventListener('dragstart', e => {
  const t = e.target.closest('[draggable="true"]'); if (!t || !isPlayer()) { e.preventDefault(); return; }
  drag = { src: t.dataset.src, u: t.dataset.u, coin: !!t.dataset.coin };
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'gw');
  e.stopPropagation();
});
root.addEventListener('dragend', () => { drag = null; root.querySelectorAll('.over,.drop').forEach(x => x.classList.remove('over', 'drop')); });
function dropTarget(e) {
  const card = e.target.closest('.zone:not([data-pile]):not([data-zone="hand"]) [data-src="pub"][data-u]:not([data-gb])');
  if (card && drag && card.dataset.u !== drag.u && (!card.dataset.coin || drag.coin)) return { onto: card.dataset.u, el: card.querySelector('.mc') || card };
  const z = e.target.closest('.zone[data-zone]');
  return z ? { seat: +z.dataset.seat, zone: z.dataset.zone, el: z } : null;
}
root.addEventListener('dragover', e => {
  if (!drag) return;
  const t = dropTarget(e); root.querySelectorAll('.over,.drop').forEach(x => x.classList.remove('over', 'drop'));
  if (!t) return;
  e.preventDefault(); t.el.classList.add(t.onto ? 'drop' : 'over');
});
root.addEventListener('drop', e => {
  if (!drag) return; e.preventDefault();
  const t = dropTarget(e), d = drag; drag = null;
  root.querySelectorAll('.over,.drop').forEach(x => x.classList.remove('over', 'drop'));
  if (!t) return;
  const me = mySeat();
  if (d.src === 'hand') {
    if (t.onto) return playFromHand(d.u, 'deploy', { onto: t.onto });
    if (t.zone === 'hand') return;
    if (t.zone === 'deck') { if (t.seat !== me) return; B.priv.deck.unshift(takeFromHand(d.u)); savePriv(); render(); act({ t: 'note', msg: '手札を1枚本国の上に戻しました' }); return; }
    return playFromHand(d.u, t.zone, { seat: t.seat });
  }
  if (d.src === 'decktop') {
    const top = B.priv.deck[0]; if (!top) return;
    if (t.zone === 'hand') { draw(1); render(); act({ t: 'note', msg: '1枚引きました' }); return; }
    if (t.zone === 'deck') return;
    return playFromDeck(top.u, t.zone || 'deploy', { seat: t.seat, onto: t.onto });
  }
  if (d.src === 'pub') {
    if (t.onto) return act({ t: 'move', u: d.u, onto: t.onto });
    if (t.zone === 'hand') return act({ t: 'leave', u: d.u, to: 'hand' });
    if (t.zone === 'deck') return act({ t: 'leave', u: d.u, to: 'top' });
    return act({ t: 'move', u: d.u, seat: t.seat, zone: t.zone });
  }
});

// 対戦タブを開いた時に描く
document.querySelector('nav.tabs button[data-view="battle"]').addEventListener('click', () => { if (!B.S) renderLobby(); else render(); });
renderLobby();
// 「再読み込み」の後：同じ部屋・同じ役でそのまま入り直す（管理役は「前の部屋を開き直す」と同じ）
(() => {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem('gw.rejoin')); sessionStorage.removeItem('gw.rejoin'); } catch (e) {}
  if (!r || Date.now() - r.t > 120e3 || !r.code) return;
  document.querySelector('nav.tabs button[data-view="battle"]').click();
  $('bName').value = r.name || B.name;
  if (r.role === 'host') {
    let saved = null; try { saved = JSON.parse(localStorage.getItem('gw.hostroom')); } catch (e) {}
    if (saved && saved.code === r.code) createRoom(saved);
  } else { $('bCode').value = r.code; joinRoom(r.role === 'spect' ? 'spect' : 'player'); }
})();
window.GWB = B; // 調べ物用
if (LOCAL) window.GWT = { playFrom, takeFromHand, draw, render, act, castFromHand, savePriv, playFromDeck, cname, vs: () => VS, priv: () => B.priv, turnBanner, resetTb: () => { turnSeen = "x"; } };   // 試験モードだけ：画面確認の道具から操作する用
window.addEventListener('gw-images', () => { if (B.S) render(); });   // みんなの画像が届いたら描き直す
})();

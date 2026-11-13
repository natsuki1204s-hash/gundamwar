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
const ZONES = { G: 'G', deploy: '配備エリア', space: '戦闘エリア（宇宙）', earth: '戦闘エリア（地球）', junk: 'ジャンクヤード', discard: '捨て山', removed: '除外' };
const PILES = ['junk', 'discard', 'removed'];
const SECRET = ['discard'];   // 中身が誰にも見えない置き場（捨て山は非公開。枚数だけ見える）
const PHASES = ['リロールフェイズ', 'ドローフェイズ', '配備フェイズ', '攻撃ステップ', '防御ステップ', 'ダメージ判定ステップ', '帰還ステップ', 'ターンエンド'];
const HAND0 = 6;              // 最初の手札
const MOVE_TO = ['deploy', 'space', 'earth', 'G', 'junk', 'discard', 'removed'];
const emptyZones = () => Object.fromEntries(Object.keys(ZONES).map(k => [k, []]));
const emptySeat = () => ({ name: '', online: false, ready: false, deckName: '', dn: 0, hn: 0, z: emptyZones() });
const rid = () => Math.random().toString(36).slice(2, 7);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cname = c => { if (c && c.coin) return c.coin; const x = c && c.id && BY_ID.get(c.id); return x ? x.n : '裏向きのカード'; };
// コイン：カードの上に乗せる物は c.cn = {名前: 枚数}。場に単独で置く物は置き場の中の {u, o, coin: 名前, n: 枚数}
const COINS = ['コイン', '+1/+1/+1コイン', '-1/-1/-1コイン', '+2/+2/+2コイン', '解体コイン', '汚染コイン'];
const COIN_ST = /^([+\-±]\d+)\/([+\-±]\d+)\/([+\-±]\d+)コイン$/;   // 戦闘力を変えるコイン（+1/+1/+1 など）
const coinShort = n => { const m = COIN_ST.exec(n); return m ? m[1] : n.replace(/コイン$/, '').slice(0, 3) || '●'; };
const BATTLE = ['space', 'earth'];
// 一時修正（コマンドや能力で一時的に変わった分）：c.tm = { d:[格闘,射撃,耐久], s:※を付けるか, m:メモ, k:ターン終了で消さない }
const fmtMod = d => d.map(v => (v >= 0 ? '+' : '') + v).join('/');
const tmLabel = tm => (tm.d.some(v => v) ? fmtMod(tm.d) : '') + (tm.s || tm.m ? '※' : '');
const tmTitle = tm => `一時修正${tm.d.some(v => v) ? ' ' + fmtMod(tm.d) : ''}${tm.m ? ' ※' + tm.m : tm.s ? ' ※' : ''}${tm.k ? '（ターン終了で消さない）' : '（ターン終了で消える）'}`;
const UNIT_T = ['U', 'A'];   // 部隊戦闘力に数える種類（ユニット・ACE）

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
function log(msg, cls = '') { const S = B.S; S.log.push({ m: msg, c: cls }); if (S.log.length > 300) S.log.splice(0, S.log.length - 300); }
const zoneLabel = (seat, z) => (B.S.seats[seat].name || `席${seat + 1}`) + 'の' + ZONES[z];

function apply(a, who) {
  if (a.t !== 'counts') { B.rec.push({ t: Date.now(), seat: who.seat, name: who.name, a: JSON.parse(JSON.stringify(a)) }); if (B.rec.length > 5000) B.rec.shift(); }
  const S = B.S, nm = who.name || '？';
  const seatObj = who.seat != null ? S.seats[who.seat] : null;
  if (a.t === 'chat') { log(`${nm}：${String(a.msg).slice(0, 200)}`, 'chat'); return; }
  if (!seatObj) return '観戦者は操作できません';
  if (a.dn != null) { seatObj.dn = a.dn; seatObj.hn = a.hn; }
  switch (a.t) {
    case 'counts': return;
    case 'note': log(`${nm}が${a.msg}`); return;
    case 'ready': seatObj.ready = true; seatObj.deckName = a.deckName || ''; log(`${nm}が「${seatObj.deckName}」で準備しました`, 'sys'); return;
    case 'enter': {   // 手札・本国から場へ
      const tz = S.seats[a.seat ?? who.seat]?.z[a.zone]; if (!tz) return;
      const cards = a.cards.map(c => ({ u: c.u, id: c.id, o: who.seat, r: false, f: !!a.f && !PILES.includes(a.zone), s: [] }));
      let onto = null;
      if (a.onto) { const t = findCard(S, a.onto); if (t && !t.c.coin) { onto = t.c; t.c.s.push(...cards); } else tz.push(...cards); }
      else tz.push(...cards);
      const from = a.src === 'deck' ? '本国の上から' : '手札から';
      const names = cards.length > 3 || SECRET.includes(a.zone) ? `${cards.length}枚` : cards.map(c => `『${c.f ? '裏向きのカード' : cname(c)}』`).join('');
      log(`${nm}が${from}${names}を${onto ? `『${cname(onto)}』にセット` : zoneLabel(a.seat ?? who.seat, a.zone) + 'へ'}`);
      return;
    }
    case 'move': {    // 場から場へ
      const f = findCard(S, a.u); if (!f) return;
      const tz = S.seats[a.seat]?.z[a.zone]; if (!tz && !a.onto) return;
      if (a.onto) { if (a.onto === a.u || (f.c.s || []).some(x => x.u === a.onto)) return; }
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
      f.arr.splice(f.i, 1);
      const card = f.c, subs = card.s || []; card.s = [];
      if (a.onto) {
        const t = findCard(S, a.onto); if (!t) { tz.push(card); return; }
        card.v = false; t.c.s.push(card, ...subs);
        log(`${nm}が『${cname(card)}』を『${cname(t.c)}』にセット`);
        return;
      }
      if (PILES.includes(a.zone)) {   // 捨て札置き場へは表向き・リロール状態で、セットしていたカードも一緒に
        [card, ...subs].forEach(c => { c.r = false; c.f = false; c.v = false; c.s = []; delete c.cn; delete c.tm; tz.push(c); });
        log(`${nm}が『${cname(card)}』${subs.length ? `（セット${subs.length}枚ごと）` : ''}を${zoneLabel(a.seat, a.zone)}へ`);
      } else {
        card.s = subs; tz.push(card);
        log(`${nm}が『${cname(card)}』を${zoneLabel(a.seat, a.zone)}へ`);
      }
      return;
    }
    case 'leave': {   // 場から持ち主の手札・本国へ
      const f = findCard(S, a.u); if (!f) return;
      if (f.c.coin) { f.arr.splice(f.i, 1); log(`${nm}が『${f.c.coin}』${f.c.n}枚を取り除きました`); return; }
      const all = [f.c, ...(f.c.s || [])];
      const owners = new Set(all.map(c => c.o));
      for (const o of owners) if (!canReach(o)) return `${S.seats[o].name || '持ち主'}がいないので動かせません`;
      f.arr.splice(f.i, 1);
      all.forEach(c => sendGain(c.o, { u: c.u, id: c.id }, a.to));
      const where = { hand: '手札', top: '本国の上', bottom: '本国の下' }[a.to];
      log(`${nm}が『${SECRET.includes(f.zone) ? ZONES[f.zone] + 'のカード' : cname(f.c)}』${all.length > 1 ? `（セット${all.length - 1}枚ごと）` : ''}を持ち主の${where}へ`);
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
    case 'endTurn': {
      if (who.seat !== S.active) return '手番の人だけがターンを終えられます';
      clearTm(S);
      const nx = (S.active + 1) % S.seats.length;
      S.active = nx; S.turn = (S.turn || 0) + 1; S.phase = 0;
      eachCard(S.seats[nx], c => c.r = false);
      log(`── 第${S.turn}ターン ${S.seats[nx].name || `席${nx + 1}`}のターン（${PHASES[0]}：全リロール）──`, 'turn');
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
    case 'pshuffle': { const z = PILES.includes(a.zone) ? a.zone : 'discard'; shuffle(seatObj.z[z]); if (z === 'discard') seatObj.pk = null; log(`${nm}が${ZONES[z]}を切りました`); return; }
    case 'rerollAll': eachCard(seatObj, c => c.r = false); log(`${nm}が自分のカードを全てリロール`); return;
    case 'newGame':
      if (who.seat !== 0) return '新しいゲームは部屋を作った人だけが始められます';
      S.game++; S.turn = 0; S.active = null; S.phase = null; S.first = null; S.reveal = null;
      S.seats.forEach(s => { s.z = emptyZones(); s.ready = false; s.dn = 0; s.hn = 0; s.deckName = ''; s.su = null; s.mull = 0; s.pk = null; s.sh = null; });
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
  return got.length;
}
const takeFrom = (arr, u) => { const i = arr.findIndex(c => c.u === u); return i < 0 ? null : arr.splice(i, 1)[0]; };
const takeFromHand = u => takeFrom(B.priv.hand, u);
const takeFromDeck = u => takeFrom(B.priv.deck, u);
const takeFromLook = u => takeFrom(B.priv.look || (B.priv.look = []), u);
function playFrom(take, src, u, zone, opt = {}) {
  if (!online()) { toast('つながっていません'); return; }
  const c = take(u); if (!c) return;
  savePriv(); act({ t: 'enter', cards: [c], zone, seat: opt.seat ?? mySeat(), f: opt.f, onto: opt.onto, src });
}
const playFromHand = (u, zone, opt) => playFrom(takeFromHand, 'hand', u, zone, opt);
const playFromDeck = (u, zone, opt) => playFrom(takeFromDeck, 'deck', u, zone, opt);
const playFromLook = (u, zone, opt) => playFrom(takeFromLook, 'deck', u, zone, opt);
function startWithDeck(d) {
  const list = [];
  Object.entries(d.cards).forEach(([id, n]) => { if (BY_ID.has(id)) for (let i = 0; i < n; i++) list.push({ u: `${B.seat}${rid()}${list.length}`, id }); });
  if (!list.length) { toast('このデッキは空です'); return; }
  B.priv = { game: B.S.game, deck: shuffle(list), hand: [], look: [] };
  savePriv(); act({ t: 'ready', deckName: d.name });
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
  if (resume) { B.S = resume.S; B.rec = resume.rec || []; }
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

function miniFace(c) {
  const x = c.id && BY_ID.get(c.id);
  if (!x) return `<div class="mc back">GW</div>`;
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
  const subs = (c.s || []).map(x => `<div class="sub${x.r ? ' r' : ''}" draggable="${isPlayer()}" data-src="${src}" data-u="${esc(x.u)}" ${x.id ? `data-cid="${esc(x.id)}"` : ''}>${esc(x.f && !x.id ? '裏向き' : cname(x))}${Object.keys(x.cn || {}).length ? ` ●${Object.values(x.cn).reduce((a, b) => a + b, 0)}` : ''}${x.tm ? ` <span class="tms" title="${esc(tmTitle(x.tm))}">${esc(tmLabel(x.tm))}</span>` : ''}</div>`).join('');
  const tot = !c.f ? groupStats(c) : null;
  const v = c.v && !c.f && known && known.alt;
  const tmc = hasTm(c) ? ' tm' : '';
  const tmb = c.tm ? `<div class="tmb" title="${esc(tmTitle(c.tm))}">${esc(tmLabel(c.tm))}</div>` : '';
  return `<div class="slot${c.r ? ' r' : ''}${v ? ' v' : ''}${lead ? ' lead1' : ''}" draggable="${isPlayer()}" data-src="${src}" data-u="${esc(c.u)}" ${known ? `data-cid="${esc(c.id)}"` : ''}>${lead ? '<span class="leadtag">先頭</span>' : ''}${(c.f && known) ? miniFace({}).replace('GW', '裏') : miniFace(c)}${coinBadges(c)}${tmb}${!subs && tot ? `<div class="gst ov${tmc}" title="コイン・一時修正込みの戦闘力">[${esc(tot.join(']['))}]</div>` : ''}${subs ? `<div class="subs">${tot ? `<div class="gst${tmc}" title="セットグループの合計（コイン・一時修正込み）">計[${esc(tot.join(']['))}]</div>` : ''}${subs}</div>` : ''}</div>`;
}
function zoneHtml(seat, z, cls = '') {
  const arr = VS.seats[seat].z[z];
  if (PILES.includes(z)) {
    const top = arr[arr.length - 1];
    const face = !top ? '' : SECRET.includes(z) ? '<div class="slot"><div class="mc back">GW</div></div>' : slot(top, 'pub').replace('draggable="true"', 'draggable="false"');
    return `<div class="zone pile" data-seat="${seat}" data-zone="${z}" data-pile="1"><div class="zl">${ZONES[z]}</div><div class="zc">${face}</div><span class="num${arr.length ? '' : ' zero'}">${arr.length}</span></div>`;
  }
  const bat = BATTLE.includes(z), fo = bat ? forceOf(arr) : null;
  const lead = bat && !fo ? '<div class="leadbox" title="戦闘エリアは左が先頭です（カードのメニューで前後を入れ替え）"><span>先頭</span></div>' : '';
  const force = fo ? `<b class="bforce${fo.unk ? ' unk' : ''}" title="部隊戦闘力＝先頭のユニットの格闘力＋2番目からのユニットの射撃力（コイン・一時修正込み）\n${esc(fo.note)}${fo.unk ? '\n数字でない所（*など）は0として数えています' : ''}">部隊戦闘力 ${fo.total}${fo.unk ? '＋？' : ''}</b>` : '';
  const add = isPlayer() && seat === mySeat() ? `<span class="zadd" data-coinzone="${z}" title="この置き場にコインを置きます（カードの上に乗せるのはカードのメニューか、コインをカードへドラッグ）">＋コイン</span>` : '';
  return `<div class="zone ${cls}${bat ? ' bat' : ''}" data-seat="${seat}" data-zone="${z}"><div class="zl">${force}${ZONES[z]}${arr.length ? `（${arr.length}）` : ''}${add}</div><div class="zc">${lead}${arr.map(c => slot(c, 'pub', !!fo && c.u === fo.lead)).join('')}</div></div>`;
}
function deckPile(seat) {
  const s = VS.seats[seat], mine = seat === B.seat && B.priv;
  const n = mine ? B.priv.deck.length : s.dn;
  return `<div class="zone pile" data-seat="${seat}" data-zone="deck" ${mine ? 'data-mydeck="1"' : ''}><div class="zl">本国</div><div class="zc">${n ? `<div class="slot" ${mine ? 'draggable="true" data-src="decktop"' : ''}><div class="mc back">GW</div></div>` : ''}</div><span class="num${n ? '' : ' zero'}">${n}</span></div>`;
}
function rowHtml2(seat) {
  return `<div class="bhalf${VS.active === seat ? ' active' : ''}">
    <div class="piles">${deckPile(seat)}${zoneHtml(seat, 'discard')}${zoneHtml(seat, 'junk')}${zoneHtml(seat, 'removed')}</div>
    ${gZoneHtml(seat)}${zoneHtml(seat, 'deploy', 'dep')}</div>`;
}
// ---------------------------------------------------------------------
//  G 置き場：基本Gは色ごとの束（例「緑×4」）、特殊G・裏向き・セット付きは1枚ずつ。
//  上に「今発生している国力」。カードの gp（[色, 数, 条件]、tools/build_cards_js.py が文面から読む）で数える
// ---------------------------------------------------------------------
const GCOL = ['白', '青', '緑', '黒', '赤', '茶', '紫'];
const gOpen = new Set();       // 束を広げて見ている席（自分の画面だけ）
function gPower(seat) {
  const pow = {}, cnt = {}, roll = {}; let unk = 0;
  for (const c of VS.seats[seat].z.G) {
    if (c.coin) continue;
    const x = !c.f && c.id && BY_ID.get(c.id), gp = x && x.gp;
    if (!gp) { unk++; continue; }
    const [col, k, cond] = gp;
    cnt[col] = (cnt[col] || 0) + 1;
    if (c.r) roll[col] = (roll[col] || 0) + 1;
    const off = (cond === 'R' && c.r) || (cond === 'myTurn' && VS.active !== seat)
      || (cond === 'myDeploy' && !(VS.active === seat && VS.phase === 2));
    if (!off) pow[col] = (pow[col] || 0) + k;
  }
  return { pow, cnt, roll, unk };
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
  const arr = VS.seats[seat].z.G, { pow, cnt, roll, unk } = gPower(seat);
  const cols = GCOL.filter(c => cnt[c]);
  const total = Object.values(pow).reduce((a, b) => a + b, 0);
  const chips = cols.map(c => {
    const p = pow[c] || 0, more = cnt[c] !== p ? `<small>/${cnt[c]}枚</small>` : '';
    // 基本Gはロールしていても国力を出す。ロールの数は茶（Gをロールして使う効果が多い）だけ見出しに出す
    const r = c === '茶' ? `<small class="rl">ロール${roll[c] || 0}</small>` : '';
    return `<span class="gchip${p ? '' : ' zero'}" style="--cc:var(--c-${c})" title="${c}：国力${p}（${cnt[c]}枚${roll[c] ? `、ロール${roll[c]}` : ''}）">${c}${p}${more}${r}</span>`;
  }).join('') + (unk ? `<span class="gchip unk" title="出す国力がデータで分からないG（裏向き・効果で決まる物など）。人が判断してください">？${unk}</span>` : '');
  const tog = arr.length ? `<span class="gtog" data-gtog="${seat}">${gOpen.has(seat) ? '束ねる' : '広げる'}</span>` : '';
  return `<div class="zl gsum" title="今発生している国力 ${total}">G<b>${arr.length ? arr.length + '枚' : ''}</b>${chips}${tog}</div>`;
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
  return `<div class="gb gsl${c.r ? ' allr' : ''}" draggable="${isPlayer()}" data-src="pub" data-u="${esc(c.u)}" ${x ? `data-cid="${esc(c.id)}"` : ''} style="--cc:${col ? `var(--c-${col})` : '#2b3550'}" title="${esc(x ? x.n : '裏向きのカード')}">
    <span class="gsn">${esc(x ? x.n : '裏')}</span>${subs}${c.r ? '<span class="gbr">R</span>' : ''}</div>`;
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
  ]);
}
function seatStrip(seat, me) {
  const s = VS.seats[seat];
  const status = !s.name ? '<span class="off">（空席）</span>' : s.online ? '' : '<span class="off">（切断中）</span>';
  const act = VS.active === seat ? '<span class="act">● ターンプレイヤー</span>' : '';
  const hand = me ? '' : ` 手札 <b>${s.hn}</b>枚 ${s.hn ? '<span style="letter-spacing:-2px">' + '▮'.repeat(Math.min(s.hn, 20)) + '</span>' : ''}`;
  return `<div class="bstrip"><b>${esc(s.name || `席${seat + 1}`)}</b>${status}${act}<span>${s.ready ? esc(s.deckName) : (s.name ? '準備中…' : '')}</span><span>${hand}</span></div>`;
}
function phaseBar(S, me) {
  if (S.active == null) return `<div class="bphase"><span class="note">${S.seats.every(s => s.su === 'done') ? '両者の手札が決まりました。先攻を決めてください' : '両者が「ゲームスタート」で手札を決めたら、先攻を決めます'}</span></div>`;
  const mine = S.active === me && isPlayer();
  return `<div class="bphase${mine ? ' mine' : ''}"><b>第${S.turn}ターン</b><span class="who">${mine ? 'あなた' : esc(S.seats[S.active].name || `席${S.active + 1}`)}のターン</span>
    ${PHASES.map((p, i) => `<span class="ph${i === S.phase ? ' on' : ''}${i < S.phase ? ' done' : ''}" ${mine ? `data-ph="${i}" title="押すとこのフェイズにします"` : ''}>${p}</span>`).join('<span class="ar">›</span>')}</div>`;
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
// 相手（観戦なら両者）の公開中の手札
function shownRow(seat) {
  const s = VS.seats[seat], sh = s.sh; if (!sh || !sh.c.length) return '';
  const rest = Math.max(0, s.hn - sh.c.length);
  const canPt = isPlayer() && seat !== mySeat();
  return `<div class="bshown"><div class="zl"><b>${esc(s.name || `席${seat + 1}`)}</b>の手札を公開中<br>${sh.c.length}枚${rest ? `（ほかに裏${rest}枚）` : '（全部）'}${canPt ? '<br><span style="color:var(--sub)">押すと指定（ハンデスなど）</span>' : ''}</div>
    <div class="zc">${sh.c.map(c => slot({ u: c.u, id: c.id }, 'shown').replace(/draggable="(true|false)"/, 'draggable="false"').replace('class="slot', `data-seat="${seat}" class="slot${sh.pt === c.u ? ' pt' : ''}`)).join('')}${rest ? `<div class="slot"><div class="mc back">×${rest}</div></div>` : ''}</div></div>`;
}
function render() {
  if (!B.S) { renderLobby(); return; }
  VS = B.role === 'host' ? viewFor(0) : B.S;
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
          : mine ? (S.phase < PHASES.length - 1 ? `<button id="bNext" class="primary">次へ：${PHASES[S.phase + 1]}</button>` : '') + `<button id="bEnd" ${S.phase === PHASES.length - 1 ? 'class="primary"' : ''}>ターンエンド</button>`
          : '<span class="note">相手のターンです</span>') + `
        <span class="sep"></span>
        <input type="number" id="bN" min="1" max="50" value="${esc(nVal)}" title="枚数"><span>枚を</span>
        <button id="bDraw">引く</button><button id="bMill" title="戦闘ダメージ・資源など">本国→捨て山</button><button id="bHeal" title="回復：捨て山の上から枚数ぶんを、裏向きのまま1枚ずつ本国の上へ">回復</button><button id="bLook" title="サーチ：上から見て選び、残りを上か下へ好きな順で戻す">上から見る</button>
        ${B.priv.look?.length ? `<button id="bLookOpen" class="primary">見ているカード（${B.priv.look.length}）</button>` : ''}
        <span class="sep"></span>
        <button id="bShuffle">本国を切る</button><button id="bSearch">本国を全部見る</button><button id="bReroll">全リロール</button>${showing ? '<button id="bShowOff2">手札の公開を終える</button>' : '<button id="bShowAll" title="公開を終えるまで、相手と観戦に手札が見えます（あとで引いたカードは見せません）">手札を公開</button>'}`;
    }
  } else ctl = `<span class="note">観戦中です。カードに乗せると右に大きく出ます。</span>`;

  const pw = B.priv && S.seats[me].su ? gPower(me) : null;
  const myHand = B.priv ? B.priv.hand.map(c => {
    let h = slot(c, 'hand');
    if (pw && canPay(BY_ID.get(c.id), pw, B.priv.deck.length)) h = h.replace('class="slot', 'title="今の国力で出せます" class="slot ok');
    return mySh.has(c.u) ? h.replace('class="slot', `class="slot shown${myPt === c.u ? ' pt' : ''}`) : h;
  }).join('') : '';
  root.innerHTML = `
  <div class="bboard">
    ${phaseBar(S, me)}
    ${B.lost ? `<div class="bbanner">部屋の管理役との接続が切れました。<button id="bRejoin">入り直す</button></div>` : ''}
    ${seatStrip(op, false)}
    ${shownRow(op)}
    ${rowHtml2(op)}
    <div class="bmid">
      <div class="bfield bg-space">${zoneHtml(op, 'space')}${zoneHtml(me, 'space')}</div>
      <div class="bfield bg-earth">${zoneHtml(op, 'earth')}${zoneHtml(me, 'earth')}</div>
    </div>
    ${rowHtml2(me)}
    ${B.role === 'spect' ? seatStrip(me, true) + shownRow(me) : ''}
    ${B.role !== 'spect' ? `<div class="bhand"><div class="zone" data-seat="${me}" data-zone="hand"><div class="zl"><b>${esc(S.seats[me].name)}</b>${S.active === me ? ' <span style="color:var(--accent)">● あなたのターン</span>' : ''}　手札（${B.priv ? B.priv.hand.length : 0}）${showing ? `<span class="shnote">● ${mySh.size}枚を公開中</span><button id="bShowOff" class="mini">公開を終える</button>` : '※自分にだけ見えます'}</div><div class="zc">${myHand}</div></div></div>` : ''}
    <div class="bctl">${ctl}</div>
  </div>
  <div class="bside">
    <div class="binfo">
      <div>部屋コード <span class="roomcode" id="bCodeCopy" title="クリックでコピー">${esc(B.code)}</span></div>
      <div>${esc(B.name)}：${roleTxt}　観戦 ${S.spect.length}人${S.spect.length ? `（${esc(S.spect.join('、'))}）` : ''}</div>
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
  on('bDraw', () => { const n = draw(N()); render(); act({ t: 'note', msg: `${n}枚引きました` }); });
  on('bMill', () => {
    if (!online()) return toast('つながっていません');
    const got = B.priv.deck.splice(0, N()); savePriv();
    if (got.length) act({ t: 'enter', cards: got, zone: 'discard', src: 'deck' });
  });
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
function showPrev(cid, u) {
  const el = $('bPrev'); if (!el) return;
  const f = u && VS && findCard(VS, u), g = f && (f.parent || f.c);
  if (g && (g.s || []).length) {
    const list = [g, ...g.s].filter(x => x.id && BY_ID.has(x.id)), tot = g.f ? null : groupStats(g);
    if (list.length) {
      B.prev = { cid, u };
      el.innerHTML = `<div class="grp"><div class="gh">セットグループ ${g.s.length + 1}枚${tot ? `　合計 <b>[${esc(tot.join(']['))}]</b>` : ''}</div>${list.map(x => cardFace(BY_ID.get(x.id), { v: x === g && g.v && !g.f })).join('')}</div>`;
      return;
    }
  }
  const c = BY_ID.get(cid); if (!c) return;
  const tm = f && f.c.tm, st = f && !f.c.f && groupStats(f.c);
  B.prev = { cid, u }; el.innerHTML = (tm || st ? `<div class="grp"><div class="gh">${tm ? `<b class="tmt">${esc(tmTitle(tm))}</b>　` : ''}${st ? `今の数字 <b>[${esc(st.join(']['))}]</b>` : ''}</div>` : '') + cardFace(c, { v: !!(f && f.c.v && !f.c.f) }) + (tm || st ? '</div>' : '');
}
root.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-u],[data-cid]'); if (!t) return;
  if (t.dataset.src === 'pub' && t.dataset.u) showPrev(t.dataset.cid, t.dataset.u);
  else if (t.dataset.cid) showPrev(t.dataset.cid);
});

// クリックメニュー
const ctx = document.createElement('div'); ctx.id = 'bctx'; document.body.appendChild(ctx);
function menu(x, y, title, items) {
  const host = document.querySelector('dialog[open]') || document.body; if (ctx.parentNode !== host) host.appendChild(ctx);
  ctx.innerHTML = `<div class="hd">${esc(title)}</div>` + items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}">${esc(it[0])}</button>`).join('');
  ctx.classList.add('on');
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.min(x + 10, innerWidth - w - 8) + 'px'; ctx.style.top = Math.max(8, Math.min(y + 10, innerHeight - h - 8)) + 'px';  // 少しずらす（ダブルクリックの2回目がメニューに当たらないように）
  ctx.onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; ctx.classList.remove('on'); items[+b.dataset.i][1](); };
}
document.addEventListener('mousedown', e => { if (!ctx.contains(e.target)) ctx.classList.remove('on'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') ctx.classList.remove('on'); });

function coinPick(x, y, title, fn) {
  menu(x, y, title, [...COINS.map(n => [n, () => fn(n)]), ['ほかの名前…', () => { const n = (prompt('コインの名前（例：暴走コイン）', '') || '').trim(); if (n) fn(/コイン$/.test(n) ? n : n + 'コイン'); }]]);
}
function coinMenu(f, x, y) {
  const c = f.c, u = c.u;
  menu(x, y, `${c.coin} ×${c.n}（${zoneLabel(f.seat, f.zone)}）`, [
    ['1枚足す', () => act({ t: 'coin', u, d: 1 })],
    ['1枚減らす', () => act({ t: 'coin', u, d: -1 })], '-',
    ...['deploy', 'space', 'earth', 'G'].filter(z => z !== f.zone).map(z => [`${ZONES[z]}へ`, () => act({ t: 'move', u, seat: f.seat, zone: z })]),
    ...BATTLE.includes(f.zone) || f.zone === 'deploy' ? [['左へ（前へ）', () => act({ t: 'zorder', u, d: -1 })], ['右へ（後ろへ）', () => act({ t: 'zorder', u, d: 1 })]] : [], '-',
    ['取り除く', () => act({ t: 'leave', u, to: 'hand' })]
  ]);
}
function pubMenu(u, x, y) {
  const f = findCard(VS, u); if (!f) return;
  if (f.c.coin) return coinMenu(f, x, y);
  const c = f.c, owner = c.o, mine = owner === B.seat;
  const cn = Object.entries(c.cn || {});
  const items = [
    [c.r ? 'リロール（縦に）' : 'ロール（横に）', () => act({ t: 'roll', u })],
    ...((BY_ID.get(c.id) || {}).alt && !c.f ? [[c.v ? '元の形態に戻す' : `変形（${BY_ID.get(c.id).alt.name || '変形形態'}）`, () => act({ t: 'transform', u })]] : []),
    [c.f ? '表にする' : '裏にする', () => act({ t: 'flip', u })], '-',
    ...MOVE_TO.filter(z => !(z === f.zone && f.seat === owner && !f.parent)).map(z => [`${ZONES[z]}へ`, () => act({ t: 'move', u, seat: owner, zone: z })]),
    '-',
    ['持ち主の手札へ', () => act({ t: 'leave', u, to: 'hand' })],
    ['持ち主の本国の上へ', () => act({ t: 'leave', u, to: 'top' })],
    ['持ち主の本国の下へ', () => act({ t: 'leave', u, to: 'bottom' })]
  ];
  if (f.parent) items.unshift([`セットを外す（${ZONES[f.zone]}に置く）`, () => act({ t: 'move', u, seat: f.seat, zone: f.zone })]);
  if (!f.parent && f.arr.length > 1 && (BATTLE.includes(f.zone) || f.zone === 'deploy')) {
    const order = [];
    if (f.i > 0) order.push([`左へ（前へ）${BATTLE.includes(f.zone) && f.i === 1 ? '：先頭にする' : ''}`, () => act({ t: 'zorder', u, d: -1 })]);
    if (f.i < f.arr.length - 1) order.push(['右へ（後ろへ）', () => act({ t: 'zorder', u, d: 1 })]);
    items.splice(items.indexOf('-'), 0, ...order);
  }
  const coinItems = [['コインを乗せる…', () => coinPick(x, y, `『${cname(c)}』に乗せるコイン`, n => act({ t: 'coin', u, name: n, d: 1 }))]];
  for (const [k, n] of cn) coinItems.push([`${k}（${n}枚）を1枚足す`, () => act({ t: 'coin', u, name: k, d: 1 })], [`${k}を1枚取る`, () => act({ t: 'coin', u, name: k, d: -1 })], [`${k}を外して場に置く`, () => act({ t: 'coinOff', u, name: k })]);
  items.push('-', ...coinItems);
  items.push('-', [`一時修正（+1/+0/-1・※）…${c.tm ? `　今：${tmLabel(c.tm)}` : ''}`, () => openTm(u)]);
  if (c.tm) items.push(['一時修正を消す', () => act({ t: 'tmod', u })]);
  menu(x, y, cname(c) + (mine ? '' : `（${B.S.seats[owner].name}のカード）`), items);
}
function handMenu(u, x, y) {
  const c = B.priv.hand.find(c => c.u === u); if (!c) return;
  menu(x, y, cname(c), [
    ...['deploy', 'G', 'space', 'earth'].map(z => [`${ZONES[z]}へ出す`, () => playFromHand(u, z)]),
    ['裏向きで配備エリアへ', () => playFromHand(u, 'deploy', { f: true })],
    ...(B.priv.show || []).includes(u)
      ? [['このカードの公開をやめる', () => setShow(B.priv.show.filter(x => x !== u), false)]]
      : [['このカードを公開する（公開したまま）', () => setShow([...(B.priv.show || []), u], false)],
         ['このカードを1度だけ見せる', () => act({ t: 'reveal', ids: [c.id], what: '手札のカード' })]],
    ...(B.priv.show || []).length ? [['手札の公開を全部終える', () => setShow([], false)]] : [], '-',
    ...['discard', 'junk', 'removed'].map(z => [`${ZONES[z]}へ`, () => playFromHand(u, z)]), '-',
    ['本国の上に戻す', () => { B.priv.deck.unshift(takeFromHand(u)); savePriv(); render(); act({ t: 'note', msg: '手札を1枚本国の上に戻しました' }); }],
    ['本国の下に戻す', () => { B.priv.deck.push(takeFromHand(u)); savePriv(); render(); act({ t: 'note', msg: '手札を1枚本国の下に戻しました' }); }]
  ]);
}
function deckCardMenu(u, x, y, after) {
  const c = B.priv.deck.find(c => c.u === u); if (!c) return;
  const done = () => { savePriv(); render(); after(); };
  menu(x, y, cname(c), [
    ['手札に加える', () => { B.priv.hand.push(takeFromDeck(u)); done(); act({ t: 'note', msg: '本国から1枚手札に加えました' }); }],
    ...['deploy', 'G', 'discard', 'junk', 'removed'].map(z => [`${ZONES[z]}へ出す`, () => { playFromDeck(u, z); after(); }]), '-',
    ['一番上へ', () => { B.priv.deck.unshift(takeFromDeck(u)); done(); }],
    ['一番下へ', () => { B.priv.deck.push(takeFromDeck(u)); done(); act({ t: 'note', msg: '本国の1枚を一番下にしました' }); }]
  ]);
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
      `中身はあなたにだけ見えています（相手と観戦の人には見えません）。右が一番上です。◀ ▶ で並べ替え、カードを押すと手札や場へ動かせます。${hidden ? `この下にまだ${hidden}枚あります（見ていません）。` : ''}閉じると見るのをやめます。`,
      cards, (u, x, y) => discardCardMenu(u, x, y),
      '<button id="pShufD" style="margin-right:auto">切ってから閉じる</button>', under,
      (b, u) => b === 'hand' ? act({ t: 'leave', u, to: 'hand' }) : act({ t: 'preorder', u, d: b === 'up' ? 1 : -1 }),
      i => `上から${cards.length - i}`);
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
    ...['deploy', 'G', 'space', 'earth', 'junk', 'removed'].map(z => [`${ZONES[z]}へ出す`, () => act({ t: 'move', u, seat: c.o, zone: z })]),
    '-',
    ['捨て山の一番上へ', () => act({ t: 'preorder', u, to: 'top' })],
    ['捨て山の一番下へ', () => act({ t: 'preorder', u, to: 'bottom' })]
  ]);
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
    ...['deploy', 'G', 'junk', 'discard', 'removed'].map(z => [`${ZONES[z]}へ出す`, () => { playFromLook(u, z); after(); }]), '-',
    ['これだけ本国の上へ', () => { B.priv.deck.unshift(takeFromLook(u)); savePriv(); act({ t: 'note', msg: '見ているカードを1枚本国の上に置きました' }); after(); }],
    ['これだけ本国の下へ', () => { B.priv.deck.push(takeFromLook(u)); savePriv(); act({ t: 'note', msg: '見ているカードを1枚本国の下に置きました' }); after(); }]
  ]);
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
      ['上の1枚を捨て山へ', () => { const g = B.priv.deck.splice(0, 1); savePriv(); if (g.length) act({ t: 'enter', cards: g, zone: 'discard', src: 'deck' }); }]
    ]);
    return;
  }
  const tog = e.target.closest('[data-gtog]');
  if (tog) { const st = +tog.dataset.gtog; gOpen.has(st) ? gOpen.delete(st) : gOpen.add(st); render(); return; }
  if (!isPlayer()) return;
  const cz = e.target.closest('[data-coinzone]');
  if (cz) { const z = cz.dataset.coinzone; coinPick(e.clientX, e.clientY, `${ZONES[z]}に置くコイン`, n => act({ t: 'coinPut', zone: z, name: n, n: 1 })); return; }
  const t = e.target.closest('[data-u]'); if (!t) return;
  if (t.dataset.gb) { gbMenu(+t.dataset.seat, t.dataset.gb, e.clientX, e.clientY); return; }
  if (t.dataset.src === 'shown') {
    const seat = +t.dataset.seat; if (seat === mySeat()) return;
    const sh = VS.seats[seat].sh, on = sh && sh.pt === t.dataset.u;
    menu(e.clientX, e.clientY, cname({ id: t.dataset.cid }) + `（${VS.seats[seat].name}の手札）`, [
      [on ? '指定を外す' : 'このカードを指定する（ハンデスなど）', () => act({ t: 'point', seat, u: t.dataset.u })]
    ]);
    return;
  }
  if (t.dataset.src === 'hand') handMenu(t.dataset.u, e.clientX, e.clientY);
  else if (t.dataset.src === 'pub') pubMenu(t.dataset.u, e.clientX, e.clientY);
});
root.addEventListener('dblclick', e => {
  if (!isPlayer()) return;
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
window.GWB = B; // 調べ物用
})();

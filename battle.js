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
const MOVE_TO = ['deploy', 'space', 'earth', 'G', 'junk', 'discard', 'removed'];
const emptyZones = () => Object.fromEntries(Object.keys(ZONES).map(k => [k, []]));
const emptySeat = () => ({ name: '', online: false, ready: false, deckName: '', dn: 0, hn: 0, z: emptyZones() });
const rid = () => Math.random().toString(36).slice(2, 7);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cname = c => { const x = c && c.id && BY_ID.get(c.id); return x ? x.n : '裏向きのカード'; };

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
    send(d) { ch.postMessage({ to: other, from: me, k: 'data', d: JSON.parse(JSON.stringify(d)) }); },
    close() { ch.postMessage({ to: other, from: me, k: 'bye' }); this._emit('close'); }
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
          onConn(c); setTimeout(() => c._emit('open'), 0);
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
      p.on('connection', onConn);
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
        if (m.k === 'ok') { clearTimeout(t); res(c); }
        else if (m.k === 'data') c._emit('data', m.d);
        else if (m.k === 'bye') c._emit('close');
      };
      addEventListener('beforeunload', () => ch.postMessage({ to: 'host', from: me, k: 'bye' }));
      ch.postMessage({ to: 'host', from: me, k: 'hello', meta });
    });
    if (!window.Peer) return Promise.reject(new Error('通信の部品（PeerJS）が読み込めませんでした'));
    return new Promise((res, rej) => {
      const p = new Peer(PEER_OPT);
      const t = setTimeout(() => { p.destroy(); rej(new Error('つながりませんでした（時間切れ）')); }, 20000);
      p.on('open', () => {
        const c = p.connect(PFX + code, { metadata: meta, reliable: true, serialization: 'json' });
        c.on('open', () => { clearTimeout(t); res(c); });
      });
      p.on('error', e => { clearTimeout(t); p.destroy(); rej(e); });
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
      if (a.onto) { const t = findCard(S, a.onto); if (t) { onto = t.c; t.c.s.push(...cards); } else tz.push(...cards); }
      else tz.push(...cards);
      const from = a.src === 'deck' ? '本国の上から' : '手札から';
      const names = cards.length > 3 ? `${cards.length}枚` : cards.map(c => `『${c.f ? '裏向きのカード' : cname(c)}』`).join('');
      log(`${nm}が${from}${names}を${onto ? `『${cname(onto)}』にセット` : zoneLabel(a.seat ?? who.seat, a.zone) + 'へ'}`);
      return;
    }
    case 'move': {    // 場から場へ
      const f = findCard(S, a.u); if (!f) return;
      const tz = S.seats[a.seat]?.z[a.zone]; if (!tz && !a.onto) return;
      if (a.onto) { if (a.onto === a.u || (f.c.s || []).some(x => x.u === a.onto)) return; }
      f.arr.splice(f.i, 1);
      const card = f.c, subs = card.s || []; card.s = [];
      if (a.onto) {
        const t = findCard(S, a.onto); if (!t) { tz.push(card); return; }
        t.c.s.push(card, ...subs);
        log(`${nm}が『${cname(card)}』を『${cname(t.c)}』にセット`);
        return;
      }
      if (PILES.includes(a.zone)) {   // 捨て札置き場へは表向き・リロール状態で、セットしていたカードも一緒に
        [card, ...subs].forEach(c => { c.r = false; c.f = false; c.s = []; tz.push(c); });
        log(`${nm}が『${cname(card)}』${subs.length ? `（セット${subs.length}枚ごと）` : ''}を${zoneLabel(a.seat, a.zone)}へ`);
      } else {
        card.s = subs; tz.push(card);
        log(`${nm}が『${cname(card)}』を${zoneLabel(a.seat, a.zone)}へ`);
      }
      return;
    }
    case 'leave': {   // 場から持ち主の手札・本国へ
      const f = findCard(S, a.u); if (!f) return;
      const all = [f.c, ...(f.c.s || [])];
      const owners = new Set(all.map(c => c.o));
      for (const o of owners) if (!canReach(o)) return `${S.seats[o].name || '持ち主'}がいないので動かせません`;
      f.arr.splice(f.i, 1);
      all.forEach(c => sendGain(c.o, { u: c.u, id: c.id }, a.to));
      const where = { hand: '手札', top: '本国の上', bottom: '本国の下' }[a.to];
      log(`${nm}が『${cname(f.c)}』${all.length > 1 ? `（セット${all.length - 1}枚ごと）` : ''}を持ち主の${where}へ`);
      return;
    }
    case 'roll': { const f = findCard(S, a.u); if (!f) return; f.c.r = !f.c.r; log(`${nm}が『${cname(f.c)}』を${f.c.r ? 'ロール' : 'リロール'}`); return; }
    case 'flip': { const f = findCard(S, a.u); if (!f) return; f.c.f = !f.c.f; log(`${nm}が『${cname(f.c)}』を${f.c.f ? '裏' : '表'}向きに`); return; }
    case 'turn': {
      eachCard(seatObj, c => c.r = false);
      S.turn = (S.turn || 0) + 1; S.active = who.seat;
      log(`── 第${S.turn}ターン ${nm}のターン（全リロール${a.drew ? '・1枚ドロー' : ''}）──`, 'turn');
      return;
    }
    case 'rerollAll': eachCard(seatObj, c => c.r = false); log(`${nm}が自分のカードを全てリロール`); return;
    case 'newGame':
      if (who.seat !== 0) return '新しいゲームは部屋を作った人だけが始められます';
      S.game++; S.turn = 0; S.active = null;
      S.seats.forEach(s => { s.z = emptyZones(); s.ready = false; s.dn = 0; s.hn = 0; s.deckName = ''; });
      log('── 新しいゲーム。デッキを選んで準備してください ──', 'turn');
      return;
  }
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
  s.seats.forEach(st => Object.values(st.z).forEach(arr => arr.forEach(c => { if (c.f && c.o !== seat) c.id = null; (c.s || []).forEach(x => { if (x.f && x.o !== seat) x.id = null; }); })));
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
function takeFromHand(u) { const i = B.priv.hand.findIndex(c => c.u === u); return i < 0 ? null : B.priv.hand.splice(i, 1)[0]; }
function takeFromDeck(u) { const i = B.priv.deck.findIndex(c => c.u === u); return i < 0 ? null : B.priv.deck.splice(i, 1)[0]; }
function playFromHand(u, zone, opt = {}) {
  if (!online()) { toast('つながっていません'); return; }
  const c = takeFromHand(u); if (!c) return;
  savePriv(); act({ t: 'enter', cards: [c], zone, seat: opt.seat ?? mySeat(), f: opt.f, onto: opt.onto, src: 'hand' });
}
function playFromDeck(u, zone, opt = {}) {
  if (!online()) { toast('つながっていません'); return; }
  const c = takeFromDeck(u); if (!c) return;
  savePriv(); act({ t: 'enter', cards: [c], zone, seat: opt.seat ?? mySeat(), f: opt.f, onto: opt.onto, src: 'deck' });
}
function startWithDeck(d) {
  const list = [];
  Object.entries(d.cards).forEach(([id, n]) => { if (BY_ID.has(id)) for (let i = 0; i < n; i++) list.push({ u: `${B.seat}${rid()}${list.length}`, id }); });
  if (!list.length) { toast('このデッキは空です'); return; }
  B.priv = { game: B.S.game, deck: shuffle(list), hand: [] };
  savePriv(); act({ t: 'ready', deckName: d.name });
  toast('本国を切りました。最初の手札を引いてください');
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
  B.S.seats[0].name = name; B.S.seats[0].online = true;
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
      if (i > 0) { seat = i; role = 'player'; const s = B.S.seats[i]; if (s.name !== name) { s.name = name; } s.online = true; }
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
    ${x.st ? `<span class="mst">${esc(x.st.join('/'))}</span>` : ''}</div>`;
}
// 場のカード（ロール中は横向き、セットしたカードは下に名札で）
function slot(c, src) {
  const known = c.id && BY_ID.get(c.id);
  const subs = (c.s || []).map(x => `<div class="sub${x.r ? ' r' : ''}" draggable="${isPlayer()}" data-src="${src}" data-u="${esc(x.u)}" ${x.id ? `data-cid="${esc(x.id)}"` : ''}>${esc(x.f && !x.id ? '裏向き' : cname(x))}</div>`).join('');
  return `<div class="slot${c.r ? ' r' : ''}" draggable="${isPlayer()}" data-src="${src}" data-u="${esc(c.u)}" ${known ? `data-cid="${esc(c.id)}"` : ''}>${(c.f && known) ? miniFace({}).replace('GW', '裏') : miniFace(c)}${subs ? `<div class="subs">${subs}</div>` : ''}</div>`;
}
function zoneHtml(seat, z, cls = '') {
  const arr = VS.seats[seat].z[z];
  if (PILES.includes(z)) {
    const top = arr[arr.length - 1];
    return `<div class="zone pile" data-seat="${seat}" data-zone="${z}" data-pile="1"><div class="zl">${ZONES[z]}</div><div class="zc">${top ? slot(top, 'pub').replace('draggable="true"', 'draggable="false"') : ''}</div><span class="num">${arr.length}</span></div>`;
  }
  return `<div class="zone ${cls}" data-seat="${seat}" data-zone="${z}"><div class="zl">${ZONES[z]}${arr.length ? `（${arr.length}）` : ''}</div><div class="zc">${arr.map(c => slot(c, 'pub')).join('')}</div></div>`;
}
function deckPile(seat) {
  const s = VS.seats[seat], mine = seat === B.seat && B.priv;
  const n = mine ? B.priv.deck.length : s.dn;
  return `<div class="zone pile" data-seat="${seat}" data-zone="deck" ${mine ? 'data-mydeck="1"' : ''}><div class="zl">本国</div><div class="zc">${n ? `<div class="slot" ${mine ? 'draggable="true" data-src="decktop"' : ''}><div class="mc back">GW</div></div>` : ''}</div><span class="num">${n}</span></div>`;
}
function rowHtml2(seat) {
  return `<div class="bhalf">
    <div class="piles">${deckPile(seat)}${zoneHtml(seat, 'discard')}${zoneHtml(seat, 'junk')}${zoneHtml(seat, 'removed')}</div>
    ${zoneHtml(seat, 'G', 'g')}${zoneHtml(seat, 'deploy', 'dep')}</div>`;
}
function seatStrip(seat, me) {
  const s = VS.seats[seat];
  const status = !s.name ? '<span class="off">（空席）</span>' : s.online ? '' : '<span class="off">（切断中）</span>';
  const act = VS.active === seat ? '<span class="act">● 手番</span>' : '';
  const hand = me ? '' : ` 手札 <b>${s.hn}</b>枚 ${s.hn ? '<span style="letter-spacing:-2px">' + '▮'.repeat(Math.min(s.hn, 20)) + '</span>' : ''}`;
  return `<div class="bstrip"><b>${esc(s.name || `席${seat + 1}`)}</b>${status}${act}<span>${s.ready ? esc(s.deckName) : (s.name ? '準備中…' : '')}</span><span>${hand}</span></div>`;
}
function render() {
  if (!B.S) { renderLobby(); return; }
  VS = B.role === 'host' ? viewFor(0) : B.S;
  const me = mySeat(), op = 1 - me, S = VS;
  const st = root.querySelector('.blog')?.scrollTop, atBottom = (() => { const l = root.querySelector('.blog'); return !l || l.scrollTop + l.clientHeight >= l.scrollHeight - 4; })();
  const chatVal = $('bChatIn')?.value || '', chatFocus = document.activeElement?.id === 'bChatIn';
  const nVal = $('bN')?.value || '1';
  const roleTxt = B.role === 'host' ? '対戦者（部屋の管理役）' : B.role === 'player' ? '対戦者' : '観戦者';
  let ctl = '';
  if (isPlayer()) {
    if (!B.priv) {
      const opts = decks.slice().sort((a, b) => b.updated - a.updated).map(d => `<option value="${d.id}" ${d.id === curId ? 'selected' : ''}>${esc(d.name)}（${Object.values(d.cards).reduce((a, b) => a + b, 0)}枚）</option>`).join('');
      ctl = `<span>デッキ</span><select id="bDeck">${opts}</select><button id="bReady" class="primary">このデッキで準備（本国を切る）</button>`;
    } else {
      ctl = `<button id="bTurn" class="primary" title="自分のカードを全てリロールして1枚引く">ターン開始</button>
        <span class="sep"></span>
        <input type="number" id="bN" min="1" max="50" value="${esc(nVal)}" title="枚数"><span>枚を</span>
        <button id="bDraw">引く</button><button id="bMill" title="戦闘ダメージなど">本国→捨て山</button><button id="bLook">本国の上を見る</button>
        <span class="sep"></span>
        <button id="bShuffle">本国を切る</button><button id="bSearch">本国を全部見る</button><button id="bReroll">全リロール</button>`;
    }
    if (B.role === 'host') ctl += `<button id="bRec" class="ghost" style="margin-left:auto" title="操作の記録をファイルに保存（将来の再生用）">記録を保存</button><button id="bNew" class="ghost">新しいゲーム</button>`;
  } else ctl = `<span class="note">観戦中です。カードに乗せると右に大きく出ます。</span>`;

  const myHand = B.priv ? B.priv.hand.map(c => slot(c, 'hand')).join('') : '';
  root.innerHTML = `
  <div class="bboard">
    ${B.lost ? `<div class="bbanner">部屋の管理役との接続が切れました。<button id="bRejoin">入り直す</button></div>` : ''}
    ${seatStrip(op, false)}
    ${rowHtml2(op)}
    <div class="bmid">
      <div class="bfield">${zoneHtml(op, 'space')}${zoneHtml(me, 'space')}</div>
      <div class="bfield">${zoneHtml(op, 'earth')}${zoneHtml(me, 'earth')}</div>
    </div>
    ${rowHtml2(me)}
    ${B.role === 'spect' ? seatStrip(me, true) : ''}
    ${B.role !== 'spect' ? `<div class="bhand"><div class="zone" data-seat="${me}" data-zone="hand"><div class="zl"><b>${esc(S.seats[me].name)}</b>${S.active === me ? ' <span style="color:var(--accent)">● 手番</span>' : ''}　手札（${B.priv ? B.priv.hand.length : 0}）※自分にだけ見えます</div><div class="zc">${myHand}</div></div></div>` : ''}
    <div class="bctl">${ctl}</div>
  </div>
  <div class="bside">
    <div class="binfo">
      <div>部屋コード <span class="roomcode" id="bCodeCopy" title="クリックでコピー">${esc(B.code)}</span></div>
      <div>${esc(B.name)}：${roleTxt}　観戦 ${S.spect.length}人${S.spect.length ? `（${esc(S.spect.join('、'))}）` : ''}</div>
    </div>
    <div class="bprev" id="bPrev"><div class="note" style="align-self:center">カードに乗せると大きく出ます</div></div>
    <div class="blog" id="bLog">${S.log.map(l => `<div class="${l.c}">${esc(l.m)}</div>`).join('')}</div>
    <div class="bchat"><input id="bChatIn" placeholder="ひとこと（全員に見えます）" maxlength="200"><button id="bChatGo">送る</button></div>
  </div>`;
  const lg = $('bLog'); lg.scrollTop = atBottom ? lg.scrollHeight : st;
  $('bChatIn').value = chatVal; if (chatFocus) $('bChatIn').focus();
  if (B.prev) showPrev(B.prev);
  wire();
}

// ---------------------------------------------------------------------
//  操作（ボタン・クリックメニュー・ドラッグ）
// ---------------------------------------------------------------------
function N() { return Math.max(1, Math.min(50, +($('bN')?.value) || 1)); }
function wire() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('bReady', () => { const d = decks.find(x => x.id === $('bDeck').value); if (d) startWithDeck(d); });
  on('bTurn', () => { const n = draw(1); act({ t: 'turn', drew: n }); });
  on('bDraw', () => { const n = draw(N()); render(); act({ t: 'note', msg: `${n}枚引きました` }); });
  on('bMill', () => {
    if (!online()) return toast('つながっていません');
    const got = B.priv.deck.splice(0, N()); savePriv();
    if (got.length) act({ t: 'enter', cards: got, zone: 'discard', src: 'deck' });
  });
  on('bLook', () => { act({ t: 'note', msg: `本国の上${Math.min(N(), B.priv.deck.length)}枚を見ました` }); openDeckView(N()); });
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
function showPrev(cid) {
  const c = BY_ID.get(cid), el = $('bPrev'); if (!c || !el) return;
  B.prev = cid; el.innerHTML = cardFace(c);
}
root.addEventListener('mouseover', e => { const t = e.target.closest('[data-cid]'); if (t) showPrev(t.dataset.cid); });

// クリックメニュー
const ctx = document.createElement('div'); ctx.id = 'bctx'; document.body.appendChild(ctx);
function menu(x, y, title, items) {
  ctx.innerHTML = `<div class="hd">${esc(title)}</div>` + items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}">${esc(it[0])}</button>`).join('');
  ctx.classList.add('on');
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.min(x + 10, innerWidth - w - 8) + 'px'; ctx.style.top = Math.max(8, Math.min(y + 10, innerHeight - h - 8)) + 'px';  // 少しずらす（ダブルクリックの2回目がメニューに当たらないように）
  ctx.onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; ctx.classList.remove('on'); items[+b.dataset.i][1](); };
}
document.addEventListener('mousedown', e => { if (!ctx.contains(e.target)) ctx.classList.remove('on'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') ctx.classList.remove('on'); });

function pubMenu(u, x, y) {
  const f = findCard(VS, u); if (!f) return;
  const c = f.c, owner = c.o, mine = owner === B.seat;
  const items = [
    [c.r ? 'リロール（縦に）' : 'ロール（横に）', () => act({ t: 'roll', u })],
    [c.f ? '表にする' : '裏にする', () => act({ t: 'flip', u })], '-',
    ...MOVE_TO.filter(z => !(z === f.zone && f.seat === owner && !f.parent)).map(z => [`${ZONES[z]}へ`, () => act({ t: 'move', u, seat: owner, zone: z })]),
    '-',
    ['持ち主の手札へ', () => act({ t: 'leave', u, to: 'hand' })],
    ['持ち主の本国の上へ', () => act({ t: 'leave', u, to: 'top' })],
    ['持ち主の本国の下へ', () => act({ t: 'leave', u, to: 'bottom' })]
  ];
  if (f.parent) items.unshift([`セットを外す（${ZONES[f.zone]}に置く）`, () => act({ t: 'move', u, seat: f.seat, zone: f.zone })]);
  menu(x, y, cname(c) + (mine ? '' : `（${B.S.seats[owner].name}のカード）`), items);
}
function handMenu(u, x, y) {
  const c = B.priv.hand.find(c => c.u === u); if (!c) return;
  menu(x, y, cname(c), [
    ...['deploy', 'G', 'space', 'earth'].map(z => [`${ZONES[z]}へ出す`, () => playFromHand(u, z)]),
    ['裏向きで配備エリアへ', () => playFromHand(u, 'deploy', { f: true })], '-',
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

// 本国・捨て札置き場の一覧
const dlg = document.createElement('dialog'); dlg.id = 'pileDlg'; document.body.appendChild(dlg);
function openList(title, note, cards, onCard, extra = '') {
  dlg.innerHTML = `<h3>${esc(title)}</h3><p class="note">${esc(note)}</p>
    <div class="plist">${cards.map((c, i) => `<div><div class="idx">${i + 1}</div>${slot(c, 'list').replace(/draggable="true"/g, 'draggable="false"')}</div>`).join('') || '<div class="note">（なし）</div>'}</div>
    <div class="row">${extra}<button id="pClose" class="primary">閉じる</button></div>`;
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('#pClose').onclick = () => dlg.close();
  dlg.querySelector('.plist').onclick = e => { const s = e.target.closest('[data-u]'); if (s) onCard(s.dataset.u, e.clientX, e.clientY); };
  dlg.querySelector('.plist').onmouseover = e => { const t = e.target.closest('[data-cid]'); if (t) showPrev(t.dataset.cid); };
}
let deckViewN = 0;
function openDeckView(n) {
  deckViewN = n;
  const cards = n ? B.priv.deck.slice(0, n) : B.priv.deck;
  openList(n ? `本国の上${cards.length}枚` : `本国（${cards.length}枚）`, '左が一番上です。カードを押すと動かせます。中身はあなたにしか見えません。', cards,
    (u, x, y) => deckCardMenu(u, x, y, () => openDeckView(deckViewN)),
    n ? '' : '<button id="pShuf" style="margin-right:auto">切ってから閉じる</button>');
  const s = dlg.querySelector('#pShuf');
  if (s) s.onclick = () => { shuffle(B.priv.deck); savePriv(); act({ t: 'note', msg: '本国を切りました' }); dlg.close(); };
}
function openPile(seat, z) {
  const arr = VS.seats[seat].z[z];
  const draw = () => openList(`${zoneLabel(seat, z)}（${arr.length}枚）`, isPlayer() ? '右が一番上です。カードを押すと動かせます。' : '右が一番上です。', arr,
    isPlayer() ? (u, x, y) => { pubMenu(u, x, y); } : () => {});
  draw();
}

// 盤面のクリック
root.addEventListener('click', e => {
  if (!B.S || ctx.contains(e.target)) return;
  const pile = e.target.closest('[data-pile]');
  if (pile) { openPile(+pile.dataset.seat, pile.dataset.zone); return; }
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
  if (!isPlayer()) return;
  const t = e.target.closest('[data-u]'); if (!t) return;
  if (t.dataset.src === 'hand') handMenu(t.dataset.u, e.clientX, e.clientY);
  else if (t.dataset.src === 'pub') pubMenu(t.dataset.u, e.clientX, e.clientY);
});
root.addEventListener('dblclick', e => {
  if (!isPlayer()) return;
  const t = e.target.closest('[data-src="pub"][data-u]'); if (t) { ctx.classList.remove('on'); act({ t: 'roll', u: t.dataset.u }); }
});

// ドラッグ
let drag = null;
root.addEventListener('dragstart', e => {
  const t = e.target.closest('[draggable="true"]'); if (!t || !isPlayer()) { e.preventDefault(); return; }
  drag = { src: t.dataset.src, u: t.dataset.u };
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'gw');
  e.stopPropagation();
});
root.addEventListener('dragend', () => { drag = null; root.querySelectorAll('.over,.drop').forEach(x => x.classList.remove('over', 'drop')); });
function dropTarget(e) {
  const card = e.target.closest('.zone:not([data-pile]):not([data-zone="hand"]) [data-src="pub"][data-u]');
  if (card && drag && card.dataset.u !== drag.u) return { onto: card.dataset.u, el: card.querySelector('.mc') || card };
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

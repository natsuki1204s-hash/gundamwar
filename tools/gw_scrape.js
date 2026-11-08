// ガンダムウォーWiki カード取り込みスクリプト
// 使い方：Chromeで https://w.atwiki.jp/gundamwar/ を開き、F12 → Console に貼り付けて Enter
// （初回は「allow pasting」と打つよう求められることがあります）
(async () => {
  // ===== 設定 =====
  // テスト用：セットページを1つだけ指定（例：刻の末裔）。全部取るときは null にする
  const TEST_SET = 'https://w.atwiki.jp/gundamwar/pages/69.html';
  const SET_LIST = 'https://w.atwiki.jp/gundamwar/pages/11.html'; // カードセット一覧
  const DELAY = 3000;      // 1ページごとの待ち時間（ミリ秒）。弾かれたら増やす
  const SAVE_EVERY = 300;  // この枚数ごとに途中経過をダウンロード
  // ================

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isPage = h => /\/gundamwar\/pages\/\d+\.html$/.test(h);

  async function getDoc(url, retry = 2) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) return new DOMParser().parseFromString(await res.text(), 'text/html');
    if (retry > 0 && [403, 429, 503].includes(res.status)) {
      console.warn(`弾かれました(${res.status})。60秒待って再試行: ${url}`);
      await sleep(60000);
      return getDoc(url, retry - 1);
    }
    throw new Error(`${res.status} ${url}`);
  }

  const body = doc => doc.querySelector('#wikibody') || doc.querySelector('.atwiki-contents') || doc.body;

  function links(doc, base) {
    const out = new Set();
    body(doc).querySelectorAll('a[href]').forEach(a => {
      try {
        const u = new URL(a.getAttribute('href'), base);
        u.protocol = 'https:'; u.hash = ''; u.search = '';
        if (isPage(u.href)) out.add(u.href);
      } catch (e) {}
    });
    return [...out];
  }

  // カードページなら生テキストを返す（細かい分解は後でまとめてやる）
  function parseCard(doc, url) {
    const b = body(doc).cloneNode(true);
    const pres = [...b.querySelectorAll('pre')].map(p => p.textContent.trim());
    // 「U-159 緑 1-1-1 C」のような型番行があるページだけをカードとみなす
    if (!pres.some(t => /[A-Z]{1,3}-\d+\s+\S+/.test(t))) return null;
    b.querySelectorAll('script,style').forEach(e => e.remove());
    b.querySelectorAll('pre').forEach(p => p.replaceWith(doc.createTextNode(`\n@@PRE@@\n${p.textContent.trim()}\n@@/PRE@@\n`)));
    b.querySelectorAll('br').forEach(e => e.replaceWith(doc.createTextNode('\n')));
    b.querySelectorAll('p,div,li,h1,h2,h3,h4,tr').forEach(e => e.append(doc.createTextNode('\n')));
    let raw = b.textContent.replace(/\n{3,}/g, '\n\n').trim();
    const cut = raw.indexOf('をウィキ内検索');
    if (cut > 0) raw = raw.slice(0, raw.lastIndexOf('\n', cut)).trim();
    const title = (doc.title || '').split(' - ')[0].trim();
    return { id: url.match(/(\d+)\.html$/)[1], url, title, pres, raw };
  }

  function save(cards, label) {
    const blob = new Blob([JSON.stringify(cards, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gundamwar_cards_${label}.json`;
    a.click();
    console.log(`💾 ${cards.length}枚を保存しました（${label}）`);
  }

  // 1) セットページを集める
  let sets;
  if (TEST_SET) {
    sets = [TEST_SET];
  } else {
    sets = links(await getDoc(SET_LIST), SET_LIST);
    await sleep(DELAY);
  }
  console.log(`セット候補 ${sets.length}ページ`);

  // 2) 各セットページからカード候補を集める
  const candidates = new Set();
  for (const [i, s] of sets.entries()) {
    try {
      links(await getDoc(s), s).forEach(h => candidates.add(h));
    } catch (e) { console.warn('セット取得失敗', e.message); }
    console.log(`セット ${i + 1}/${sets.length} 読了（候補 ${candidates.size}）`);
    await sleep(DELAY);
  }
  sets.forEach(s => candidates.delete(s));

  // 3) カードページを順番に読む
  const list = [...candidates];
  const cards = [], failed = [];
  const t0 = Date.now();
  for (const [i, url] of list.entries()) {
    try {
      const c = parseCard(await getDoc(url), url);
      if (c) cards.push(c);
    } catch (e) {
      failed.push(url);
      console.warn('失敗', e.message);
      if (failed.length >= 20 && failed.length > i * 0.5) {
        console.error('失敗が多すぎるので中断します。DELAYを増やして再挑戦してください');
        break;
      }
    }
    if ((i + 1) % 20 === 0) {
      const left = ((Date.now() - t0) / (i + 1)) * (list.length - i - 1) / 60000;
      console.log(`${i + 1}/${list.length} 処理、カード${cards.length}枚、残り約${Math.round(left)}分`);
    }
    if (cards.length && cards.length % SAVE_EVERY === 0 && (i + 1) < list.length) save(cards, `partial_${cards.length}`);
    await sleep(DELAY);
  }

  save(cards, TEST_SET ? 'test' : 'all');
  if (failed.length) console.log('失敗したURL:', failed);
  console.log('🎉 完了！');
})();

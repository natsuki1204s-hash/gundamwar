"""丸ごと回収した生ページ（gw_scrape_all.js の gundamwar_raw_part*.json）からカードのページを選び、
data/raw/wiki_pages.json に足して cards_full.json と cards.js を作り直す（merge_raw.py を使う）。
Wiki には行かないので、判定を直したら何度でも数秒でやり直せる。
使い方: python3 tools/pick_cards.py [part.json ...]   省略すると data/raw/all/*.json
        --dry  何ページ拾うかだけ表示して書き込まない"""
import glob, json, re, subprocess, sys, tempfile

# 判定ルール。漏れが見つかったらここを直して再実行する
# 種類の行（UNIT / COMMAND / Generation など）のすぐ次の行が番号（U-159 / G-5 / G-84 青 / G-2 だけ）ならカードのページ。
# 番号だけで見るとデッキ紹介やセットのページ（カードの番号を並べている）まで拾ってしまう
TYPE = re.compile(r'^\s*(UNIT|CH[A-Z]{4,8}|CAHARACTER|CO[A-Z]{4,6}|OP[A-Z]{5,8}|GENERATION|ACE|G)\s*(\([A-Z・]+\))?\s*$', re.I)
NUM = re.compile(r'^\s*(?:[A-Z] )?[A-Z]{1,3}-(?:00-)?[A-Z]{0,3}\d+[A-Z]?(?:[\s　]|$)')


def is_card(p):
    if p.get('missing') or not str(p.get('id', '')).isdigit() or 'テンプレート' in p.get('title', ''):
        return False
    lines = [l for l in p.get('raw', '').replace('@@PRE@@', '').replace('@@/PRE@@', '').split('\n') if l.strip()]
    if sum(1 for l in lines if NUM.match(l)) > 30:  # カードの一覧のページ（プロモーションカードの SP など）
        return False
    return any(TYPE.match(lines[i]) and NUM.match(lines[i + 1]) for i in range(len(lines) - 1))


args = [a for a in sys.argv[1:] if a != '--dry']
files = args or sorted(glob.glob('data/raw/all/*.json'))
pages = {}
for f in files:
    for p in json.load(open(f, encoding='utf-8')):
        pages[str(p['id'])] = p
cards = [p for p in pages.values() if is_card(p)]
known = {str(p['id']) for p in json.load(open('data/raw/wiki_pages.json', encoding='utf-8'))}
new = [p for p in cards if p['id'] not in known]
print(f'生ページ {len(pages)}（うち空き {sum(1 for p in pages.values() if p.get("missing"))}）→ カード {len(cards)}、新しい物 {len(new)}')
# 既に持っているページは上書きしない（文面が変わって id がずれるのを防ぐ）
for p in new[:40]:
    print('  ', p['id'], p['title'])
if "--dry" in sys.argv or not new:
    sys.exit()
with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as t:
    json.dump(sorted(new, key=lambda p: int(p['id'])), t, ensure_ascii=False)
subprocess.run([sys.executable, 'tools/merge_raw.py', t.name], check=True)

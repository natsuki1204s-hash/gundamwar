"""取り込みスクリプトの結果（gundamwar_cards_*.json）を data/raw/wiki_pages.json に足して、
data/cards_full.json と cards.js を作り直す。同じページ番号は新しい方で上書き。
順番は変えない（cards.js の id の「#2」などは並び順で決まるので、並べ替えると保存済みデッキが別カードを指すことがある）
使い方: python3 tools/merge_raw.py 新しい取り込み.json [さらに.json ...]"""
import json, subprocess, sys
RAW = 'data/raw/wiki_pages.json'
pages = {c['id']: c for c in json.load(open(RAW, encoding='utf-8'))}
before = len(pages)
for f in sys.argv[1:]:
    for c in json.load(open(f, encoding='utf-8')):
        pages[c['id']] = c
out = list(pages.values())  # dict は入れた順を保つ。新しいページは末尾に足される
json.dump(out, open(RAW, 'w', encoding='utf-8'), ensure_ascii=False)
print(f'ページ {before} → {len(out)}')
subprocess.run([sys.executable, 'tools/gw_parse.py', RAW, 'data/cards_full.json'], check=True)
subprocess.run([sys.executable, 'tools/build_cards_js.py', 'data/cards_full.json', 'cards.js'], check=True)

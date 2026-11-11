"""data/cards_full.json（gw_parse.py の出力）から、卓で読む cards.js を作る
使い方: python3 tools/build_cards_js.py data/cards_full.json cards.js"""
import json, sys
src, dst = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding='utf-8'))
TY = {'UNIT': 'U', 'CHARACTER': 'CH', 'COMMAND': 'C', 'OPERATION': 'O', 'GENERATION': 'G', 'ACE': 'A'}
groups, order = {}, []
for p in d:  # 名前・コスト・テキスト・戦闘力が同じ収録違いは1枚にまとめる
    key = (p['name'], p['type'], p['color'], tuple(p['cost']), tuple(p['text']), tuple(p.get('stats') or []), json.dumps(p.get('alt'), ensure_ascii=False))
    if key not in groups:
        groups[key] = {'p': p, 'nos': [], 'sets': []}
        order.append(key)
    g = groups[key]
    g['nos'].append(p['no'])
    g['sets'] += [s for s in p['sets'] if s and s not in g['sets']]
out, seen = [], set()
for k in order:
    g = groups[k]; p = g['p']
    cid = f"{p['no']}|{p['name']}"; n = 2
    while cid in seen:
        cid = f"{p['no']}|{p['name']}#{n}"; n += 1
    seen.add(cid)
    c = {'id': cid, 'n': p['name'], 't': TY.get(p['type'], p['type']), 'c': p['color'],
         'k': [None if x in (None, '*') else int(x) if str(x).isdigit() else x for x in p['cost']],
         'r': p['rarity'], 'x': p['text'], 'no': g['nos'], 's': g['sets']}
    for src_k, dst_k in (('dual', 'd'), ('model', 'm'), ('stats', 'st'), ('tags', 'tg'), ('traits', 'tr'), ('alt', 'alt')):
        if p.get(src_k): c[dst_k] = p[src_k]
    out.append(c)
open(dst, 'w', encoding='utf-8').write('window.GW_CARDS=' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')
print(len(d), '->', len(out))

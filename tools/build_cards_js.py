"""data/cards_full.json（gw_parse.py の出力）から、卓で読む cards.js を作る
使い方: python3 tools/build_cards_js.py data/cards_full.json cards.js"""
import json, re, sys

# G が出す国力（対戦卓の G 置き場の集計用）。文面の「(自動A):…紫国力1を発生する」を読む
# gp = [色, 数, 条件]。条件 '' いつも / 'R' リロール状態の場合 / 'myTurn' 自軍ターンの間 / 'myDeploy' 自軍配備フェイズの間
# 読めない物（効果で色が決まる等）は gp を付けない → 卓では「？」
def gen_power(text):
    for x in text:
        if not x.startswith('(自動A)'): continue
        x2 = re.search(r'([白青緑黒赤茶紫])国力Xを発生する.*コインの個数\+1', x)  # タメG：コインなしで1。コインの分は数えない
        if x2: return [x2.group(1), 1, '']
        t = re.search(r'自軍ターン中、([白青緑黒赤茶紫])国力(\d)、敵軍ターン中', x)  # 流転する世界の陣営G（ネオ・ジオン など）
        if t: return [t.group(1), int(t.group(2)), 'myTurn']
        m = re.search(r'([白青緑黒赤茶紫])\s*国力(\d)を発生する', x)
        if not m: continue
        cond = 'R' if 'リロール状態の場合' in x else 'myDeploy' if '配備フェイズ' in x else 'myTurn' if '自軍ターンの間' in x else ''
        return [m.group(1), int(m.group(2)), cond]
    return None
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
# 前の cards.js の id は変えない（保存済みデッキが別カードを指さないように）。
# 新しく読めるようになった収録（例：ガンダムエクシア U-00-1）が前からある SP-70 の前に来ても、前の id を使う
old_ids = {}
try:
    t = open(dst, encoding='utf-8').read()
    for oc in json.loads(t[t.index('['):t.rindex(']') + 1]):
        for no in oc['no']:
            old_ids.setdefault((no, oc['n']), []).append(oc['id'])
except FileNotFoundError:
    pass
out, seen = [], set()
for k in order:
    g = groups[k]; p = g['p']
    keep = [i for no in g['nos'] for i in old_ids.get((no, p['name']), []) if i not in seen]
    cid = keep[0] if keep else f"{p['no']}|{p['name']}"; n = 2
    while cid in seen:
        cid = f"{p['no']}|{p['name']}#{n}"; n += 1
    seen.add(cid)
    c = {'id': cid, 'n': p['name'], 't': TY.get(p['type'], p['type']), 'c': p['color'],
         'k': [None if x in (None, '*') else int(x) if str(x).isdigit() else x for x in p['cost']],
         'r': p['rarity'], 'x': p['text'], 'no': g['nos'], 's': g['sets']}
    for src_k, dst_k in (('dual', 'd'), ('model', 'm'), ('stats', 'st'), ('tags', 'tg'), ('traits', 'tr'), ('alt', 'alt')):
        if p.get(src_k): c[dst_k] = p[src_k]
    if c['t'] == 'G' and gen_power(p['text']): c['gp'] = gen_power(p['text'])
    out.append(c)
open(dst, 'w', encoding='utf-8').write('window.GW_CARDS=' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')
print(len(d), '->', len(out))

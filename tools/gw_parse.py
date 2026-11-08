"""gundamwar_cards_*.json（取り込み結果）を、対戦卓で使うカードデータに整形する"""
import json, re, sys, unicodedata

TYPE_RE = re.compile(r'^(UNIT|CH[A-Z]{4,8}|CO[A-Z]{4,6}|OP[A-Z]{5,8}|GENERATION|ACE|G)\s*(\([A-Z・]+\))?$', re.I)
FIX_TYPE = {'CHRACTER': 'CHARACTER', 'CHARCTER': 'CHARACTER', 'COMMNAD': 'COMMAND', 'COMAND': 'COMMAND'}
PREFIX_TYPE = {'EX': 'UNIT', 'U': 'UNIT', 'CH': 'CHARACTER', 'C': 'COMMAND', 'O': 'OPERATION', 'G': 'GENERATION', 'A': 'ACE'}
NO_RE = re.compile(r'^(?:[A-Z] )?([A-Z]{1,3}-[A-Z]?\d+[A-Z]?)\s+(白|青|緑|黒|赤|茶|紫|無)?\s*(\d+|\*)?-?(\d+|\*)?-?(\d+|\*)?\s*(.*)$')
STATS_RE = re.compile(r'^(.*?)\s*\[([^\]]*)\]\[([^\]]*)\]\[([^\]]*)\]\s*$')
EFFECT_START = re.compile(r'^[（(【《]')


def norm(s):
    s = unicodedata.normalize('NFKC', s)
    return re.sub(r'[ \t]+', ' ', s).strip()


def tokenize(raw):
    """生テキストを ('pre', [行...]) / ('text', 行) の並びにする"""
    items, buf, in_pre = [], [], False
    for line in raw.split('\n'):
        if line.strip() == '@@PRE@@':
            in_pre, buf = True, []
        elif line.strip() == '@@/PRE@@':
            in_pre = False
            ls = [norm(l) for l in buf if l.strip()]
            # 表記ゆれ：「青 C-123 ...」→「C-123 青 ...」、「U-49」改行「茶 2-2-4 C」→1行に
            ls = [re.sub(r'^(白|青|緑|黒|赤|茶|紫) ([A-Z]{1,3}-\S+)', r'\2 \1', l) for l in ls]
            for k in range(len(ls) - 1):
                if re.fullmatch(r'[A-Z]{1,3}-[A-Z]?\d+[A-Z]?', ls[k]) and re.match(r'^(白|青|緑|黒|赤|茶|紫) ', ls[k + 1]):
                    ls[k], ls[k + 1] = ls[k] + ' ' + ls[k + 1], ''
            items.append(('pre', [l for l in ls if l]))
        elif in_pre:
            buf.append(line)
        else:
            t = norm(line)
            if t and t != '[部分編集]':
                items.append(('text', t))
    # 囲み枠に入っていない新しめの書式を、囲み枠と同じ形に寄せる
    out, i = [], 0
    while i < len(items):
        k, v = items[i]
        if k == 'text' and TYPE_RE.match(v) and i + 1 < len(items) and items[i + 1][0] == 'text' and NO_RE.match(items[i + 1][1]):
            out.append(('pre', [v, items[i + 1][1], '@@PLAIN@@'])); i += 2; continue
        if k == 'text' and NO_RE.match(v) and (not out or out[-1] != ('pre', [])) and re.match(r'^(EX|GA|SP)-', v):
            out.append(('pre', [v])); i += 1; continue
        if k == 'text' and STATS_RE.match(v):
            # 直前に特徴だけの行があればまとめる（例：ガンダム系 MS ／ [3][1][3]）
            out.append(('pre', [v])); i += 1; continue
        out.append((k, v)); i += 1
    return out


def header_of(item):
    if item[0] != 'pre' or not item[1]:
        return None
    lines = [l for l in item[1] if l != '@@PLAIN@@']
    if TYPE_RE.match(lines[0]) and len(lines) > 1 and NO_RE.match(lines[1]):
        t, nl = lines[0], lines[1]
    elif NO_RE.match(lines[0]) and not STATS_RE.match(lines[0]):
        t, nl = '', lines[0]
    else:
        return None
    m = NO_RE.match(nl)
    return {'type_raw': t.upper(), 'no': m[1], 'color': m[2] or '',
            'cost': [m[3], m[4], m[5]], 'rarity': m[6].strip()}


def stats_of(item):
    if item[0] != 'pre' or header_of(item):
        return None
    lines = item[1]
    if not lines or not STATS_RE.match(lines[-1]):
        return None
    m = STATS_RE.match(lines[-1])
    extra = ' '.join(lines[:-1] + [m[1]]).split()
    return {'tags': extra, 'stats': [m[2], m[3], m[4]]}


def parse_card(c):
    items = tokenize(c['raw'])
    title = c['title']
    printings = []
    heads = [i for i, it in enumerate(items) if header_of(it)]
    for n, h in enumerate(heads):
        hd = header_of(items[h])
        end = heads[n + 1] if n + 1 < len(heads) else len(items)
        # 収録セットと型番：直前のテキスト行
        prev_text = [items[j][1] for j in range(heads[n - 1] + 1 if n else 0, h) if items[j][0] == 'text']
        sets = prev_text[-1] if prev_text else ''
        model = ''
        for t in reversed(prev_text):
            if t.endswith(title) and t != title:
                model = t[: -len(title)].strip(); break
        if not model:
            first = items[0][1] if items and items[0][0] == 'text' else ''
            if first.endswith(title) and first != title:
                model = first[: -len(title)].strip()
        body = items[h + 1:end]
        stat_idx = [i for i, it in enumerate(body) if stats_of(it)]
        p = dict(hd, name=title, model=model, sets=[s.strip() for s in sets.split('/')])
        t = hd['type_raw'].split('(')[0].strip()
        t = FIX_TYPE.get(t, t)
        t = {'CH': 'CHARACTER', 'CO': 'COMMAND', 'OP': 'OPERATION'}.get(t[:2], t) if t not in ('UNIT', 'GENERATION', 'ACE', 'G') else t
        if not t:
            pre = re.match(r'^([A-Z]+)-', hd['no'])[1]
            t = PREFIX_TYPE.get(pre, PREFIX_TYPE.get(pre[0], ''))
        p['type'] = t
        p['color'] = p['color'] or '無'
        # 型番だけで種類表記もセット行もない＝エラッタ前の旧テキスト
        p['old'] = n > 0 and not hd['type_raw'] and any(k in ' '.join(prev_text) for k in ('エラッタ', '当時', '旧テキスト', '以前'))
        if stat_idx and stat_idx[0] <= 15:
            s0 = stat_idx[0]
            p['text'] = [it[1] for it in body[:s0] if it[0] == 'text']
            st = stats_of(body[s0])
            p['tags'], p['stats'] = st['tags'], st['stats']
            # 囲み枠なしの書式：型番の次の行が「連邦 男性 子供 NT」のような特徴行
            if '@@PLAIN@@' in items[h][1] and p['text'] and not re.search(r'[:：。【《(（]', p['text'][0]):
                p['traits'] = p['text'].pop(0).split()
            # 変形などの第2形態：形態名 → (テキスト) → 戦闘力
            if len(stat_idx) > 1 and stat_idx[1] - s0 <= 3:
                mid = [it[1] for it in body[s0 + 1:stat_idx[1]] if it[0] == 'text']
                st2 = stats_of(body[stat_idx[1]])
                p['alt'] = {'name': mid[0] if mid else '', 'text': mid[1:], 'tags': st2['tags'], 'stats': st2['stats']}
        else:
            txt = []
            for it in body:
                if it[0] != 'text':
                    break
                if EFFECT_START.match(it[1]) or (not txt and len(it[1]) <= 20 and '。' not in it[1]):
                    txt.append(it[1])
                else:
                    break
            p['text'] = txt
        p.pop('type_raw')
        p['page'] = c['url']
        printings.append(p)
    return printings


def main(src, dst):
    cards = json.load(open(src, encoding='utf-8'))
    out, empty = [], []
    for c in cards:
        ps = parse_card(c)
        if not ps:
            empty.append(c['title'])
        out.extend(ps)
    out = [p for p in out if not p.pop('old')]
    for i, p in enumerate(out):
        p['id'] = f"{p['no']}_{i}"
    json.dump(out, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'ページ {len(cards)} → カード {len(out)}種（収録違い込み）')
    if empty:
        print('読み取れなかったページ:', empty)
    return out


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])

#!/bin/bash
# 返事の最後に1行：この会話（スレッド）で使ったトークン数
# Claude Code の会話記録（~/.claude/projects/*/最新の .jsonl）を数える。同じ requestId は1回だけ数える
f=$(ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1)
if [ -z "$f" ]; then echo "今回の使用量：記録が見つからないので不明"; exit 0; fi
python3 - "$f" <<'PY'
import json, sys
seen = {}
for line in open(sys.argv[1], encoding="utf-8"):
    try: d = json.loads(line)
    except Exception: continue
    m = d.get("message")
    if not isinstance(m, dict) or not m.get("usage"): continue
    seen[d.get("requestId") or d.get("uuid")] = m["usage"]
inp = cr = cw = out = 0
last = 0
for u in seen.values():
    i, r, w, o = (u.get(k) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
    inp += i; cr += r; cw += w; out += o
    last = i + r + w
total = inp + cr + cw + out
man = lambda n: f"{n/10000:.1f}万"
note = "（文脈が50万超え：新しいスレッドがおすすめ）" if last > 500_000 else ""
print(f"今回の使用量：合計 {man(total)}トークン（読み込み {man(inp+cr+cw)}・うちキャッシュ {man(cr)}、書き出し {man(out)}、{len(seen)}回）／今の文脈 {man(last)}{note}")
PY

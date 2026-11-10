#!/bin/bash
# スレッドの始めに1回：最新を取り、引き継ぎ書と最近の commit を出す
cd "$(dirname "$0")/.." || exit 1
git pull -q --rebase 2>/dev/null
git fetch -q --depth=5 2>/dev/null
cat docs/引き継ぎ書.md
echo; echo '=== 最近の commit ==='
git log --oneline -5

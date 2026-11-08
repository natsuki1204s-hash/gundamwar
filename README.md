# GUNDAM WAR 卓

身内でガンダムウォーを遊ぶためのブラウザ卓。

- **デッキ構築**：3000種以上のカードを検索してデッキを作る。スマホ対応。デッキはブラウザに保存、デッキコード（テキスト）で持ち運び・共有。
- **対戦・観戦**：（作成中）部屋コードで繋がる1対1対戦と観戦。

カードデータは [GUNDAM WAR Wiki](https://w.atwiki.jp/gundamwar/) から取り込み。カード名称・テキストの著作権は(株)バンダイにあります。身内利用のみ。

## ファイル
| ファイル | 中身 |
|---|---|
| `index.html` | 卓本体（これを開く） |
| `cards.js` | 卓が読むカードデータ |
| `images/` | 全員に見せるカード画像（`images/README.txt` 参照） |
| `data/cards_full.json` | 整形済みの全カードデータ（収録違いごと） |
| `tools/gw_scrape.js` | Wiki取り込みスクリプト（Chromeのコンソールで実行） |
| `tools/gw_parse.py` | 取り込み結果 → `data/cards_full.json` |
| `tools/build_cards_js.py` | `data/cards_full.json` → `cards.js` |

## カードデータを作り直すとき
```
python3 tools/gw_parse.py gundamwar_cards_all.json data/cards_full.json
python3 tools/build_cards_js.py data/cards_full.json cards.js
```

# 3×4将棋 完全解析ボード — 作り方

どうぶつしょうぎと同じルールの全局面を後退解析し、日本語の Web ページで「どの手で何手勝ち・負けか」を表示する。

## 1. 解析（solver/）

```
（gcc と OpenMP が使える環境で。Windows なら w64devkit の bin を PATH に通す）
gcc -O2 -march=x86-64-v2 -fopenmp solver.c -o solver.exe
solver.exe test      自己テスト（番号付けの往復、指し手と逆算の食い違い）
solver.exe           本番（約10分・メモリ約2GB）→ tb.bin（1.5GB）, reach.bin
gcc -O2 -march=x86-64-v2 -fopenmp builder.c -o builder.exe
builder.exe          → web.bin（到達局面と、ライオンを取れる局面の子だけ値を残す）
python pack.py       → ../web/data/（deflate-raw ブロック、24MB 以下のパック4つ、計78MB）
```

- 終局は田中哲朗の解析と同じ扱い（ライオンを取れる手番側は勝ち、取れずに相手ライオンが自陣に入っていたら負け）。
- 値: 決着までの手数（偶数=手番側の負け、奇数=勝ち）、255=引き分け、254=データなし。
- 左右反転した局面は番号の小さい方だけに値を置く（Web 側も同じ規則で引く）。

## 2. 確認済みの数字（2026-09-27）

| 項目 | 結果 | 田中の解析 |
|---|---|---|
| 初期局面 | 手番（先手）の負け 78手 | 後手勝ち 78手 |
| 到達可能局面（左右反転をまとめた数） | 246,803,167 | 246,803,167 |
| 到達可能局面（反転を別に数える） | 493,573,042 | — |
| 全体での最長 | 173手 | — |

JS 版の局面番号は C 版と 3000 件照合して一致（`node web/test_rank.mjs solver/vectors.txt`、vectors は `solver.exe vectors` で作る）。

## 3. Web（web/）

- 素の HTML/JS（ビルド不要）。`engine.js` ルールと局面番号、`tb.js` データ取得、`app.js` 画面。
- 確認用サーバー: `node web/server.js 8034`（Range 対応）。
- 公開先は Range 要求に対応した静的ホスティングならよい（GitHub Pages / Cloudflare Pages）。

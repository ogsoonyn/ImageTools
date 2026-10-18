# samples

各ツールの「サンプルを読み込む」ボタンが `fetch('../samples/...')` で読み込む素材です。
GitHub Pages などの Web サーバー経由で開いたときだけ使えます（`file://` で開いた場合はボタンが無効になります）。

| パス | 使うツール | 内容 |
| --- | --- | --- |
| `keyout/colon183.png` 〜 `keyout/colon191.png` | `tools/sprite-sheet-maker.html`(サンプルの種類「マゼンタ背景のエフェクト」) | マゼンタ(#FF00FF)背景の連番エフェクト画像 9 枚 |
| `aseprite/slime.aseprite` | `tools/aseprite-sheet-converter.html` | 複数レイヤー・タグ付きのスライムのアニメーション |
| `icon/sample-icon.png` | `tools/icon-generator.html` | 図形だけで描いた 1024×1024 の透過アイコン(山と太陽) |

`tools/jiggle-animator.html` のサンプル(ドット絵のスライム、イラストのゼリー)はファイルを使わず、ツール内のコードで図形を組み合わせてその場で描きます。そのため `file://` で開いた場合も使えます。`tools/frame-sorter.html` のサンプル(光の玉・星・四角・火花を不揃いに並べた画像)も同様にコードで描きます。`tools/pixel-upscaler.html` のサンプル(1ドットの輪郭のスライム 2 コマ)は、ツール内に書いたドットの並びから作ります。

## 出所とライセンス

`keyout/` と `aseprite/` は、もともと各ツールの HTML に base64 で埋め込まれていたサンプルをそのままファイルに書き出したものです（Issue #7）。`icon/` はアイコン一括生成ツールの追加時に、図形を組み合わせてプログラムで描いたものです。
本リポジトリの作者が用意した素材で、リポジトリ全体と同じ [MIT License](../LICENSE) で提供します。

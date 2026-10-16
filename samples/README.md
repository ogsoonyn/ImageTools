# samples

各ツールの「サンプルを読み込む」ボタンが `fetch('../samples/...')` で読み込む素材です。
GitHub Pages などの Web サーバー経由で開いたときだけ使えます（`file://` で開いた場合はボタンが無効になります）。

| パス | 使うツール | 内容 |
| --- | --- | --- |
| `keyout/colon183.png` 〜 `keyout/colon191.png` | `tools/keyout-sprite-packer.html` | マゼンタ(#FF00FF)背景の連番エフェクト画像 9 枚 |
| `aseprite/slime.aseprite` | `tools/aseprite-sheet-converter.html` | 複数レイヤー・タグ付きのスライムのアニメーション |

## 出所とライセンス

いずれも、もともと各ツールの HTML に base64 で埋め込まれていたサンプルをそのままファイルに書き出したものです（Issue #7）。
本リポジトリの作者が用意した素材で、リポジトリ全体と同じ [MIT License](../LICENSE) で提供します。

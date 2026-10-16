# ImageTools

ゲーム素材づくりなどで使う、画像処理系の小さなツール集です。
各ツールは **1つのHTMLファイルで完結** しており、インストールやビルドは要りません。
画像の読み込みから書き出しまで、処理はすべてブラウザの中で行われ、ファイルがどこかへ送信されることはありません。

- 公開ページ: https://ogsoonyn.github.io/ImageTools/ (GitHub Pages)

## ツール一覧

| ツール | 用途 | 入力 | 出力 | ファイル |
| --- | --- | --- | --- | --- |
| Aseprite シート変換 | Aseprite のファイルをスプライトシートに書き出す。レイヤーの表示切替、キャンバスのセル分割、余白の切り詰め、並べ方(横一列・縦一列・グリッド)を指定できる | `.ase` / `.aseprite` | スプライトシート PNG + Aseprite 互換 JSON | [`tools/aseprite-sheet-converter.html`](tools/aseprite-sheet-converter.html) |
| Keyout Sprite Packer | キーカラー(マゼンタなど)を透過に変換し、連番画像を1枚のスプライトシートにまとめる。1枚のシートを渡せば透過処理だけを行う | 連番 PNG / BMP、または既存のシート画像 | 透過済みスプライトシート PNG + JSON | [`tools/keyout-sprite-packer.html`](tools/keyout-sprite-packer.html) |

### Aseprite シート変換

![Aseprite シート変換の画面](docs/images/aseprite-sheet-converter.png)

### Keyout Sprite Packer

![Keyout Sprite Packer の画面](docs/images/keyout-sprite-packer.png)

## 使い方

次のどちらかで開きます。

1. **公開ページから開く**: https://ogsoonyn.github.io/ImageTools/ の一覧から使いたいツールを選びます。
2. **ローカルで開く**: リポジトリを clone(または ZIP でダウンロード)し、`tools/` にある HTML をブラウザで直接開きます。

開いたら、画像ファイルを画面にドラッグ&ドロップするか、ファイル選択ボタンから読み込みます。
設定を調整してプレビューを確認し、「PNGを保存」「JSONを保存」で書き出します。

> [!NOTE]
> ローカルの HTML を `file://` で開いた場合、ブラウザの制限で同梱サンプルの読み込みなど一部の機能が使えないことがあります。ツール本体の処理は通常どおり使えます。

## ディレクトリ構成

```
ImageTools/
├── tools/       各ツールの HTML(1ツール = 1ファイル)
├── templates/   新規ツール用のテンプレートと共通UIの仕様
├── samples/     ツールで試せるサンプル素材
├── docs/
│   └── images/  README 用のスクリーンショット
├── LICENSE
└── README.md
```

## 新しいツールを追加するには

1. [`templates/`](templates/) のテンプレートを `tools/` にコピーし、ファイル名を内容が分かる英小文字のケバブケースにします(例: `tools/palette-swapper.html`)。
2. テンプレートの共通ブロック(テーマ、ヘッダー、保存、ドラッグ&ドロップなど)はそのまま残し、ツール固有の処理を書き足します。共通ブロックの扱いは [`templates/README.md`](templates/README.md) を参照してください。
3. 外部のJS/CSS(Tailwind CDN を含む)は読み込まず、1ファイルで完結させます。既存ツールと同様、フォントは Google Fonts から読み込んで構いません。
4. この README の「ツール一覧」と、トップの一覧ページ(`index.html`)にツールを追加します。
5. スクリーンショットを `docs/images/<ツールのファイル名>.png` に置き、README に貼ります。

## ライセンスと素材の出所

- コード: [MIT License](LICENSE)
- フォント: [Google Fonts](https://fonts.google.com/) から読み込んでいます(いずれも [SIL Open Font License 1.1](https://openfontlicense.org/))。
  - Aseprite シート変換: DotGothic16 / IBM Plex Sans JP / JetBrains Mono
  - Keyout Sprite Packer: Zen Kaku Gothic New / JetBrains Mono
- サンプル素材: 出所とライセンスは [`samples/README.md`](samples/README.md) に記載します。
- Aseprite は [Igara Studio](https://www.aseprite.org/) の製品です。このリポジトリは Aseprite の公式ツールではありません。

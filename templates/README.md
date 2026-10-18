# ツールテンプレート

新規ツールの土台であり、既存ツールの見た目と挙動を揃えるための基準です。Vite でビルドする前提の 3 ファイルからなります。

| ファイル | コピー先 | 内容 |
|---|---|---|
| `tool-template.html` | `tools/<tool-name>.html` | マークアップ(共通ヘッダー・トーストつき)。共通 CSS とツール固有の CSS・`main.ts` を読み込む |
| `tool-template.ts` | `src/tools/<tool-name>/main.ts` | ツール固有のスクリプト。共通 JS は `import { IT } from "@common/it"` で使う |
| `tool-template.css` | `src/tools/<tool-name>/style.css` | ツール固有のスタイル |

外部 JS/CSS・Tailwind CDN・Web フォントは読み込みません(オフラインでもコンソール警告なしで動きます)。

## 新規ツールの作り方

1. 上の表のとおり 3 つのファイルをコピーし、HTML 内の `tool-name` をファイル名(英小文字ケバブケース)に置き換える。
2. `<title>` と、ヘッダー内の `<h1>`・説明文(`.hint`)を書き換える。表示名は日本語でよい。
3. HTML の本体と `main.ts`・`style.css` を、ツールの処理に置き換える。サンプル実装(画像を横に並べて PNG/JSON で保存)は、共通部品の使い方の例として残してある。
   画像処理などの DOM に触れない処理は、`src/tools/<tool-name>/` の別ファイルに純粋な関数として分ける(例: `src/tools/pixel-upscaler/upscale.ts`)。
4. HTML の `theme-init`・`header`・`toast` ブロックは**原則そのまま**使う。足りないユーティリティクラスはツール固有のスタイル側に書き足す(共通化したほうがよいものは `src/common/style.css` に足す)。
5. `npm run dev` で開き、コンソールにエラー・警告が出ないこと、ライト/ダーク切替・ドロップ・保存が動くことを確認する。`npm run build` で型チェックも通す。
6. ルートの `index.html`(ツール一覧)と `README.md` にツールを追記する。

## 共通部品

| 部品 | 場所 | 内容 |
|---|---|---|
| `theme-init` | 各 HTML の `<head>` の `<script>` | 描画前に保存済みテーマ(`data-theme`)を反映し、ちらつきを防ぐ(読み込みを待たないようインラインのまま) |
| テーマ変数 | `src/common/style.css` | テーマ用 CSS 変数。`prefers-color-scheme` と `:root[data-theme]` の両対応 |
| base | `src/common/style.css` | リセット、`body`・`.wrap`(16px ガター、セーフエリア対応)など |
| utilities | `src/common/style.css` | Tailwind 互換の最小ユーティリティ(`flex`, `gap-2`, `text-sm` など) |
| components | `src/common/style.css` | daisyUI 風の `btn` / `select` / `input` / `range` / `panel` / `badge` / `join` / `drop` / `stage` / `toast` など |
| ヘッダー | 各 HTML の `header` ブロック / `src/common/style.css` | 共通ヘッダー(ツール一覧 `../index.html` へのリンク、ツール名、テーマ切替ボタン) |
| トースト | 各 HTML の `toast` ブロック | トースト表示用の要素 |
| 共通 JS(`IT`) | `src/common/it.ts` | 下の表の API。`import { IT } from "@common/it"` |

### テーマ変数

既存 2 ツールの変数名を踏襲しています。

| 変数 | 用途 | 別名 |
|---|---|---|
| `--bg` | ページ背景 | |
| `--panel` | パネル・カード背景 | `--surface` |
| `--surface-2` | ホバー等の一段濃い面 | |
| `--line` | 罫線 | |
| `--fg` / `--muted` | 本文 / 補足テキスト | |
| `--accent` / `--accent-fg` / `--accent-soft` | 強調色 / その上の文字色 / 淡い強調背景 | |
| `--warn` / `--danger` | 注意 / エラー | |
| `--chk-a` / `--chk-b` | 透過プレビューの市松模様 | `--checker-a` / `--checker-b` |
| `--font-body` / `--font-mono` | 本文 / 等幅フォント | |

テーマの状態は `<html data-theme="light|dark">`(属性なし = OS 設定に従う)で表し、
`localStorage` の `imagetools:theme` に文字列で保存します(全ツール共通、別タブの変更にも追従)。
`IT.store` は JSON で保存するため、テーマの読み書きには使わず `IT.getTheme` / `IT.applyTheme` を使ってください。

### 共通 JS(`IT`)

| API | 説明 |
|---|---|
| `IT.saveFile(filename, data)` | 通常ブラウザでは、Chrome・Edge なら保存先フォルダ(ヘッダーの「保存先」で設定。IndexedDB に記憶し全ツール共通)へ直接書き込み、未設定なら保存ダイアログを最後に読み込んだファイルのフォルダで開く(`src/common/save.ts`)。その API が無いブラウザ(Firefox・Safari)やダイアログを出せないときは `<a download>`。`window.claude.use('downloads')` が使えるアーティファクト内ではそれで保存。結果はトーストで通知し、保存できたかを `Promise<boolean>` で返す。`data` は `Blob` / 文字列など |
| `IT.canvasToBlob(canvas, type?)` | canvas を `Blob` に変換(`saveFile` と組み合わせて PNG 保存) |
| `IT.initDrop({ zone, input, accept, onFiles, emptyMessage })` | ページ全体でドロップを受け付け、ドロップ中は `zone` に `.over` を付ける。`input`(`<input type=file>`)の選択も同じ `onFiles` に流す。Chrome・Edge では `input` のクリックを専用のファイル選択ダイアログに切り替え、ドロップと合わせて読み込んだファイルのハンドルを覚える(保存ダイアログを同じフォルダで開くため) |
| `IT.toast(msg, ms?)` | 画面下にトーストを表示 |
| `IT.store.get(key, fallback)` / `set(key, value)` / `remove(key)` | `localStorage` の安全な読み書き(try/catch 済み、JSON で保存)。キーには自動で `imagetools:` が付く |
| `IT.openIn(tool, files)` | ツール間の受け渡し(送る側)。`tools/<tool>.html#handoff` を新しいタブで開き、準備できた合図が来たら `files`(`File[]`、またはその `Promise`)を `postMessage` で渡す。タブはクリックの中で開くので、画像の用意は `Promise` で渡す(待ってから開くとポップアップとして止められる) |
| `IT.receive(onFiles, onFail?)` | ツール間の受け渡し(受ける側)。起動時に呼ぶ。`#handoff` 付きで開かれていれば待ち受けて `true` を返し、届いた `File[]` を `onFiles`(ドロップと同じ処理を渡す)へ。届かなければ `onFail`。`true` のときはサンプルの自動読込などを省く |
| `IT.applyTheme(theme)` / `IT.getTheme()` | テーマの変更・取得(`theme` は `auto` / `light` / `dark`)。テーマは `IT.store` ではなくこちらで扱う |

ツール固有の設定を保存するときは、キーを `"<tool-name>:<設定名>"` のようにツール名で区切ってください。

## 共通部品の更新手順

1. `src/common/style.css` か `src/common/it.ts` を直す。全ツールにこれだけで反映される。
2. `npm run build` のあと `uv run pytest` を実行する。どのツールも共通 JS をコピーで持たず `@common/it` を使っているかもテストで確かめている(`test_tool_linkage.py`)。

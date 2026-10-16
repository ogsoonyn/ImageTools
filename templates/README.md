# ツールテンプレート

`tool-template.html` は新規ツールの土台であり、既存ツールの見た目と挙動を揃えるための基準です。
単一 HTML で完結し、外部 JS/CSS・Tailwind CDN・Web フォントを読み込みません(オフラインでもコンソール警告なしで動きます)。

## 新規ツールの作り方

1. `tool-template.html` を `tools/<tool-name>.html` にコピーする(ファイル名は英小文字ケバブケース)。
2. `<title>` と、ヘッダー内の `<h1>`・説明文(`.hint`)を書き換える。表示名は日本語でよい。
3. 「ここから下はツール固有」と書かれた部分(スタイル・本体の HTML・最後の `<script>`)を、ツールの処理に置き換える。
   サンプル実装(画像を横に並べて PNG/JSON で保存)は、共通部品の使い方の例として残してある。
4. `common:begin` 〜 `common:end` で囲まれたブロックは**原則そのまま**使う。足りないユーティリティクラスは
   ツール固有のスタイル側に書き足す(共通化したほうがよいものは、後述の手順でテンプレートに戻す)。
5. ブラウザで直接開き、コンソールにエラー・警告が出ないこと、ライト/ダーク切替・ドロップ・保存が動くことを確認する。
6. ルートの `index.html`(ツール一覧)と `README.md` にツールを追記する。

## 共通ブロック

| ブロック名 | 場所 | 内容 |
|---|---|---|
| `theme-init` | `<head>` の `<script>` | 描画前に保存済みテーマ(`data-theme`)を反映し、ちらつきを防ぐ |
| `theme-vars` | `<style>` | テーマ用 CSS 変数。`prefers-color-scheme` と `:root[data-theme]` の両対応 |
| `base` | `<style>` | リセット、`body`・`.wrap`(16px ガター、セーフエリア対応)など |
| `utilities` | `<style>` | Tailwind 互換の最小ユーティリティ(`flex`, `gap-2`, `text-sm` など) |
| `components` | `<style>` | daisyUI 風の `btn` / `select` / `input` / `range` / `panel` / `badge` / `join` / `drop` / `stage` / `toast` など |
| `header-style` / `header` | `<style>` / 本体 | 共通ヘッダー(ツール一覧 `../index.html` へのリンク、ツール名、テーマ切替ボタン) |
| `toast` | 本体 | トースト表示用の要素 |
| `common-js` | `<script>` | 共通 JS。グローバル `IT` を公開する |

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
`localStorage` の `imagetools:theme` に文字列で保存します(全ツール共通)。

### 共通 JS(`IT`)

| API | 説明 |
|---|---|
| `IT.saveFile(filename, data)` | `window.claude.use('downloads')` が使えればそれで保存、無ければ `<a download>`。`data` は `Blob` / 文字列など |
| `IT.canvasToBlob(canvas, type?)` | canvas を `Blob` に変換(`saveFile` と組み合わせて PNG 保存) |
| `IT.initDrop({ zone, input, accept, onFiles, emptyMessage })` | ページ全体でドロップを受け付け、ドロップ中は `zone` に `.over` を付ける。`input`(`<input type=file>`)の選択も同じ `onFiles` に流す |
| `IT.toast(msg, ms?)` | 画面下にトーストを表示 |
| `IT.store.get(key, fallback)` / `set(key, value)` / `remove(key)` | `localStorage` の安全な読み書き(try/catch 済み、JSON で保存)。キーには自動で `imagetools:` が付く |
| `IT.applyTheme('auto'|'light'|'dark')` / `IT.getTheme()` | テーマの変更・取得 |

ツール固有の設定を保存するときは、キーを `"<tool-name>:<設定名>"` のようにツール名で区切ってください。

## 共通ブロックの更新手順

1. まず `templates/tool-template.html` の該当ブロックを修正し、テンプレート単体で動作確認する。
2. `tools/` 配下の各ツールで、同じ名前の `common:begin xxx` 〜 `common:end xxx` の中身を差し替える。
   ```sh
   grep -n "common:begin" tools/*.html   # どのツールがどのブロックを持っているか確認
   ```
3. ブロックの名前や境界コメントは変えない(変える場合は全ツールを同じ PR でそろえる)。
4. 1 つの PR でテンプレートと全ツールを更新し、各ツールをブラウザで開いて確認する。

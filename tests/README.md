# スモークテスト

`index.html` と `tools/*.html` をすべてブラウザ(Chromium)で開き、次を確認します。

- コンソールに error / warning が出ないこと、ページ例外が起きないこと
- 各ツールで「サンプルを読み込む」を押して `samples/` のサンプルを読み込み、「PNGを保存」「JSONを保存」で中身のある PNG / JSON がダウンロードされること
- アイコン一括生成の ZIP に各プリセットのファイル(ICO・PNG・site.webmanifest・Contents.json)が入ること、設定が保存・復元され「設定をリセット」で初期値に戻ること(`test_icon_generator.py`)
- スプライトシート作成で、貼り付けた画像がコマとして順に追加されること、まとめて入れた画像がファイル名の自然順に並ぶこと、変化のある範囲の検出・背景の透過(キーカラー・輝度をアルファに)・位置揃え・コマごとの微調整・4の倍数/2の累乗が効くこと、名前の `_列x行` から1枚のシートとして透過だけ行えること、旧キー抜きツールの URL から来たときにマゼンタのキーカラーで始まること、設定が保存・復元され「設定をリセット」で初期値に戻ること(`test_sprite_sheet_maker.py`)
- 統合した旧ツールの URL(`tools/keyout-sprite-packer.html` など)が、クエリとハッシュを引き継いで新しいツールへ移ること(`test_redirects.py`。移すだけのページは他のテストの対象から外す)
- ドット絵拡大ツールで、拡大のしかたと倍率ごとに出力の大きさ・色数が正しいこと、「輪郭を細く」で輪郭が指定の太さ(1ドット・2ドット)になること、コマ単位の拡大で境目をまたいで色が回り込まないこと、設定が保存・復元され「設定をリセット」で初期値に戻ること(`test_pixel_upscaler.py`)
- ドット絵 中割りツールで、サンプルのキー絵3枚から区間ごとの枚数どおりに中割りができ、キー絵にない色が出ないこと、手直ししたコマに印が付き作り直すときに残すか選べること、PNG / GIF / APNG が書き出せて読み直すと絵が一致すること、設定が保存・復元され「設定をリセット」で初期値に戻ること(`test_pixel_inbetween.py`)
- シート仕上げで、サンプルが行ごとのアクションに分かれて読み込まれること、並べ替え・ずらし・揃え・ドット修正と元に戻すが効くこと、オニオンスキンがアクション内でループすること、表情差分の行の書き出し・フィルタの「色を増やさない」・セルの大きさ変更・作業の保存と読み直しが正しいこと、設定が保存・復元され「設定をリセット」で初期値に戻ること(`test_sprite_polish.py`)
- ツール間の受け渡しで、シートを作る3つのツールの「仕上げツールで開く」から開いたシート仕上げツールに、保存した場合と同じシート(ファイル名・コマ数・アクション)が入ること。`file://` で直接開いた場合も渡せること。共通 JS がテンプレートと全ツールで同じであること。シート仕上げから拡大・中割りへ、中割りから仕上げへ渡せること、拡大ツールがファイル名の列x行でコマごとに拡大して保存名に列x行を残すこと、中割りツールが名前の列x行でシートを分割すること(`test_tool_linkage.py`)

Google Fonts へのリクエストはテスト内で空の応答に差し替えています(外部CDNの一時的な不調でテストが落ちないように)。サンプルは `fetch` で読み込むため、`file://` ではなく HTTP 経由で開く必要があります。

テストはリポジトリのルートを一時的な静的サーバー(`http://127.0.0.1:<空きポート>`)で配信してから開くので、サーバーを手で立てる必要はありません。PR ごとに GitHub Actions(`.github/workflows/smoke.yml`)でも同じテストが走ります。

## 準備

[uv](https://docs.astral.sh/uv/) を使います。

### Ubuntu

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # uv が未導入の場合
uv sync
uv run playwright install --with-deps chromium     # 初回のみ(--with-deps は sudo を求めます)
```

### Windows (PowerShell)

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"  # uv が未導入の場合
uv sync
uv run playwright install chromium                 # 初回のみ
```

## 実行

Ubuntu / Windows 共通です。

```bash
uv run pytest            # すべて
uv run pytest -v -k sprite_sheet   # 名前で絞り込み
```

### 手元で立てたサーバーに対して実行する

ブラウザで目視確認しながら同じページをテストしたいときは、別のターミナルで静的サーバーを立て、`BASE_URL` で指定します。

```bash
# ターミナル1(リポジトリのルートで)
uv run python -m http.server 8000

# ターミナル2 — Ubuntu
BASE_URL=http://localhost:8000 uv run pytest
```

```powershell
# ターミナル2 — Windows (PowerShell)
$env:BASE_URL = "http://localhost:8000"; uv run pytest
Remove-Item Env:BASE_URL   # 後続の実行に残らないよう戻す
```

> `python -m http.server` は `<meta charset>` のないページを UTF-8 として返さないことがあり、文字化けしてボタンが見つからずテストが失敗する場合があります。その場合は `BASE_URL` を付けずに実行してください(テスト内蔵のサーバーは GitHub Pages と同じく `charset=utf-8` を付けて返します)。

### 既存の Chromium を使う

`playwright install` の代わりに、インストール済みの Chromium を `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で指定できます。

```bash
# Ubuntu
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium uv run pytest
```

```powershell
# Windows (PowerShell)
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE = "C:\Program Files\Google\Chrome\Application\chrome.exe"; uv run pytest
Remove-Item Env:PLAYWRIGHT_CHROMIUM_EXECUTABLE
```

## 許容している警告

`tests/test_smoke.py` の `ALLOWED_CONSOLE` に、既知で対応予定の警告を正規表現で登録しています。対応する Issue が片付いたら削除してください。

| パターン | 理由 | 削除のタイミング |
| --- | --- | --- |
| `cdn.tailwindcss.com should not be used in production` | Aseprite Sheet Converter が Tailwind Play CDN を使っている | #6 のマージ後 |

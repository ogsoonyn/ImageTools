# スモークテスト

`index.html` と `tools/*.html` をすべてブラウザ(Chromium)で開き、次を確認します。

- コンソールに error / warning が出ないこと、ページ例外が起きないこと
- サンプルを読み込んだ状態で「PNGを保存」「JSONを保存」を押すとダウンロードが発生すること

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
uv run pytest -v -k keyout   # 名前で絞り込み
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
```

> `python -m http.server` は `<meta charset>` のないページを UTF-8 として返さないことがあり、文字化けしてボタンが見つからずテストが失敗する場合があります。その場合は `BASE_URL` を付けずに実行してください(テスト内蔵のサーバーは GitHub Pages と同じく `charset=utf-8` を付けて返します)。

### 既存の Chromium を使う

`playwright install` の代わりに、インストール済みの Chromium を `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で指定できます。

## 許容している警告

`tests/test_smoke.py` の `ALLOWED_CONSOLE` に、既知で対応予定の警告を正規表現で登録しています。対応する Issue が片付いたら削除してください。

| パターン | 理由 | 削除のタイミング |
| --- | --- | --- |
| `cdn.tailwindcss.com should not be used in production` | Aseprite Sheet Converter が Tailwind Play CDN を使っている | #6 のマージ後 |

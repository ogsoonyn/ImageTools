"""ツール間の受け渡し(「仕上げツールで開く」)の確認。

シートを作るツールでサンプルを読み込み、「仕上げツールで開く」で開いた新しいタブのシート仕上げツールに、
保存した場合と同じシート(ファイル名・コマ数・アクション)が入っていることを確かめる。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from playwright.sync_api import Browser, ConsoleMessage, Page, expect

from conftest import ROOT, SITE, is_redirect

SENDERS = [
    "tools/aseprite-sheet-converter.html",
    "tools/sprite-sheet-maker.html",
    "tools/frame-sorter.html",
]
OPEN_POLISH = "仕上げツールで開く"


def _watch(page: Page, problems: list[str]) -> None:
    def on_console(msg: ConsoleMessage) -> None:
        if msg.type in ("error", "warning") and not msg.location.get("url", "").endswith("/favicon.ico"):
            problems.append(f"console.{msg.type}: {msg.text} ({msg.location.get('url', '')})")

    page.on("console", on_console)
    page.on("pageerror", lambda err: problems.append(f"pageerror: {err}"))


def _new_context(browser: Browser):
    context = browser.new_context(accept_downloads=True)
    context.route(re.compile(r"^https://fonts\.googleapis\.com/"), lambda r: r.fulfill(status=200, content_type="text/css", body=""))
    context.route(re.compile(r"^https://fonts\.gstatic\.com/"), lambda r: r.abort())
    return context


def _load_sample(page: Page) -> None:
    load = page.get_by_role("button", name="サンプルを読み込む", exact=True)
    load.click()
    expect(load).to_be_enabled(timeout=10_000)


def _saved(page: Page, label: str) -> tuple[str, bytes]:
    with page.expect_download(timeout=10_000) as info:
        page.get_by_role("button", name=label, exact=True).first.click()
    d = info.value
    return d.suggested_filename, Path(d.path()).read_bytes()


def _open_polish(page: Page, problems: list[str] | None = None) -> Page:
    if problems is not None:
        # 受け取りの途中で出たエラーも拾えるよう、タブが開いた時点から見る
        page.context.on("page", lambda p: _watch(p, problems))
    with page.context.expect_page(timeout=10_000) as info:
        page.get_by_role("button", name=OPEN_POLISH, exact=True).click()
    polish = info.value
    # サンプルではなく渡されたシートが入るまで待つ
    polish.wait_for_function("typeof doc !== 'undefined' && doc && !isSample", timeout=15_000)
    return polish


@pytest.mark.parametrize("path", SENDERS)
def test_open_in_polish(browser: Browser, base_url: str, path: str):
    context = _new_context(browser)
    try:
        page = context.new_page()
        problems: list[str] = []
        _watch(page, problems)
        page.goto(f"{base_url}/{path}", wait_until="load")
        _load_sample(page)
        png_name, _ = _saved(page, "PNGを保存")

        polish = _open_polish(page, problems)
        assert polish.url.endswith("/tools/sprite-polish.html"), "受け取った後は #handoff を消す"
        assert polish.evaluate("doc.name") == png_name
        assert polish.evaluate("doc.frames.length") > 0
        assert polish.evaluate("actions()"), "アクションが空"
        assert problems == [], "\n".join(problems)
    finally:
        context.close()


def test_open_in_polish_from_file_url(browser: Browser):
    """ローカルの HTML を直接開いた(file://)ときも渡せること。"""
    context = _new_context(browser)
    try:
        page = context.new_page()
        page.goto((SITE / "tools/frame-sorter.html").as_uri(), wait_until="load")
        _load_sample(page)
        polish = _open_polish(page)
        assert polish.evaluate("doc.frames.length") > 0
    finally:
        context.close()


def test_open_in_polish_matches_saved_json(browser: Browser, base_url: str):
    """コマ整列ツールの例で、保存した JSON(Array 形式)と仕上げツールに入ったコマ数・アクションが一致すること。"""
    context = _new_context(browser)
    try:
        page = context.new_page()
        page.goto(f"{base_url}/tools/frame-sorter.html", wait_until="load")
        _load_sample(page)
        page.select_option("#jsonFormat", "array")
        _, data = _saved(page, "JSONを保存")
        saved = json.loads(data)
        polish = _open_polish(page)
        assert polish.evaluate("doc.frames.length") == len(saved["frames"])
        assert polish.evaluate("actions()") == [t["name"] for t in saved["meta"]["frameTags"]]
    finally:
        context.close()


def test_polish_without_handoff_loads_sample(browser: Browser, base_url: str):
    """#handoff 付きでも、開いた元のタブが無ければいつもどおりサンプルを読む。"""
    context = _new_context(browser)
    try:
        page = context.new_page()
        page.goto(f"{base_url}/tools/sprite-polish.html#handoff", wait_until="load")
        page.wait_for_function("typeof doc !== 'undefined' && doc && isSample", timeout=10_000)
    finally:
        context.close()


def test_common_js_is_identical():
    """共通 JS(受け渡しを含む)はテンプレートと全ツールで同じであること。"""
    block = re.compile(r"<!-- common:begin common-js -->.*?<!-- common:end common-js -->", re.S)
    # 旧 URL を移すだけのページは共通部品を持たない
    files = [ROOT / "templates/tool-template.html", *sorted(p for p in (ROOT / "tools").glob("*.html") if not is_redirect(p))]
    blocks = {f.name: block.search(f.read_text(encoding="utf-8")).group(0) for f in files}
    base = blocks["tool-template.html"]
    assert "openIn" in base and "receive" in base
    assert [n for n, b in blocks.items() if b != base] == []


def _open_tool(browser: Browser, base_url: str, path: str, ready: str):
    context = _new_context(browser)
    page = context.new_page()
    problems: list[str] = []
    _watch(page, problems)
    page.goto(f"{base_url}/{path}", wait_until="load")
    page.wait_for_function(ready, timeout=10_000)
    return context, page, problems


def _popup(page: Page, label: str, problems: list[str]) -> Page:
    page.context.on("page", lambda p: _watch(p, problems))
    with page.context.expect_page(timeout=10_000) as info:
        page.get_by_role("button", name=label, exact=True).click()
    return info.value


def test_polish_to_upscaler(browser: Browser, base_url: str):
    """仕上げ → 拡大: シート全体が渡り、ファイル名の列x行でコマごとの拡大になり、保存名にも列x行が残る。"""
    context, page, problems = _open_tool(browser, base_url, "tools/sprite-polish.html", "typeof doc !== 'undefined' && doc && isSample")
    try:
        cols, rows = page.evaluate("(() => { const l = layoutOf(exportSets()[0]); return [l.cols, l.rows]; })()")
        name = page.evaluate("pngName()")
        up = _popup(page, "拡大ツールで開く", problems)
        up.wait_for_function("state.name !== 'sample'", timeout=15_000)
        assert up.evaluate("state.name") == name.removesuffix(".png")
        assert up.evaluate("[state.frame.on, state.frame.cols, state.frame.rows]") == [True, cols, rows]
        up.wait_for_function("document.getElementById('busy').hidden && state.results[0]", timeout=15_000)
        saved, data = _saved(up, "PNGを保存")
        assert saved.endswith(f"_{cols}x{rows}.png"), saved
        assert data.startswith(b"\x89PNG")
        assert problems == [], "\n".join(problems)
    finally:
        context.close()


def test_polish_to_inbetween(browser: Browser, base_url: str):
    """仕上げ → 中割り: 選んだコマのアクションのコマがキー絵として順に入る。"""
    context, page, problems = _open_tool(browser, base_url, "tools/sprite-polish.html", "typeof doc !== 'undefined' && doc && isSample")
    try:
        act, n = page.evaluate("(() => { const a = doc.frames[cur].tag; return [a, doc.frames.filter((f) => f.tag === a).length]; })()")
        ib = _popup(page, "中割りツールで開く", problems)
        ib.wait_for_function("S.baseName !== 'sample_slime'", timeout=15_000)
        assert ib.evaluate("S.keys.length") == n
        names = ib.evaluate("S.keys.map((k) => k.name)")
        assert names == sorted(names) and names[0].endswith("_" + "1".zfill(len(str(n))))
        assert act in ib.evaluate("S.baseName")
        assert problems == [], "\n".join(problems)
    finally:
        context.close()


def test_inbetween_to_polish(browser: Browser, base_url: str):
    """中割り → 仕上げ: できたコマが1アクションとして、表示時間つきで入る。"""
    context, page, problems = _open_tool(browser, base_url, "tools/pixel-inbetween.html", "S.frames.length > 0")
    try:
        page.wait_for_function("!document.getElementById('btnPolish').disabled", timeout=10_000)
        n, base, key_ms = page.evaluate("[S.frames.length, S.baseName, P.keyMs]")
        polish = _popup(page, "仕上げツールで開く", problems)
        polish.wait_for_function("typeof doc !== 'undefined' && doc && !isSample", timeout=15_000)
        assert polish.evaluate("doc.frames.length") == n
        assert polish.evaluate("actions()") == [base]
        assert polish.evaluate("doc.frames[0].dur") == key_ms
        assert problems == [], "\n".join(problems)
    finally:
        context.close()


def test_inbetween_splits_sheet_by_file_name(browser: Browser, base_url: str):
    """中割り: 1枚だけ読んだ画像の名前の最後に列x行があれば、その数で分割する。"""
    context, page, problems = _open_tool(browser, base_url, "tools/pixel-inbetween.html", "S.frames.length > 0")
    try:
        page.evaluate("""async () => {
            const c = document.createElement('canvas'); c.width = 48; c.height = 16;
            const x = c.getContext('2d'); x.fillStyle = '#c33';
            for (let i = 0; i < 3; i++) x.fillRect(i * 16 + 4, 4 + i, 8, 8);
            const b = await IT.canvasToBlob(c);
            await loadFiles([new File([b], 'walk_3x1.png', { type: 'image/png' })], false);
        }""")
        assert page.evaluate("[S.keys.length, S.W, S.H, S.baseName]") == [3, 16, 16, "walk"]
        # 分割は名前を読んだその1枚だけ。あとから読む名前に列x行の無い1枚絵は切らない
        assert page.evaluate("document.getElementById('splitOn').checked") is False
        page.evaluate("""async () => {
            const c = document.createElement('canvas'); c.width = 48; c.height = 16;
            c.getContext('2d').fillRect(2, 2, 40, 10);
            await loadFiles([new File([await IT.canvasToBlob(c)], 'hero.png', { type: 'image/png' })], false);
        }""")
        assert page.evaluate("[S.keys.length, S.W, S.H]") == [1, 48, 16]
        # コマの大きさを表す名前(割ると 1 コマが小さすぎる)は分割数として読まない
        assert page.evaluate("[gridOfName('tree_32x32.png', 32, 32), gridOfName('a_3x1_v2.png', 48, 16), gridOfName('a_3x1.png', 48, 16)]") == [None, None, [3, 1]]
        assert problems == [], "\n".join(problems)
    finally:
        context.close()

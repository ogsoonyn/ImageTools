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

from conftest import ROOT

SENDERS = [
    "tools/aseprite-sheet-converter.html",
    "tools/keyout-sprite-packer.html",
    "tools/screenshot-sprite-sheet.html",
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


def _open_polish(page: Page) -> Page:
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

        polish = _open_polish(page)
        _watch(polish, problems)
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
        page.goto((ROOT / "tools/frame-sorter.html").as_uri(), wait_until="load")
        _load_sample(page)
        polish = _open_polish(page)
        assert polish.evaluate("doc.frames.length") > 0
    finally:
        context.close()


def test_open_in_polish_matches_saved_json(browser: Browser, base_url: str):
    """コマ整列ツールの例で、保存した JSON(Hash 形式)と仕上げツールに入ったコマ数・アクションが一致すること。"""
    context = _new_context(browser)
    try:
        page = context.new_page()
        page.goto(f"{base_url}/tools/frame-sorter.html", wait_until="load")
        _load_sample(page)
        page.select_option("#jsonFormat", "hash")
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
    files = [ROOT / "templates/tool-template.html", *sorted((ROOT / "tools").glob("*.html"))]
    blocks = {f.name: block.search(f.read_text(encoding="utf-8")).group(0) for f in files}
    base = blocks["tool-template.html"]
    assert "openIn" in base and "receive" in base
    assert [n for n, b in blocks.items() if b != base] == []

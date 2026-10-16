"""全ページを開き、コンソールの error/warning とページ例外が出ないことを確認する。

サンプルを読み込んだ状態で PNG/JSON の保存ボタンを押し、ダウンロードが発生することも確認する。
"""

from __future__ import annotations

import re

import pytest
from playwright.sync_api import Browser, ConsoleMessage, Page

from conftest import discover_pages

PAGES = discover_pages()

# 既知の警告。該当Issueが片付いたら削除する。
ALLOWED_CONSOLE = [
    # Tailwind Play CDN が出す本番利用警告(#6 で CDN を撤去するまで許容)
    re.compile(r"cdn\.tailwindcss\.com should not be used in production"),
]

# 保存ボタンのラベル(ID はツールごとに異なるので表示テキストで探す)
SAVE_BUTTONS = {"png": "PNGを保存", "json": "JSONを保存"}


def _allowed(msg: ConsoleMessage) -> bool:
    # ブラウザが自動で取りに行く favicon.ico の 404 はページの不具合ではないので無視する
    if msg.location.get("url", "").endswith("/favicon.ico"):
        return True
    return any(p.search(msg.text) for p in ALLOWED_CONSOLE)


def _open(browser: Browser, url: str) -> tuple[Page, list[str]]:
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    problems: list[str] = []

    def on_console(msg: ConsoleMessage) -> None:
        if msg.type in ("error", "warning") and not _allowed(msg):
            problems.append(f"console.{msg.type}: {msg.text} ({msg.location.get('url', '')})")

    page.on("console", on_console)
    page.on("pageerror", lambda err: problems.append(f"pageerror: {err}"))
    page.goto(url, wait_until="load")
    page.wait_for_load_state("networkidle")
    return page, problems


def test_pages_found():
    assert any(p.startswith("tools/") for p in PAGES), "tools/*.html が見つからない"


@pytest.mark.parametrize("path", PAGES)
def test_page_opens_without_errors(browser: Browser, base_url: str, path: str):
    page, problems = _open(browser, f"{base_url}/{path}")
    try:
        assert problems == [], "\n".join(problems)
    finally:
        page.context.close()


TOOL_PAGES = [p for p in PAGES if p.startswith("tools/")]


@pytest.mark.parametrize("kind", SAVE_BUTTONS)
@pytest.mark.parametrize("path", TOOL_PAGES)
def test_save_button_downloads(browser: Browser, base_url: str, path: str, kind: str):
    page, problems = _open(browser, f"{base_url}/{path}")
    try:
        button = page.get_by_role("button", name=SAVE_BUTTONS[kind], exact=True)
        if button.count() == 0:
            pytest.skip(f"{path} に「{SAVE_BUTTONS[kind]}」ボタンがない")
        with page.expect_download(timeout=10_000) as info:
            button.first.click()
        download = info.value
        assert download.suggested_filename.lower().endswith(f".{kind}"), download.suggested_filename
        assert download.failure() is None
        assert problems == [], "\n".join(problems)
    finally:
        page.context.close()

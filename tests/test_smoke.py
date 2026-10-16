"""全ページを開き、コンソールの error/warning とページ例外が出ないことを確認する。

ツールでは「サンプルを読み込む」でサンプル(samples/)を読み込んでから PNG/JSON の保存ボタンを押し、
中身のあるファイルがダウンロードされることも確認する。
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from playwright.sync_api import Browser, ConsoleMessage, Page, Route, expect

from conftest import discover_pages

PAGES = discover_pages()
TOOL_PAGES = [p for p in PAGES if p.startswith("tools/")]

# 既知の警告。該当Issueが片付いたら削除する。
ALLOWED_CONSOLE = [
    # Tailwind Play CDN が出す本番利用警告(#6 で CDN を撤去するまで許容)
    re.compile(r"cdn\.tailwindcss\.com should not be used in production"),
]

# ボタンのラベル(ID はツールごとに異なるので表示テキストで探す)
LOAD_SAMPLE_BUTTON = "サンプルを読み込む"
SAVE_BUTTONS = {"png": "PNGを保存", "json": "JSONを保存"}


def _allowed(msg: ConsoleMessage) -> bool:
    # ブラウザが自動で取りに行く favicon.ico の 404 はページの不具合ではないので無視する
    if msg.location.get("url", "").endswith("/favicon.ico"):
        return True
    return any(p.search(msg.text) for p in ALLOWED_CONSOLE)


def _stub_google_fonts(route: Route) -> None:
    # Webフォントは見た目だけなので、外部CDNの一時的な不調でテストが落ちないよう空のCSSを返す
    route.fulfill(status=200, content_type="text/css", body="")


@contextmanager
def _open(browser: Browser, url: str) -> Iterator[tuple[Page, list[str]]]:
    context = browser.new_context(accept_downloads=True)
    try:
        context.route(re.compile(r"^https://fonts\.googleapis\.com/"), _stub_google_fonts)
        context.route(re.compile(r"^https://fonts\.gstatic\.com/"), lambda route: route.abort())
        page = context.new_page()
        problems: list[str] = []

        def on_console(msg: ConsoleMessage) -> None:
            if msg.type in ("error", "warning") and not _allowed(msg):
                problems.append(f"console.{msg.type}: {msg.text} ({msg.location.get('url', '')})")

        page.on("console", on_console)
        page.on("pageerror", lambda err: problems.append(f"pageerror: {err}"))
        page.goto(url, wait_until="load")
        yield page, problems
    finally:
        context.close()


def test_pages_found():
    assert any(p.startswith("tools/") for p in PAGES), "tools/*.html が見つからない"


@pytest.mark.parametrize("path", PAGES)
def test_page_opens_without_errors(browser: Browser, base_url: str, path: str):
    with _open(browser, f"{base_url}/{path}") as (page, problems):
        # 起動直後の非同期処理で出るエラーも拾えるよう、少し待ってから確認する
        page.wait_for_timeout(500)
        assert problems == [], "\n".join(problems)


@pytest.mark.parametrize("kind", SAVE_BUTTONS)
@pytest.mark.parametrize("path", TOOL_PAGES)
def test_save_button_downloads(browser: Browser, base_url: str, path: str, kind: str):
    with _open(browser, f"{base_url}/{path}") as (page, problems):
        save = page.get_by_role("button", name=SAVE_BUTTONS[kind], exact=True)
        if save.count() == 0:
            pytest.skip(f"{path} に「{SAVE_BUTTONS[kind]}」ボタンがない")

        # サンプルを読み込む。読み込みに成功するとボタンが再び有効になる(失敗時は無効のまま)
        load = page.get_by_role("button", name=LOAD_SAMPLE_BUTTON, exact=True)
        expect(load, f"{path} に「{LOAD_SAMPLE_BUTTON}」ボタンがない").to_have_count(1)
        load.click()
        expect(load).to_be_enabled(timeout=10_000)

        with page.expect_download(timeout=10_000) as info:
            save.first.click()
        download = info.value
        assert download.failure() is None
        assert download.suggested_filename.lower().endswith(f".{kind}"), download.suggested_filename
        data = Path(download.path()).read_bytes()
        if kind == "png":
            assert data.startswith(b"\x89PNG\r\n\x1a\n"), "PNG として読めない"
        else:
            assert isinstance(json.loads(data), dict), "JSON のトップレベルがオブジェクトでない"
        assert problems == [], "\n".join(problems)

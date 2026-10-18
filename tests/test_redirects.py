"""統合したツールの旧 URL が新しいツールへ移ることを確認する。"""

from __future__ import annotations

import pytest
from playwright.sync_api import Browser, expect

from conftest import discover_redirects

REDIRECTS = {
    "tools/keyout-sprite-packer.html": "tools/sprite-sheet-maker.html?mode=keyout",
    "tools/screenshot-sprite-sheet.html": "tools/sprite-sheet-maker.html?mode=screenshot",
}


def test_redirect_pages_found():
    assert sorted(REDIRECTS) == discover_redirects()


@pytest.mark.parametrize("old", REDIRECTS)
def test_old_url_moves_to_new_tool(browser: Browser, base_url: str, old: str):
    page = browser.new_context().new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    try:
        # クエリとハッシュは引き継ぐ
        page.goto(f"{base_url}/{old}?x=1#top")
        expect(page).to_have_url(f"{base_url}/{REDIRECTS[old]}".replace("?", "?x=1&") + "#top")
        expect(page.locator("h1")).to_have_text("スプライトシート作成")
        assert errors == []
    finally:
        page.context.close()

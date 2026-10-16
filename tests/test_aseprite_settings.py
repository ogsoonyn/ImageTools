"""Aseprite シート変換: 設定が localStorage に保存され、リロード後に復元され、リセットで戻ることを確認する。"""

from __future__ import annotations

from playwright.sync_api import Browser, expect

PATH = "tools/aseprite-sheet-converter.html"


def test_settings_persist_and_reset(browser: Browser, base_url: str):
    context = browser.new_context()
    try:
        page = context.new_page()
        page.goto(f"{base_url}/{PATH}")

        page.get_by_role("button", name="グリッド", exact=True).click()
        page.locator("#scale").fill("3")
        page.locator("#border").fill("5")
        page.locator("#json-format").select_option("array")
        page.get_by_role("button", name="2×", exact=True).click()

        page.reload()
        expect(page.get_by_role("button", name="グリッド", exact=True)).to_have_class("btn btn-sm is-active")
        expect(page.locator("#cols-row")).to_be_visible()
        expect(page.locator("#scale")).to_have_value("3")
        expect(page.locator("#scale-val")).to_have_text("3×")
        expect(page.locator("#border")).to_have_value("5")
        expect(page.locator("#json-format")).to_have_value("array")
        expect(page.get_by_role("button", name="2×", exact=True)).to_have_class("btn btn-sm is-active")

        page.get_by_role("button", name="設定をリセット", exact=True).click()
        expect(page.locator("#scale")).to_have_value("1")
        expect(page.locator("#json-format")).to_have_value("hash")
        page.reload()
        expect(page.get_by_role("button", name="横一列", exact=True)).to_have_class("btn btn-sm is-active")
        expect(page.locator("#border")).to_have_value("0")
        expect(page.get_by_role("button", name="フィット", exact=True)).to_have_class("btn btn-sm is-active")
    finally:
        context.close()


def test_broken_settings_are_ignored(browser: Browser, base_url: str):
    context = browser.new_context()
    try:
        page = context.new_page()
        page.goto(f"{base_url}/{PATH}")
        page.evaluate(
            """() => {
              localStorage.setItem('imagetools:aseprite-sheet-converter:settings', '{"scale":99,"layout":"x","border":"a"');
            }"""
        )
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.reload()
        expect(page.locator("#scale")).to_have_value("1")
        expect(page.get_by_role("button", name="横一列", exact=True)).to_have_class("btn btn-sm is-active")
        assert errors == []
    finally:
        context.close()

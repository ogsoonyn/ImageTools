"""Keyout Sprite Packer の設定が localStorage に保存され、リロード後に復元されることを確認する(#11)。"""

from __future__ import annotations

import re

from playwright.sync_api import Browser, Page, expect

KEYOUT = "tools/keyout-sprite-packer.html"


def _new_page(browser: Browser, init_script: str | None = None) -> tuple[Page, list[str]]:
    context = browser.new_context()
    if init_script:
        context.add_init_script(init_script)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    return page, errors


def _stored(page: Page, tool: str):
    return page.evaluate(f"JSON.parse(localStorage.getItem('imagetools:{tool}:settings'))")


def test_keyout_settings_persist_and_reset(browser: Browser, base_url: str):
    page, errors = _new_page(browser)
    try:
        page.goto(f"{base_url}/{KEYOUT}")
        page.fill("#keyColor", "#00ff00")
        page.fill("#tol", "80")
        page.fill("#cols", "3")
        page.uncheck("#unblend")
        page.select_option("#jsonFormat", "array")
        page.fill("#fps", "24")
        page.click('[data-mode="lum"]')
        page.click('[data-bg="black"]')
        page.click('[data-blend="lighter"]')
        assert _stored(page, "keyout-sprite-packer")["tol"] == "80"

        page.reload()
        expect(page.locator("#keyColor")).to_have_value("#00ff00")
        expect(page.locator("#tol")).to_have_value("80")
        expect(page.locator("#tolV")).to_have_text("80")
        expect(page.locator("#cols")).to_have_value("3")
        expect(page.locator("#unblend")).not_to_be_checked()
        expect(page.locator("#jsonFormat")).to_have_value("array")
        expect(page.locator("#fps")).to_have_value("24")
        expect(page.locator('[data-mode="lum"]')).to_have_attribute("aria-pressed", "true")
        expect(page.locator("#lumOpts")).to_be_visible()
        expect(page.locator('[data-bg="black"]')).to_have_attribute("aria-pressed", "true")
        expect(page.locator("#sheetStage")).to_have_class(re.compile(r"\bbg-black\b"))
        expect(page.locator('[data-blend="lighter"]')).to_have_attribute("aria-pressed", "true")

        page.get_by_role("button", name="設定をリセット").click()
        expect(page.locator("#toast")).to_have_text("設定をリセットしました")
        expect(page.locator("#keyColor")).to_have_value("#ff00ff")
        expect(page.locator("#tol")).to_have_value("32")
        expect(page.locator("#cols")).to_have_value("0")
        expect(page.locator("#unblend")).to_be_checked()
        expect(page.locator("#jsonFormat")).to_have_value("native")
        expect(page.locator('[data-mode="key"]')).to_have_attribute("aria-pressed", "true")
        expect(page.locator('[data-bg="checker"]')).to_have_attribute("aria-pressed", "true")
        assert _stored(page, "keyout-sprite-packer") is None
        assert errors == []
    finally:
        page.context.close()


def test_broken_storage_does_not_break_tool(browser: Browser, base_url: str):
    # localStorage が使えない環境(プライベートモード等)や壊れた値でも、通常どおり動く
    script = """
      localStorage.setItem('imagetools:keyout-sprite-packer:settings', '{broken');
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    """
    page, errors = _new_page(browser, script)
    try:
        page.goto(f"{base_url}/{KEYOUT}")
        load = page.get_by_role("button", name="サンプルを読み込む", exact=True)
        load.click()
        expect(load).to_be_enabled(timeout=10_000)
        page.get_by_role("button", name="設定をリセット").click()
        assert errors == []
    finally:
        page.context.close()


def test_invalid_values_are_ignored(browser: Browser, base_url: str):
    # 範囲外・小数・存在しない選択肢は項目ごとに捨て、初期値のまま使う
    script = """
      localStorage.setItem('imagetools:keyout-sprite-packer:settings',
        JSON.stringify({tol: '999', cols: '2.5', pad: '3', jsonFormat: 'zzz', mode: 'nope', keyColor: 'red', unblend: 'no'}));
    """
    page, errors = _new_page(browser, script)
    try:
        page.goto(f"{base_url}/{KEYOUT}")
        expect(page.locator("#tol")).to_have_value("32")
        expect(page.locator("#cols")).to_have_value("0")
        expect(page.locator("#pad")).to_have_value("3")
        expect(page.locator("#jsonFormat")).to_have_value("native")
        expect(page.locator('[data-mode="key"]')).to_have_attribute("aria-pressed", "true")
        expect(page.locator("#keyColor")).to_have_value("#ff00ff")
        expect(page.locator("#unblend")).to_be_checked()
        assert errors == []
    finally:
        page.context.close()

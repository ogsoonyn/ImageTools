"""アイコン一括生成: ZIP の中身と、設定の保存・復元・リセットを確認する。"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from playwright.sync_api import Browser, expect

ICON = "tools/icon-generator.html"


def test_zip_contains_all_presets(browser: Browser, base_url: str):
    context = browser.new_context(accept_downloads=True)
    try:
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        page.goto(f"{base_url}/{ICON}")
        page.fill("#customSizes", "64, 300")
        load = page.get_by_role("button", name="サンプルを読み込む", exact=True)
        load.click()
        expect(load).to_be_enabled(timeout=10_000)
        zip_btn = page.get_by_role("button", name="ZIPで一括保存", exact=True)
        expect(zip_btn).to_be_enabled()
        with page.expect_download(timeout=10_000) as info:
            zip_btn.click()
        z = zipfile.ZipFile(io.BytesIO(Path(info.value.path()).read_bytes()))
        assert z.testzip() is None
        names = set(z.namelist())
        for name in [
            "web/favicon.ico", "web/apple-touch-icon.png", "web/android-chrome-512x512.png",
            "web/site.webmanifest", "web/head-snippet.html",
            "ios/AppIcon.appiconset/AppIcon-1024.png", "ios/AppIcon.appiconset/Contents.json",
            "android/res/mipmap-xxxhdpi/ic_launcher.png", "windows/app.ico",
            "custom/icon-64x64.png", "custom/icon-300x300.png",
        ]:
            assert name in names, name
        # ICO: ヘッダーの枚数と、先頭エントリの幅(16px)
        ico = z.read("web/favicon.ico")
        assert ico[:4] == b"\x00\x00\x01\x00" and int.from_bytes(ico[4:6], "little") == 3 and ico[6] == 16
        win = z.read("windows/app.ico")
        assert int.from_bytes(win[4:6], "little") == 7
        assert z.read("custom/icon-300x300.png").startswith(b"\x89PNG\r\n\x1a\n")
        manifest = json.loads(z.read("web/site.webmanifest"))
        assert {i["sizes"] for i in manifest["icons"]} == {"192x192", "512x512"}
        assert errors == []
    finally:
        context.close()


def test_settings_persist_and_reset(browser: Browser, base_url: str):
    context = browser.new_context()
    try:
        page = context.new_page()
        page.goto(f"{base_url}/{ICON}")
        page.uncheck("#preset-ios")
        page.fill("#customSizes", "128")
        page.get_by_role("button", name="ドット絵(ニアレスト)", exact=True).click()
        stored = page.evaluate("JSON.parse(localStorage.getItem('imagetools:icon-generator:settings'))")
        assert stored["presets"]["ios"] is False and stored["custom"] == "128" and stored["scale"] == "nearest"

        page.reload()
        expect(page.locator("#preset-ios")).not_to_be_checked()
        expect(page.locator("#customSizes")).to_have_value("128")
        expect(page.get_by_role("button", name="ドット絵(ニアレスト)", exact=True)).to_have_attribute("aria-pressed", "true")

        page.get_by_role("button", name="設定をリセット", exact=True).click()
        expect(page.locator("#preset-ios")).to_be_checked()
        expect(page.locator("#customSizes")).to_have_value("")
        assert page.evaluate("localStorage.getItem('imagetools:icon-generator:settings')") is None
    finally:
        context.close()

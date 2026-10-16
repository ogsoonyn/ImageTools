"""アイコン一括生成: ZIP の中身と、設定の保存・復元・リセットを確認する。"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from playwright.sync_api import Browser, expect

ICON = "tools/icon-generator.html"


def _png_color_type(data: bytes) -> int:
    assert data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR"
    return data[25]


def _ico_sizes(data: bytes) -> list[int]:
    """ICO のディレクトリを読み、各エントリが正しい位置の PNG を指していることを確かめてサイズを返す。"""
    assert data[:4] == b"\x00\x00\x01\x00"
    sizes = []
    for i in range(int.from_bytes(data[4:6], "little")):
        e = data[6 + 16 * i : 22 + 16 * i]
        length, offset = int.from_bytes(e[8:12], "little"), int.from_bytes(e[12:16], "little")
        png = data[offset : offset + length]
        assert len(png) == length and png.startswith(b"\x89PNG\r\n\x1a\n")
        size = e[0] or 256
        assert int.from_bytes(png[16:20], "big") == size
        sizes.append(size)
    return sizes


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
        assert _ico_sizes(z.read("web/favicon.ico")) == [16, 32, 48]
        assert _ico_sizes(z.read("windows/app.ico")) == [16, 24, 32, 48, 64, 128, 256]
        # 透過できない出力はアルファなしの RGB(カラータイプ 2)、それ以外は RGBA(6)
        assert _png_color_type(z.read("ios/AppIcon.appiconset/AppIcon-1024.png")) == 2
        assert _png_color_type(z.read("web/apple-touch-icon.png")) == 2
        assert _png_color_type(z.read("web/android-chrome-512x512.png")) == 6
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
        page.locator("#pad").evaluate("e => { e.value = 10; e.dispatchEvent(new Event('input')); }")
        stored = page.evaluate("JSON.parse(localStorage.getItem('imagetools:icon-generator:settings'))")
        assert stored["presets"]["ios"] is False and stored["custom"] == "128" and stored["scale"] == "nearest"

        page.reload()
        expect(page.locator("#preset-ios")).not_to_be_checked()
        expect(page.locator("#customSizes")).to_have_value("128")
        expect(page.locator("#pad")).to_have_value("10")
        expect(page.get_by_role("button", name="ドット絵(ニアレスト)", exact=True)).to_have_attribute("aria-pressed", "true")

        page.get_by_role("button", name="設定をリセット", exact=True).click()
        expect(page.locator("#preset-ios")).to_be_checked()
        expect(page.locator("#customSizes")).to_have_value("")
        expect(page.locator("#pad")).to_have_value("0")
        expect(page.get_by_role("button", name="なめらか", exact=True)).to_have_attribute("aria-pressed", "true")
        assert page.evaluate("localStorage.getItem('imagetools:icon-generator:settings')") is None
    finally:
        context.close()

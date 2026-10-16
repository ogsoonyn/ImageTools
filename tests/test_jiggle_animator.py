"""揺れものアニメーター: 動きが再生速度・枚数に左右されないこと、ドット絵で色が増えないこと、設定の保存とリセットを確認する。"""

from __future__ import annotations

import base64

from playwright.sync_api import Browser, Page, expect

JIGGLE = "tools/jiggle-animator.html"


def _open(browser: Browser, base_url: str) -> tuple[Page, list[str]]:
    page = browser.new_context().new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(f"{base_url}/{JIGGLE}")
    expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)
    return page, errors


def _set_range(page: Page, id_: str, value: int) -> None:
    page.evaluate(
        "([id, v]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); }",
        [id_, value],
    )


def _settle(page: Page, frames: int) -> None:
    # 設定変更は少し遅れて再計算されるので、枚数が反映されるまで待ってから一拍置く
    expect(page.locator("#simInfo")).to_contain_text(f"× {frames} フレーム")
    page.wait_for_timeout(300)


def _frame(page: Page, i: int) -> str:
    return page.evaluate("(i) => frames[i].toDataURL()", i)


def _load_sample(page: Page, kind: str) -> None:
    page.select_option("#sampleKind", kind)
    page.click("#btnSample")
    page.wait_for_timeout(300)


def test_motion_independent_of_fps_and_frame_count(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        for kind in ("pixel", "smooth"):
            _load_sample(page, kind)
            _set_range(page, "fps", 10)
            _set_range(page, "frames", 8)
            _settle(page, 8)
            a2, a5 = _frame(page, 2), _frame(page, 5)
            assert a2 != _frame(page, 0), "サンプルが動いていない"

            _set_range(page, "fps", 24)
            page.wait_for_timeout(400)
            assert _frame(page, 2) == a2, f"{kind}: 再生速度で動きが変わった"

            # 16 枚にすると 8 枚の i コマ目は 2i コマ目と同じ瞬間になる
            _set_range(page, "frames", 16)
            _settle(page, 16)
            assert _frame(page, 4) == a2, f"{kind}: 枚数で動きが変わった"
            assert _frame(page, 10) == a5, f"{kind}: 枚数で動きが変わった"
        assert errors == []
    finally:
        page.context.close()


def test_pixel_mode_adds_no_new_colors(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        _load_sample(page, "pixel")
        extra = page.evaluate(
            """() => {
              const key = (d, i) => d[i + 3] === 0 ? 'clear' : d[i] + ',' + d[i + 1] + ',' + d[i + 2] + ',' + d[i + 3];
              const pal = new Set();
              for (let i = 0; i < src.data.length; i += 4) pal.add(key(src.data, i));
              const c = document.getElementById('sheet');
              const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
              let n = 0;
              for (let i = 0; i < d.length; i += 4) if (!pal.has(key(d, i))) n++;
              return n;
            }"""
        )
        assert extra == 0, f"元画像にない色のピクセルが {extra} 個ある"
        assert errors == []
    finally:
        page.context.close()


def test_sample_button_hidden_after_loading_image(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        expect(page.locator("#btnSample")).to_be_visible()
        png = page.evaluate(
            "() => { const c = document.createElement('canvas'); c.width = c.height = 16;"
            " c.getContext('2d').fillRect(4, 4, 8, 8); return c.toDataURL().split(',')[1]; }"
        )
        page.set_input_files("#fileInput", files=[{"name": "dot.png", "mimeType": "image/png", "buffer": base64.b64decode(png)}])
        expect(page.locator("#srcNote")).to_contain_text("dot.png")
        expect(page.locator("#btnSample")).to_be_hidden()
        assert errors == []
    finally:
        page.context.close()


def test_settings_persist_and_reset(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.select_option("#motion", "sway")
        _set_range(page, "frames", 12)
        _set_range(page, "fps", 20)
        page.uncheck("#bodyMove")
        stored = page.evaluate("JSON.parse(localStorage.getItem('imagetools:jiggle-animator:settings'))")
        assert stored["motion"] == "sway" and stored["frames"] == 12 and stored["bodyMove"] is False

        page.reload()
        expect(page.locator("#motion")).to_have_value("sway")
        expect(page.locator("#frames")).to_have_value("12")
        expect(page.locator("#fps")).to_have_value("20")
        expect(page.locator("#bodyMove")).not_to_be_checked()

        page.click("#btnReset")
        expect(page.locator("#motion")).to_have_value("hop")
        expect(page.locator("#frames")).to_have_value("8")
        expect(page.locator("#bodyMove")).to_be_checked()
        assert page.evaluate("localStorage.getItem('imagetools:jiggle-animator:settings')") is None
        assert errors == []
    finally:
        page.context.close()

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


def _count(page: Page) -> int:
    return page.evaluate("recomputeCount")


def _wait_recompute(page: Page, before: int) -> None:
    # 設定変更は少し遅れて再計算されるので、再計算の回数が増えるまで待つ
    page.wait_for_function("(n) => recomputeCount > n", arg=before)


def _change(page: Page, id_: str, value: int) -> None:
    before = _count(page)
    _set_range(page, id_, value)
    _wait_recompute(page, before)


def _frame(page: Page, i: int) -> str:
    return page.evaluate("(i) => frames[i].toDataURL()", i)


def _load_sample(page: Page, kind: str) -> None:
    before = _count(page)
    page.select_option("#sampleKind", kind)
    page.click("#btnSample")
    _wait_recompute(page, before)


def test_motion_independent_of_fps_and_frame_count(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        for kind in ("pixel", "smooth"):
            _load_sample(page, kind)
            _change(page, "fps", 10 if kind == "pixel" else 11)
            _change(page, "frames", 8 if kind == "pixel" else 9)
            _change(page, "frames", 8)
            a2, a5 = _frame(page, 2), _frame(page, 5)
            assert a2 != _frame(page, 0), "サンプルが動いていない"

            _change(page, "fps", 24)
            assert _frame(page, 2) == a2, f"{kind}: 再生速度で動きが変わった"

            # 16 枚にすると 8 枚の i コマ目は 2i コマ目と同じ瞬間になる
            _change(page, "frames", 16)
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

        page.click("#btnResetPrefs")
        expect(page.locator("#motion")).to_have_value("hop")
        expect(page.locator("#frames")).to_have_value("8")
        expect(page.locator("#bodyMove")).to_be_checked()
        assert page.evaluate("localStorage.getItem('imagetools:jiggle-animator:settings')") is None
        assert errors == []
    finally:
        page.context.close()


def test_extreme_settings_do_not_fold(browser: Browser, base_url: str):
    """スライダーの端の値でも変形が折り返さない(逆算した画素がずれない)ことを、順方向の写像のヤコビアンで確かめる。"""
    page, errors = _open(browser, base_url)
    try:
        worst = page.evaluate(
            """() => {
              let worst = Infinity;
              for (const feather of [0.05, 0.15, 0.6]) for (const anchorLen of [0, 2, 10]) for (const mode of ['none', 'pulse']) {
                regions = [newRegion({ cx: 24, cy: 26, rx: 16, ry: 14, feather, gain: 3, freq: 1, damp: 0.02,
                  anchorOn: anchorLen > 0, ax: 24, ay: 26 + anchorLen, scaleMode: mode, scaleAmt: 0.5, scaleSpring: false })];
                S.amp = 64;
                for (const fr of simulate().list) {
                  const R = prepRegion(regions[0], fr.rs[0]);
                  const D = (x, y) => { const w = weightAt(R, x, y); return [w * (R.dx + R.s * (x - R.cx)), w * (R.dy + R.s * (y - R.cy))]; };
                  const h = 0.05;
                  for (let y = 4; y < 50; y += 0.25) for (let x = 4; x < 44; x += 0.25) {
                    const a = D(x + h, y), b = D(x - h, y), c = D(x, y + h), d = D(x, y - h);
                    const j11 = 1 + (a[0] - b[0]) / (2 * h), j12 = (c[0] - d[0]) / (2 * h);
                    const j21 = (a[1] - b[1]) / (2 * h), j22 = 1 + (c[1] - d[1]) / (2 * h);
                    worst = Math.min(worst, j11 * j22 - j12 * j21);
                  }
                }
              }
              return worst;
            }"""
        )
        assert worst > 0, f"写像が折り返している(ヤコビアンの最小値 {worst:.3f})"
        assert errors == []
    finally:
        page.context.close()


def test_broken_stored_settings_fall_back(browser: Browser, base_url: str):
    """壊れた保存値(オブジェクト以外・範囲外・小数・未知の選択肢)でもツールが動き、既定値か範囲内に収まる。"""
    for stored in ['"abc"', '[1,2]', '{"pad":-40,"frames":1000,"cycles":1.5,"fps":0,"motion":"zzz","bodyMove":"no"}']:
        context = browser.new_context()
        context.add_init_script(f"localStorage.setItem('imagetools:jiggle-animator:settings', {stored!r})")
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda err: errors.append(str(err)))
        try:
            page.goto(f"{base_url}/{JIGGLE}")
            expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)
            expect(page.locator("#motion")).to_have_value("hop")
            expect(page.locator("#cycles")).to_have_value("1")
            expect(page.locator("#bodyMove")).to_be_checked()
            if stored.startswith("{"):
                expect(page.locator("#pad")).to_have_value("0")
                expect(page.locator("#frames")).to_have_value("48")
                expect(page.locator("#fps")).to_have_value("1")
            assert errors == [], (stored, errors)
        finally:
            context.close()


def test_file_name_has_grid_suffix(browser: Browser, base_url: str):
    """ファイル名の末尾に _列x行 を付ける(Anim-Editor が分割数を読む形式)。"""
    page = browser.new_context(accept_downloads=True).new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(f"{base_url}/{JIGGLE}")
    expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)
    try:
        _change(page, "frames", 9)
        _set_range(page, "cols", 3)  # 列数は並べ直すだけで再計算しない
        expect(page.locator("#sheetSize")).to_contain_text("_jiggle_3x3.png")
        with page.expect_download() as dl:
            page.click("#btnPng")
        assert dl.value.suggested_filename.endswith("_jiggle_3x3.png")
        with page.expect_download() as dl:
            page.click("#btnJson")
        assert dl.value.suggested_filename.endswith("_jiggle_3x3.json")
        assert errors == []
    finally:
        page.context.close()

"""ドット絵拡大ツール: 拡大のしかたごとの出力、輪郭を細く保つ処理、コマ単位の拡大、設定の保存とリセットを確認する。"""

from __future__ import annotations

from playwright.sync_api import Browser, Page, expect

UPSCALER = "tools/pixel-upscaler.html"
OUTLINE = (27, 27, 47)  # サンプルの輪郭の色


def _open(browser: Browser, base_url: str) -> tuple[Page, list[str]]:
    page = browser.new_context().new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(f"{base_url}/{UPSCALER}")
    page.wait_for_function("renderCount > 0")
    return page, errors


def _rerender(page: Page, action: str) -> None:
    before = page.evaluate("renderCount")
    page.evaluate(action)
    page.wait_for_function("(n) => renderCount > n", arg=before)


def _size(page: Page, pane: int) -> list[int]:
    return page.evaluate("(i) => [state.results[i].w, state.results[i].h]", pane)


def _outline_thickness(page: Page, pane: int) -> int:
    """出力の中央の列を上から見て、最初に現れる輪郭の色が何ドット続くか。"""
    return page.evaluate(
        """([i, rgb]) => {
            const r = state.results[i], x = Math.floor(r.w / 4), want = ((255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
            let n = 0, seen = false;
            for (let y = 0; y < r.h; y++) {
              const hit = r.px[y * r.w + x] === want;
              if (hit) { n++; seen = true; } else if (seen) break;
            }
            return n;
        }""",
        [pane, list(OUTLINE)],
    )


def _colors(page: Page, pane: int) -> int:
    return page.evaluate("(i) => new Set(state.results[i].px).size", pane)


def test_sample_renders_both_panes(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # サンプルは 16×16 の 2 コマ。初期値は 4 倍
        assert _size(page, 0) == [128, 64]
        assert _size(page, 1) == [128, 64]
        expect(page.locator("#frameOn")).to_be_checked()
        expect(page.locator("#cellInfo")).to_contain_text("16×16")
        # 自動で輪郭の色が 1 色選ばれている
        expect(page.locator("#swatches .sw[aria-pressed=true]")).to_have_count(1)
        assert errors == []
    finally:
        page.context.close()


def test_thin_outline_keeps_one_dot(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # 左 = 最近傍（細くしない）は輪郭が倍率ぶん太くなり、右 = xBR くっきり + 細く は 1 ドットのまま
        assert _outline_thickness(page, 0) == 4
        assert _outline_thickness(page, 1) == 1
        # 線の太さを 2 にすると 2 ドット
        _rerender(page, "() => { const e = document.getElementById('lineWidth'); e.value = 2; e.dispatchEvent(new Event('input')); }")
        assert _outline_thickness(page, 1) == 2
        # 最近傍でも細くできる
        _rerender(page, "() => document.getElementById('t0').click()")
        assert _outline_thickness(page, 0) == 2
        # 輪郭の色を外すと細くしない（注記が出る）
        _rerender(page, "() => document.querySelector('#swatches .sw[aria-pressed=true]').click()")
        assert _outline_thickness(page, 0) == 4
        expect(page.locator("#n0")).to_contain_text("輪郭の色が選ばれていない")
        assert errors == []
    finally:
        page.context.close()


def test_methods_and_scales(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # くっきり系は新しい色を作らない（サンプルは 4 色 + 透明）
        for method in ["nearest", "scale", "xbr"]:
            _rerender(page, f"() => {{ const s = document.getElementById('m1'); s.value = '{method}'; s.dispatchEvent(new Event('change')); }}")
            assert _colors(page, 1) <= 5, method
        _rerender(page, "() => { const s = document.getElementById('m1'); s.value = 'xbrs'; s.dispatchEvent(new Event('change')); }")
        assert _colors(page, 1) > 5
        # なめらか版でも縁に半透明を出さない
        assert page.evaluate("new Set([...state.results[1].px].map((c) => c >>> 24)).size") <= 2
        # 3 倍は xBR が使えないので注記を出す
        _rerender(page, "() => document.querySelector('#scaleBtns [data-s=\"3\"]').click()")
        assert _size(page, 1) == [96, 48]
        expect(page.locator("#n1")).to_contain_text("Scale3x")
        _rerender(page, "() => document.querySelector('#scaleBtns [data-s=\"8\"]').click()")
        assert _size(page, 1) == [256, 128]
        expect(page.locator("#n1")).to_be_hidden()
        assert errors == []
    finally:
        page.context.close()


def test_frame_mode_keeps_cells_separate(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.evaluate("() => { const s = document.getElementById('m1'); s.value = 'scale'; s.dispatchEvent(new Event('change')); document.getElementById('t1').click(); }")
        page.wait_for_timeout(200)
        # コマの境目（x = 64）の左右の列。コマ単位なら境目をまたいで色が回り込まない
        edge = "() => { const r = state.results[1]; const col = (x) => Array.from({length: r.h}, (_, y) => r.px[y * r.w + x]); return [col(63), col(64)]; }"
        cells = page.evaluate(edge)
        _rerender(page, "() => document.getElementById('frameOn').click()")
        whole = page.evaluate(edge)
        assert cells != whole
        expect(page.locator("#cols")).to_be_disabled()
        assert errors == []
    finally:
        page.context.close()


def test_settings_saved_and_reset(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        _rerender(page, "() => document.querySelector('#scaleBtns [data-s=\"2\"]').click()")
        _rerender(page, "() => { const s = document.getElementById('m0'); s.value = 'xbrs'; s.dispatchEvent(new Event('change')); }")
        page.click("#bgBtns [data-bg=black]")
        page.reload()
        page.wait_for_function("renderCount > 0")
        expect(page.locator("#scaleBtns [data-s='2']")).to_have_attribute("aria-pressed", "true")
        expect(page.locator("#m0")).to_have_value("xbrs")
        assert "bg-black" in page.get_attribute("#v0", "class")
        assert _size(page, 0) == [64, 32]
        page.click("#btnResetPrefs")
        expect(page.locator("#scaleBtns [data-s='4']")).to_have_attribute("aria-pressed", "true")
        expect(page.locator("#m0")).to_have_value("nearest")
        assert "bg-checker" in page.get_attribute("#v0", "class")
        assert errors == []
    finally:
        page.context.close()

"""ドット絵 中割りツール: サンプルの中割り生成、色の保持、手直しと作り直し、GIF / APNG / PNG の書き出し、設定の保存とリセットを確認する。"""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import Browser, Page, expect

PIXEL_INBETWEEN = "tools/pixel-inbetween.html"


def _open(browser: Browser, base_url: str) -> tuple[Page, list[str]]:
    page = browser.new_context(accept_downloads=True).new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(f"{base_url}/{PIXEL_INBETWEEN}")
    expect(page.locator("#btnSheet")).to_be_enabled(timeout=10_000)
    return page, errors


def _open_details(page: Page) -> None:
    page.get_by_text("細かい設定", exact=True).click()


def _labels(page: Page) -> list[str]:
    return page.evaluate("S.frames.map(f => f.label)")


def test_sample_makes_inbetweens_with_key_colors_only(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # キー絵3枚、最後から最初へもつなぐので 3 区間 × 3 枚 = 9 枚の中割り
        assert _labels(page) == [
            "K1", "1→2 1/3", "1→2 2/3", "1→2 3/3",
            "K2", "2→3 1/3", "2→3 2/3", "2→3 3/3",
            "K3", "3→1 1/3", "3→1 2/3", "3→1 3/3",
        ]
        # 中割りに出てくる色はキー絵にある色だけ、絵が空のコマもない
        assert page.evaluate("""() => {
            const keyColors = new Set(); S.keys.forEach(k => k.px.forEach(c => c && keyColors.add(c)));
            return S.frames.every(f => f.px.some(Boolean) && f.px.every(c => !c || keyColors.has(c)));
        }""")
        assert errors == []
    finally:
        page.close()


def test_segment_count_and_loop_change_frames(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.locator("#loop").uncheck()
        expect(page.locator("#segList .segrow")).to_have_count(2)
        page.locator("#segList .segrow").first.locator("select").first.select_option("1")
        page.wait_for_function("S.frames.length === 7")
        assert _labels(page) == ["K1", "1→2 1/1", "K2", "2→3 1/3", "2→3 2/3", "2→3 3/3", "K3"]
        assert errors == []
    finally:
        page.close()


def test_edit_marks_frame_and_regenerate_asks(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.locator(".tl").nth(2).click()
        box = page.locator("#ed").bounding_box()
        assert box is not None
        page.mouse.click(box["x"] + 3, box["y"] + 3)  # 左上の1ドットをペンで塗る
        assert page.evaluate("S.frames[2].edited") is True
        expect(page.locator(".tl").nth(2).locator(".ed")).to_have_count(1)

        # 設定を変えると、手直しを残すか確認が出る
        _open_details(page)
        page.locator("#holes").uncheck()
        expect(page.locator("#banner")).to_be_visible()
        page.get_by_role("button", name="手直しを残して作り直す").click()
        expect(page.locator("#banner")).to_be_hidden()
        assert page.evaluate("S.frames[2].edited") is True
        assert page.evaluate("S.frames[2].px[0]") != 0

        # 元に戻すと手直しの印が消え、作り直しで確認が出なくなる
        page.get_by_role("button", name="元に戻す").click()
        assert page.evaluate("S.frames[2].edited") is False
        page.locator("#holes").check()
        page.wait_for_timeout(300)
        expect(page.locator("#banner")).to_be_hidden()
        assert errors == []
    finally:
        page.close()


def _download(page: Page, name: str) -> tuple[str, bytes]:
    with page.expect_download(timeout=10_000) as info:
        page.get_by_role("button", name=name, exact=True).click()
    d = info.value
    return d.suggested_filename, Path(d.path()).read_bytes()


def test_exports(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.locator("#scale").select_option("2")
        name, data = _download(page, "PNGを保存")
        assert name == "sample_slime_inbetween_8x2.png"
        assert data.startswith(b"\x89PNG\r\n\x1a\n")

        name, data = _download(page, "GIFを保存")
        assert name.endswith(".gif") and data.startswith(b"GIF89a") and data.endswith(b"\x3b")

        name, data = _download(page, "APNGを保存")
        assert name.endswith("_anim.png") and data.startswith(b"\x89PNG\r\n\x1a\n")
        assert b"acTL" in data and b"fdAT" in data

        # 書き出した GIF / APNG を読み直すと、1コマ目が中割りツールの絵(2倍)と同じになる
        same = page.evaluate("""async () => {
            const a = animFrames();
            const check = async (blob) => {
                const img = new Image(); img.src = URL.createObjectURL(blob); await img.decode();
                const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
                const x = c.getContext('2d'); x.drawImage(img, 0, 0);
                const d = new Uint32Array(x.getImageData(0, 0, c.width, c.height).data.buffer);
                return img.width === a.w && d.every((v, i) => v === a.list[0][i]);
            };
            return [await check(new Blob([encodeGIF(a.list, a.w, a.h, a.delays)])), await check(await encodeAPNG(a.list, a.w, a.h, a.delays))];
        }""")
        assert same == [True, True]
        assert errors == []
    finally:
        page.close()


def test_settings_persist_and_reset(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        _open_details(page)
        page.locator("#extras").select_option("pop")
        page.locator("#tweenMs").fill("120")
        page.locator("#tweenMs").dispatch_event("change")
        page.reload()
        expect(page.locator("#btnSheet")).to_be_enabled(timeout=10_000)
        assert page.locator("#extras").input_value() == "pop"
        assert page.locator("#tweenMs").input_value() == "120"

        page.get_by_role("button", name="設定をリセット").click()
        assert page.locator("#extras").input_value() == "merge"
        assert page.locator("#tweenMs").input_value() == "80"
        assert page.evaluate("localStorage.getItem('imagetools:pixel-inbetween:settings')") is None
        assert errors == []
    finally:
        page.close()


def _add_key_png(page: Page, w: int, h: int) -> None:
    """w×h の小さな PNG をキー絵として追加する。"""
    png = page.evaluate(
        """([w, h]) => { const c = document.createElement('canvas'); c.width = w; c.height = h;
            const x = c.getContext('2d'); x.fillStyle = '#222034'; x.fillRect(2, 2, w - 4, h - 4);
            return c.toDataURL().split(',')[1]; }""",
        [w, h],
    )
    import base64

    page.locator("#addInput").set_input_files(
        files=[{"name": f"key_{w}.png", "mimeType": "image/png", "buffer": base64.b64decode(png)}]
    )


def test_size_change_rebuilds_frames(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # 中割りを手直ししてから、大きいキー絵を足す → すべてのコマが新しい大きさで作り直される
        page.locator(".tl").nth(2).click()
        box = page.locator("#ed").bounding_box()
        assert box is not None
        page.mouse.click(box["x"] + 3, box["y"] + 3)
        _add_key_png(page, 40, 40)
        page.wait_for_function("S.keys.length === 4 && S.W === 40")
        assert page.evaluate("S.frames.every(f => f.px.length === 40 * 40)")
        expect(page.locator("#banner")).to_be_hidden()

        # 大きいキー絵を外すと元の大きさに戻り、例外も出ない
        page.locator(".keyrow").nth(3).get_by_role("button", name="×").click()
        page.wait_for_function("S.keys.length === 3 && S.W === 32")
        assert page.evaluate("S.frames.every(f => f.px.length === 32 * 32)")
        assert errors == []
    finally:
        page.close()


def test_segment_settings_follow_keys(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # K1→K2 を 1 枚にしてから K1 を後ろへ動かしても、その組（いまの K2→K3 … ではなく元の組）の設定が残る
        page.locator("#segList .segrow").first.locator("select").first.select_option("1")
        page.wait_for_function("S.frames.length === 10")
        page.locator(".keyrow").first.get_by_role("button", name="↓").click()
        page.wait_for_timeout(200)
        # 並びは K(旧2), K(旧1), K(旧3)。旧1→旧3 と 旧3→旧2 は既定、旧2→旧1 は新しい組なので既定
        assert page.evaluate("S.segs.map(s => s.n)") == [3, 3, 3]
        page.locator(".keyrow").nth(1).get_by_role("button", name="↑").click()
        page.wait_for_timeout(200)
        assert page.evaluate("S.segs.map(s => s.n)") == [1, 3, 3]
        assert errors == []
    finally:
        page.close()


def test_large_frames_stay_fast(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # 256px の大きな円から、同じ色が 9 ドットしかない絵への中割りでも固まらない
        ms = page.evaluate(
            """() => {
            const W = 256, mk = (fill) => { const px = new Uint32Array(W * W); fill(px); return px; };
            const red = packRGB(220, 40, 40), blue = packRGB(40, 60, 220);
            const A = mk(px => { for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if ((x - 128) ** 2 + (y - 128) ** 2 < 100 ** 2) px[y * W + x] = red; });
            const B = mk(px => { for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if ((x - 128) ** 2 + (y - 128) ** 2 < 100 ** 2) px[y * W + x] = blue; for (let k = 0; k < 9; k++) px[(120 + k) * W + 128] = red; });
            S.W = S.H = W;
            const t0 = performance.now(); const plan = buildPlan(A, B); renderPlan(plan, 0.5);
            return performance.now() - t0;
        }"""
        )
        assert ms < 5000, f"{ms:.0f} ms"
        assert errors == []
    finally:
        page.close()

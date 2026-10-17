"""シート仕上げ: サンプルの読み込み(1行 = 1アクション)、並べ替え・ずらし・揃え・ドット修正と元に戻す、
オニオンスキンのループ、表情差分の書き出し、フィルタ、セルの大きさ、作業の保存と読み直し、設定の保存とリセットを確認する。"""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import Browser, Page, expect

SPRITE_POLISH = "tools/sprite-polish.html"


def _open(browser: Browser, base_url: str) -> tuple[Page, list[str]]:
    page = browser.new_context(accept_downloads=True, viewport={"width": 1600, "height": 1100}).new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    # 静的サーバーは favicon.ico を返さないので、読み込み失敗(404)は数えない
    page.on("console", lambda m: errors.append(m.text)
            if m.type in ("error", "warning") and "Failed to load resource" not in m.text else None)
    page.goto(f"{base_url}/{SPRITE_POLISH}")
    expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)
    return page, errors


def _close(page: Page) -> None:
    page.context.close()


def test_sample_loads_rows_as_actions(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        assert page.evaluate("actions()") == ["bounce", "idle"]
        expect(page.locator(".act-row")).to_have_count(2)
        expect(page.locator(".act-row").nth(0).locator(".thumb")).to_have_count(8)
        expect(page.locator(".act-row").nth(1).locator(".thumb")).to_have_count(4)
        # 書き出しは 1アクション = 1行。差分「目閉じ」の行が足される
        tags = page.evaluate("asepriteJson().meta.frameTags.map(t => [t.name, t.from, t.to])")
        assert tags == [["bounce", 0, 7], ["idle", 8, 11], ["bounce_目閉じ", 12, 19], ["idle_目閉じ", 20, 23]]
        expect(page.locator("#pngPreview")).to_have_text("sample_slime_8x4.png")
        assert errors == []
    finally:
        _close(page)


def test_move_nudge_align_and_undo(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        ids = page.evaluate("doc.frames.map(f => f.id)")
        # 5コマ目を選んで左へ 2px（サンプルはわざと右へ 2px ずれている）
        page.locator(".act-row").nth(0).locator(".thumb").nth(4).click()
        page.keyboard.press("ArrowLeft")
        page.keyboard.press("ArrowLeft")
        assert page.evaluate("doc.frames[4].dx") == -2
        # 6コマ目を「後ろへ」で7コマ目と入れ替える
        page.locator(".act-row").nth(0).locator(".thumb").nth(5).click()
        page.locator("#opRight").click()
        after = page.evaluate("doc.frames.map(f => f.id)")
        assert after[5] == ids[6] and after[6] == ids[5]
        # 行をまたぐ「後ろへ」はしない
        page.locator(".act-row").nth(0).locator(".thumb").nth(7).click()
        page.locator("#opRight").click()
        assert page.evaluate("doc.frames[7].tag") == "bounce"
        # 全コマを下端で揃えると、絵の下端がそろう
        page.locator("#alignScope").select_option("all")
        page.locator("#btnAlign").click()
        bottoms = page.evaluate("doc.frames.map(f => { const b = cellBox(f); return b.y + b.h; })")
        assert len(set(bottoms)) == 1
        # 元に戻すで揃える前に戻る
        page.keyboard.press("Control+z")
        assert len(set(page.evaluate("doc.frames.map(f => { const b = cellBox(f); return b.y + b.h; })"))) > 1
        assert errors == []
    finally:
        _close(page)


def test_pen_draws_and_undo_restores(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.locator("#edZoom").select_option("8")
        page.keyboard.press("b")
        canvas = page.locator("#ed")
        canvas.scroll_into_view_if_needed()
        box = canvas.bounding_box()
        assert page.evaluate("getPx(doc.frames[0], 2, 2)[3]") == 0
        page.mouse.click(box["x"] + 2.5 * 8, box["y"] + 2.5 * 8)
        assert page.evaluate("getPx(doc.frames[0], 2, 2)") == [0x2B, 0x2B, 0x2B, 255]
        page.keyboard.press("Control+z")
        assert page.evaluate("getPx(doc.frames[0], 2, 2)[3]") == 0
        # 拡大しても左端までスクロールできる（中央寄せで左が切れない）
        page.locator("#edZoom").select_option("32")
        page.evaluate("document.getElementById('edStage').scrollLeft = 0")
        assert page.locator("#ed").bounding_box()["x"] >= page.locator("#edStage").bounding_box()["x"]
        assert errors == []
    finally:
        _close(page)


def test_onion_neighbors_loop_inside_action(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # bounce は 0〜7、idle は 8〜11。端は同じアクションの反対側へループする
        assert page.evaluate("[neighbor(0, -1), neighbor(7, 1), neighbor(8, -1), neighbor(11, 1)]") == [7, 0, 11, 8]
        page.locator("#tOnionLoop").click()
        assert page.evaluate("[neighbor(0, -1), neighbor(7, 1), neighbor(3, 1)]") == [-1, -1, 4]
        assert errors == []
    finally:
        _close(page)


def test_variant_rows_and_separate_files(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.locator("#exportVar").select_option("files")
        expect(page.locator("#pngPreview")).to_have_text("sample_slime_8x2.png\nsample_slime_目閉じ_8x2.png")
        names = []
        page.on("download", lambda d: names.append(d.suggested_filename))
        page.get_by_role("button", name="PNGを保存", exact=True).click()
        for _ in range(50):
            if len(names) >= 2:
                break
            page.wait_for_timeout(100)
        assert names == ["sample_slime_8x2.png", "sample_slime_目閉じ_8x2.png"]
        # 差分を表示すると、目のところがパーツの色になる
        page.locator("#varSel").select_option(label="差分: 目閉じ")
        diff = page.evaluate("""() => {
            const f = doc.frames[0], a = compose(f).getContext('2d').getImageData(0, 0, doc.cw, doc.ch).data,
                  b = composeShown(f).getContext('2d').getImageData(0, 0, doc.cw, doc.ch).data;
            let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1]) n++;
            return n;
        }""")
        assert diff > 0
        assert errors == []
    finally:
        _close(page)


def test_filters_keep_sheet_colors_and_outline_adds_pixels(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        colors = "sheetColors(doc.frames.map(f => f.px)).map(c => c.slice(0, 3).join()).sort()"
        before = page.evaluate(colors)
        page.locator("#filterBox summary").click()
        page.locator("#fScope").select_option("all")
        page.locator("#fType").select_option("blur")
        # プレビューはコマ一覧とアニメにも出る
        assert page.evaluate("!!filterPreview(doc.frames[0])")
        page.locator("#btnFilter").click()
        assert set(page.evaluate(colors)) <= set(before), "ぼかしで新しい色が増えた"
        opaque = "doc.frames.reduce((n, f) => { const d = f.px.data; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; }, 0)"
        n0 = page.evaluate(opaque)
        page.locator("#fType").select_option("outline")
        page.locator("#btnFilter").click()
        assert page.evaluate(opaque) > n0
        page.keyboard.press("Control+z")
        assert page.evaluate(opaque) == n0
        assert errors == []
    finally:
        _close(page)


def test_cell_size_and_work_roundtrip(browser: Browser, base_url: str, tmp_path: Path):
    page, errors = _open(browser, base_url)
    try:
        page.locator("#cellW").fill("40")
        page.locator("#cellH").fill("36")
        page.locator("#btnCell").click()
        assert page.evaluate("[doc.cw, doc.ch, doc.frames[0].dx, doc.frames[0].dy]") == [40, 36, 4, 4]
        with page.expect_download() as info:
            page.locator("#btnWorkSave").click()
        work = tmp_path / info.value.suggested_filename
        info.value.save_as(work)
        assert work.name.endswith(".polish.json")
        data = json.loads(work.read_text(encoding="utf-8"))
        assert data["app"] == "imagetools-sprite-polish" and len(data["frames"]) == 12 and len(data["variants"]) == 1
        # 読み直すと同じ形に戻る（作業ファイルだけのドロップでも開ける）
        page.locator("#btnSample").click()
        page.locator("#fileInput").set_input_files(work)
        page.wait_for_function("doc.cw === 40")
        assert page.evaluate("[doc.frames.length, doc.variants.length, actions()]") == [12, 1, ["bounce", "idle"]]
        assert errors == []
    finally:
        _close(page)


def test_settings_saved_and_reset(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.locator("#fps").fill("24")
        page.locator("#fps").dispatch_event("change")
        page.locator("#btnGuideH").click()
        page.reload()
        expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)
        assert page.input_value("#fps") == "24"
        assert page.evaluate("S.guides.length") == 1
        page.locator("#btnResetPrefs").click()
        assert page.input_value("#fps") == "10"
        assert page.evaluate("S.guides.length") == 0
        assert errors == []
    finally:
        _close(page)

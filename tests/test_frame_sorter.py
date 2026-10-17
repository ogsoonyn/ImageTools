"""コマ整列ツール: サンプルのコマ検出、手直し(切り出し・結合・元に戻す)、端揃え、JSON、設定の保存とリセットを確認する。"""

from __future__ import annotations

import json

from playwright.sync_api import Browser, Page, expect

FRAME_SORTER = "tools/frame-sorter.html"


def _open(browser: Browser, base_url: str) -> tuple[Page, list[str]]:
    page = browser.new_context(accept_downloads=True).new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(f"{base_url}/{FRAME_SORTER}")
    return page, errors


def _load_sample(page: Page) -> None:
    page.get_by_role("button", name="サンプルを読み込む").click()
    expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)


def _group_sizes(page: Page) -> list[int]:
    return page.evaluate("S.groups.map(g => g.ids.length)")


def test_detects_sample_frames_by_row(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        _load_sample(page)
        # 光の玉 7(うち2コマは縦積み)・星 8・四角 6・粒でできた火花 7。ゴミ点 2 個は無視される
        assert _group_sizes(page) == [7, 8, 6, 7]
        assert page.evaluate("S.dropped") == 2
        # 縦に積まれた小さい2コマが先頭に来る(左の列を上から読む)
        sizes = page.evaluate("S.groups[0].ids.map(id => S.frames.get(id).w)")
        assert sizes[0] < sizes[1] < sizes[2]
        assert errors == []
    finally:
        page.context.close()


def test_split_merge_and_undo(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        _load_sample(page)
        thumbs = page.locator(".gcard").nth(1).locator(".thumb")
        thumbs.nth(5).click()
        thumbs.nth(6).click(modifiers=["Shift"])
        expect(page.locator("#selBar")).to_be_visible()
        expect(page.locator("#selBarCount")).to_have_text("2 コマ選択中")

        page.click("#sbNewGroup")
        assert _group_sizes(page) == [7, 6, 2, 6, 7]
        expect(page.locator("#selBar")).to_be_visible()

        page.click("#sbMerge")
        assert _group_sizes(page) == [7, 6, 1, 6, 7]
        page.keyboard.press("Control+z")
        assert _group_sizes(page) == [7, 6, 2, 6, 7]

        # 元に戻すと選択は解除され、操作バーも消える
        expect(page.locator("#selBar")).to_be_hidden()
        page.locator(".gcard").nth(2).locator(".thumb").nth(0).click()
        expect(page.locator("#selBar")).to_be_visible()
        page.click("#sbClear")
        expect(page.locator("#selBar")).to_be_hidden()
        assert errors == []
    finally:
        page.context.close()


def test_edge_alignment_keeps_group_centered(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        _load_sample(page)
        page.select_option("#cellMode", "fixed")
        page.fill("#cellW", "300")
        page.fill("#cellH", "300")
        expected = {"bottom": "y+h", "top": "y", "left": "x", "right": "x+w"}
        for anchor, edge in expected.items():
            before = page.evaluate("buildCount")
            page.click(f'#anchorSeg [data-anchor="{anchor}"]')
            page.wait_for_function("(n) => buildCount > n", arg=before)
            r = page.evaluate(
                """() => {
                  const rs = layout.rects.filter(r => r.group.id === S.groups[0].id);
                  return rs.map(r => { const f = S.frames.get(r.id);
                    return {x: r.x - r.cell.x, y: r.y - r.cell.y, w: f.w, h: f.h}; });
                }"""
            )
            vals = {
                "y+h": [f["y"] + f["h"] for f in r],
                "y": [f["y"] for f in r],
                "x": [f["x"] for f in r],
                "x+w": [f["x"] + f["w"] for f in r],
            }[edge]
            assert len(set(vals)) == 1, (anchor, vals)
            # 揃えたまとまり(最大のコマの範囲)がセルの中央に来る
            hi_x = max(f["x"] + f["w"] for f in r)
            hi_y = max(f["y"] + f["h"] for f in r)
            assert abs(min(f["x"] for f in r) + hi_x - 300) <= 1, anchor
            assert abs(min(f["y"] for f in r) + hi_y - 300) <= 1, anchor
        assert errors == []
    finally:
        page.context.close()


def test_json_has_frame_tags_per_animation(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        _load_sample(page)
        page.select_option("#jsonFormat", "array")
        with page.expect_download() as dl:
            page.click("#btnJson")
        data = json.loads(open(dl.value.path(), encoding="utf-8").read())
        tags = data["meta"]["frameTags"]
        assert [t["to"] - t["from"] + 1 for t in tags] == [7, 8, 6, 7]
        assert len(data["frames"]) == 28
        assert data["frames"][0]["filename"] == "anim1 0.png"
        assert errors == []
    finally:
        page.context.close()


def test_settings_persist_and_reset(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.fill("#gap", "12")
        page.select_option("#autoMode", "cols")
        page.click('#anchorSeg [data-anchor="left"]')
        page.click('#bgOutSeg [data-bgout="keep"]')
        page.reload()
        expect(page.locator("#gap")).to_have_value("12")
        expect(page.locator("#gapV")).to_have_text("12")
        expect(page.locator("#autoMode")).to_have_value("cols")
        expect(page.locator('#anchorSeg [data-anchor="left"]')).to_have_attribute("aria-pressed", "true")
        expect(page.locator('#bgOutSeg [data-bgout="keep"]')).to_have_attribute("aria-pressed", "true")

        page.get_by_role("button", name="設定をリセット").click()
        expect(page.locator("#toast")).to_have_text("設定をリセットしました")
        expect(page.locator("#gap")).to_have_value("6")
        expect(page.locator("#autoMode")).to_have_value("rows")
        expect(page.locator('#anchorSeg [data-anchor="bottom"]')).to_have_attribute("aria-pressed", "true")
        assert errors == []
    finally:
        page.context.close()


def _opaque_pixels(page: Page) -> list[int]:
    # 各コマの切り出し画像の不透明画素数(アニメの並び順)
    return page.evaluate(
        """() => S.groups.flatMap(g => g.ids).map(id => {
             const c = cutFrame(S.frames.get(id)), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
             let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })"""
    )


def test_undo_after_redetect_restores_frame_contents(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        _load_sample(page)
        before = _opaque_pixels(page)
        count = page.evaluate("detectCount")
        page.fill("#gap", "0")
        page.wait_for_function("(n) => detectCount > n", arg=count)
        assert sum(_group_sizes(page)) > 28  # 粒がばらばらに検出される
        page.click("#btnUndo")
        assert _group_sizes(page) == [7, 8, 6, 7]
        expect(page.locator("#gap")).to_have_value("6")
        assert _opaque_pixels(page) == before
        assert errors == []
    finally:
        page.context.close()


def test_small_specks_inside_a_frame_are_kept(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        # 100×100 の L 字の内側、本体から離れた位置に 3×3 の点を置く
        page.evaluate(
            """() => { const c = document.createElement('canvas'); c.width = 200; c.height = 200;
                 const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 200, 200);
                 x.fillStyle = '#fff'; x.fillRect(50, 50, 10, 100); x.fillRect(50, 140, 100, 10); x.fillRect(120, 70, 3, 3);
                 setSource(c, 'speck.png'); }"""
        )
        assert _group_sizes(page) == [1]
        assert page.evaluate("S.dropped") == 0
        assert _opaque_pixels(page) == [10 * 100 + 90 * 10 + 9]
        assert errors == []
    finally:
        page.context.close()


def test_file_name_has_grid_suffix(browser: Browser, base_url: str):
    """ファイル名の末尾に _列x行 を付ける(Anim-Editor が分割数を読む形式)。格子にならないときは付けない。"""
    page, errors = _open(browser, base_url)
    try:
        _load_sample(page)
        page.fill("#baseName", "fx_3x3")  # 末尾の古い表記は付け替える
        with page.expect_download() as dl:
            page.click("#btnPng")
        # 4アニメ(最長 8 コマ)を行ごと → 8 列 × 4 行
        assert dl.value.suggested_filename == "fx_8x4.png"
        with page.expect_download() as dl:
            page.click("#btnJson")
        assert dl.value.suggested_filename == "fx_8x4.json"
        data = json.loads(open(dl.value.path(), encoding="utf-8").read())
        assert data["meta"]["image"] == "fx_8x4.png"
        cell = next(iter(data["frames"].values()))["frame"]
        assert (data["meta"]["size"]["w"], data["meta"]["size"]["h"]) == (8 * cell["w"], 4 * cell["h"])
        expect(page.locator("#pngPreview")).to_have_text("fx_8x4.png")
        page.select_option("#cellMode", "group")
        expect(page.locator("#pngPreview")).to_have_text("fx.png")
        assert errors == []
    finally:
        page.context.close()

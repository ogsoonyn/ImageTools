"""スプライトシート作成: 貼り付け・範囲検出・背景の透過・位置揃え・微調整・設定の保存とリセット、
旧キー抜きツール由来の機能(自然順・キーカラー・輝度をアルファに・シートとして扱う・4の倍数/2の累乗)を確認する。"""

from __future__ import annotations

import re

from playwright.sync_api import Browser, Page, expect

TOOL = "tools/sprite-sheet-maker.html"
PREFS_KEY = "imagetools:sprite-sheet-maker:settings"


def _open(browser: Browser, base_url: str, query: str = "") -> tuple[Page, list[str]]:
    page = browser.new_context().new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(f"{base_url}/{TOOL}{query}")
    return page, errors


def _paste_color(page: Page, color: str, w: int = 64, h: int = 48) -> None:
    """単色の画像をクリップボードからの貼り付けとして送る。"""
    page.evaluate(
        """async ([color, w, h]) => {
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
            const blob = await new Promise((r) => c.toBlob(r));
            const dt = new DataTransfer();
            dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
            document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
        }""",
        [color, w, h],
    )


def _cell_bottom_gaps(page: Page) -> list[int]:
    """シート上の各セルについて、最も下の不透明な画素からセル下端までの距離を返す。"""
    return page.evaluate(
        """() => {
            const c = document.getElementById('sheet');
            const x = c.getContext('2d', { willReadFrequently: true });
            return layout.rects.map((r) => {
                const d = x.getImageData(r.x, r.y, r.w, r.h).data;
                let low = -1;
                for (let y = 0; y < r.h; y++) for (let i = 0; i < r.w; i++) if (d[(y * r.w + i) * 4 + 3] > 16) low = y;
                return r.h - 1 - low;
            });
        }"""
    )


def test_paste_adds_frames_in_order(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    _paste_color(page, "#ff0000")
    expect(page.locator("#countBadge")).to_have_text("1")
    _paste_color(page, "#0000ff")
    expect(page.locator("#countBadge")).to_have_text("2")
    names = page.evaluate("frames.map((f) => f.name)")
    assert names == ["paste_001", "paste_002"]
    # 自分の画像を入れたらサンプルのボタンは隠れる
    expect(page.locator("#btnSample")).to_be_hidden()
    # 逆順にすると並びが入れ替わる
    page.click("#btnReverse")
    assert page.evaluate("frames.map((f) => f.name)") == ["paste_002", "paste_001"]
    assert page.evaluate("[layout.cols, layout.rows]") == [2, 1]
    assert errors == []


def test_sample_crop_keyout_align_and_nudge(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    page.click("#btnSample")
    expect(page.locator("#countBadge")).to_have_text("6")

    # 変化のある範囲を検出すると、画面全体より小さい範囲が選ばれる
    page.click("#btnAutoCrop")
    crop = page.evaluate("crop")
    assert 0 < crop["w"] < 480 and 0 < crop["h"] < 270

    # 透過しないうちは位置の揃えは使えない
    expect(page.locator("#anchorSeg button[data-anchor='left']")).to_be_disabled()
    page.select_option("#bgMode", "flood")
    expect(page.locator("#anchorSeg button[data-anchor='left']")).to_be_enabled()
    transparent = page.evaluate(
        """() => {
            const c = document.getElementById('sheet');
            const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
            let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] === 0) n++;
            return n / (d.length / 4);
        }"""
    )
    assert transparent > 0.3

    # 下端揃え + 絵に合わせて詰める(余白 3px)で、全セルの絵の下端が揃う
    # 既定(トリミング範囲のまま + 下端): セルは範囲の大きさで、揃えたまとまりはその中央
    g = page.evaluate("groupBox(frames.map((f) => f.cache), effectiveCrop(), alignOpts(true))")
    assert page.evaluate("[layout.cw, layout.ch]") == [crop["w"], crop["h"]]
    assert set(_cell_bottom_gaps(page)) == {crop["h"] - g["bh"] - (crop["h"] - g["bh"]) // 2}

    page.click("#anchorSeg button[data-anchor='bottom']")
    page.select_option("#cellMode", "fit")
    page.fill("#cellPad", "3")
    page.dispatch_event("#cellPad", "change")
    page.wait_for_timeout(100)
    assert set(_cell_bottom_gaps(page)) == {3}
    # 揃えたまとまりはセルの中央に来る: 一番大きい絵の上下左右に 3px ずつ余白が付く
    g = page.evaluate("groupBox(frames.map((f) => f.cache), effectiveCrop(), alignOpts(true))")
    assert (g["bx"], g["by"], g["w"] - g["bw"], g["h"] - g["bh"]) == (3, 3, 6, 6)
    assert page.evaluate("[layout.cw, layout.ch]") == [g["w"], g["h"]]

    # 左端: 全コマの絵の左端がそろう(下端とは別の向き)
    page.click("#anchorSeg button[data-anchor='left']")
    page.wait_for_timeout(100)
    lefts = page.evaluate(
        """() => {
            const c = document.getElementById('sheet');
            const x = c.getContext('2d', { willReadFrequently: true });
            return layout.rects.map((r) => {
                const d = x.getImageData(r.x, r.y, r.w, r.h).data;
                for (let i = 0; i < r.w; i++) for (let y = 0; y < r.h; y++) if (d[(y * r.w + i) * 4 + 3] > 16) return i;
                return -1;
            });
        }"""
    )
    assert set(lefts) == {3}
    page.click("#anchorSeg button[data-anchor='bottom']")

    # 微調整: 一時停止中にアニメ窓で矢印キーを押すと選択中のコマだけずれる
    page.click(".thumb >> nth=2")
    page.focus("#animCanvas")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Shift+ArrowUp")
    expect(page.locator("#dx")).to_have_value("-1")
    expect(page.locator("#dy")).to_have_value("-10")
    assert page.evaluate("frames.map((f) => [f.dx, f.dy])") == [[0, 0], [0, 0], [-1, -10], [0, 0], [0, 0], [0, 0]]
    expect(page.locator(".thumb >> nth=2").locator(".flags")).to_contain_text("ずらし")
    page.click("#btnNudgeResetAll")
    assert page.evaluate("frames.every((f) => !f.dx && !f.dy)")

    # Aseprite 互換 JSON のフレーム数・サイズがシートと一致する
    data = page.evaluate("asepriteJson('array')")
    assert len(data["frames"]) == 6
    assert data["meta"]["size"] == page.evaluate("({ w: layout.W, h: layout.H })")
    assert errors == []


def test_settings_saved_restored_and_reset(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    page.fill("#cols", "4")
    page.dispatch_event("#cols", "change")
    page.select_option("#bgMode", "all")
    page.click("#anchorSeg button[data-anchor='left']")
    page.reload()
    expect(page.locator("#cols")).to_have_value("4")
    expect(page.locator("#bgMode")).to_have_value("all")
    expect(page.locator("#anchor")).to_have_value("left")
    expect(page.locator("#anchorSeg button[data-anchor='left']")).to_have_attribute("aria-pressed", "true")

    page.click("#btnResetPrefs")
    expect(page.locator("#cols")).to_have_value("0")
    expect(page.locator("#bgMode")).to_have_value("none")
    expect(page.locator("#anchor")).to_have_value("bottom")
    expect(page.locator("#cellMode")).to_have_value("crop")
    assert page.evaluate("(k) => localStorage.getItem(k)", PREFS_KEY) is None

    # 壊れた値が保存されていても起動できる
    page.evaluate("(k) => localStorage.setItem(k, '{broken')", PREFS_KEY)
    page.reload()
    expect(page.locator("#cols")).to_have_value("0")
    assert errors == []


def test_duplicate_paste_and_delete_keep_state_consistent(browser: Browser, base_url: str):
    page = browser.new_context().new_page()
    problems: list[str] = []
    page.on("console", lambda m: problems.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda err: problems.append(f"pageerror: {err}"))
    page.goto(f"{base_url}/{TOOL}")

    # 同じ画像を続けて貼っても(重複チェックで画素を読んでも)コンソールに警告が出ない
    for _ in range(3):
        _paste_color(page, "#00aa00")
    expect(page.locator("#countBadge")).to_have_text("3")
    _paste_color(page, "#123456", 300, 200)
    expect(page.locator("#countBadge")).to_have_text("4")

    # 範囲を大きいコマの右下に置いてから、そのコマを消すと範囲が残りのコマの内側に戻る
    page.evaluate("setCrop({ x: 200, y: 100, w: 80, h: 80 })")
    page.click(".thumb >> nth=2")
    page.click(".thumb >> nth=3 >> button[data-op='del']")
    assert page.evaluate("crop") == {"x": 0, "y": 0, "w": 64, "h": 48}

    # 選択中より前のコマを消しても、同じコマを選んだまま
    page.click(".thumb >> nth=2")
    selected_id = page.evaluate("frames[sel].id")
    page.click(".thumb >> nth=0 >> button[data-op='del']")
    assert page.evaluate("frames[sel].id") == selected_id
    assert page.evaluate("[layout.rects.length, frames.length]") == [2, 2]
    assert problems == []


def _drop_files(page: Page, files: list[tuple[str, str, int, int]]) -> None:
    """(名前, 色, 幅, 高さ) の単色画像をファイル選択から入れる(まとめて選んだ場合と同じ)。"""
    page.evaluate(
        """async (files) => {
            const dt = new DataTransfer();
            for (const [name, color, w, h] of files) {
                const c = document.createElement('canvas'); c.width = w; c.height = h;
                const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h);
                x.fillStyle = '#ffffff'; x.fillRect(w / 4, h / 4, w / 2, h / 2);
                const blob = await new Promise((r) => c.toBlob(r));
                dt.items.add(new File([blob], name, { type: 'image/png' }));
            }
            const input = document.getElementById('fileInput');
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        files,
    )


def _alpha_at(page: Page, x: int, y: int) -> int:
    return page.evaluate(
        "([x, y]) => document.getElementById('sheet').getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data[3]",
        [x, y],
    )


def test_files_are_sorted_naturally_and_keyed(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    _drop_files(page, [("fx10.png", "#ff00ff", 16, 16), ("fx9.png", "#ff00ff", 16, 16), ("fx1.png", "#ff00ff", 16, 16)])
    expect(page.locator("#countBadge")).to_have_text("3")
    assert page.evaluate("frames.map((f) => f.name)") == ["fx1", "fx9", "fx10"]
    expect(page.locator("#baseName")).to_have_value("fx")
    # キーカラー(指定色をすべて消す)でマゼンタが抜け、中の白は残る
    page.select_option("#bgMode", "all")
    page.check("#keyManual")
    page.fill("#keyColor", "#ff00ff")
    page.wait_for_timeout(100)
    assert _alpha_at(page, 0, 0) == 0
    assert _alpha_at(page, 8, 8) == 255
    assert errors == []


def test_luminance_to_alpha(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    _drop_files(page, [("a.png", "#000000", 16, 16), ("b.png", "#000000", 16, 16)])
    expect(page.locator("#countBadge")).to_have_text("2")
    assert _alpha_at(page, 0, 0) == 255
    # 輝度をアルファに: 黒は透明、白は不透明。透過していなくても位置の揃えが使える
    page.check("#lum")
    expect(page.locator("#lumOpts")).to_be_visible()
    page.wait_for_timeout(100)
    assert _alpha_at(page, 0, 0) == 0
    assert _alpha_at(page, 8, 8) == 255
    expect(page.locator("#anchorSeg button[data-anchor='left']")).to_be_enabled()
    assert errors == []


def test_single_named_sheet_is_keyed_without_relayout(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    _drop_files(page, [("walk_4x2.png", "#00ff00", 64, 32)])
    expect(page.locator("#sheetMode")).to_be_checked()
    expect(page.locator("#srcCols")).to_have_value("4")
    expect(page.locator("#srcRows")).to_have_value("2")
    expect(page.locator("#cropSec")).to_be_hidden()
    assert page.evaluate("[layout.W, layout.H, layout.cw, layout.ch, layout.rects.length]") == [64, 32, 16, 16, 8]
    page.select_option("#bgMode", "flood")
    page.wait_for_timeout(100)
    assert _alpha_at(page, 0, 0) == 0
    assert page.evaluate("pngName()") == "walk_4x2.png"
    data = page.evaluate("asepriteJson('array')")
    assert len(data["frames"]) == 8
    assert data["frames"][5]["frame"] == {"x": 16, "y": 16, "w": 16, "h": 16}
    # 有効コマ数で最終行の空きを外せる
    page.fill("#srcCount", "6")
    page.wait_for_timeout(100)
    assert page.evaluate("layout.rects.length") == 6
    # シートとして扱うのをやめると、通常どおり並べ直す
    page.uncheck("#sheetMode")
    expect(page.locator("#cropSec")).to_be_visible()
    assert page.evaluate("layout.sheet") is None
    assert errors == []


def test_mult4_and_power_of_two(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    _drop_files(page, [(f"f{i}.png", "#123456", 13, 10) for i in range(3)])
    expect(page.locator("#countBadge")).to_have_text("3")
    assert page.evaluate("[layout.cw, layout.ch, layout.W, layout.H]") == [13, 10, 26, 20]
    page.check("#mult4")
    page.wait_for_timeout(100)
    assert page.evaluate("[layout.cw, layout.ch, layout.W, layout.H]") == [16, 12, 32, 24]
    page.check("#pot")
    page.wait_for_timeout(100)
    assert page.evaluate("[layout.W, layout.H]") == [32, 32]
    assert errors == []


def test_keyout_mode_preset_and_effect_sample(browser: Browser, base_url: str):
    # 旧キー抜きツールの URL から来たとき: 保存した設定がなければマゼンタのキーカラーで始まり、サンプルはエフェクト
    page, errors = _open(browser, base_url, "?mode=keyout")
    expect(page.locator("#bgMode")).to_have_value("all")
    expect(page.locator("#keyColor")).to_have_value("#ff00ff")
    expect(page.locator("#sampleKind")).to_have_value("effect")
    page.click("#btnSample")
    expect(page.locator("#countBadge")).to_have_text("9")
    assert page.evaluate("frames[0].name") == "colon183"
    assert _alpha_at(page, 0, 0) == 0
    # 保存した設定があればそちらを使う
    page.select_option("#bgMode", "none")
    page.reload()
    expect(page.locator("#bgMode")).to_have_value("none")
    assert errors == []


def test_preview_background_and_additive(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    page.click("#bgSeg button[data-bg='black']")
    page.check("#additive")
    expect(page.locator("#sheetStage")).to_have_class(re.compile(r"\bbg-black\b"))
    page.reload()
    expect(page.locator("#bgSeg button[data-bg='black']")).to_have_attribute("aria-pressed", "true")
    expect(page.locator("#animStage")).to_have_class(re.compile(r"\bbg-black\b"))
    expect(page.locator("#additive")).to_be_checked()
    page.click("#btnSample")
    page.wait_for_timeout(200)
    assert errors == []

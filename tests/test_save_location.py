"""保存先(共通部 save.ts): 保存ダイアログを読み込んだファイルのフォルダで開くこと、保存先フォルダへの直接保存と記憶、上書きの確認を確かめる。

Chromium の本物のダイアログは操作できないので、showOpenFilePicker / showSaveFilePicker / showDirectoryPicker を差し替え、
書き込み先にはオリジン専用の領域(OPFS: navigator.storage.getDirectory())の本物のハンドルを使う。
"""

from __future__ import annotations

import json

from playwright.sync_api import Browser, Page, expect

TOOL = "tools/frame-sorter.html"

# 選んだことにするファイル・フォルダを OPFS に用意し、各ダイアログに渡された引数を window.__picks に記録する
MOCK = """
(() => {
  window.__picks = [];
  const root = () => navigator.storage.getDirectory();
  window.showOpenFilePicker = async (o) => {
    const dir = await (await root()).getDirectoryHandle("in", { create: true });
    const h = await dir.getFileHandle("loaded.png", { create: true });
    const c = document.createElement("canvas"); c.width = 40; c.height = 20;
    const g = c.getContext("2d"); g.fillStyle = "#5b5b5b"; g.fillRect(0, 0, 40, 20);
    g.fillStyle = "#f00"; g.fillRect(4, 4, 8, 8); g.fillRect(24, 4, 8, 8);
    const blob = await new Promise((r) => c.toBlob(r));
    const ws = await h.createWritable(); await ws.write(blob); await ws.close();
    window.__opened = h;
    window.__picks.push({ kind: "open", id: o.id });
    return [h];
  };
  window.showSaveFilePicker = async (o) => {
    window.__picks.push({ kind: "save", name: o.suggestedName, id: o.id, startInIsLoaded: !!(o.startIn && window.__opened && await o.startIn.isSameEntry(window.__opened)) });
    if (window.__abortSave) throw new DOMException("cancel", "AbortError");
    const dir = await (await root()).getDirectoryHandle("picked", { create: true });
    return dir.getFileHandle(o.suggestedName, { create: true });
  };
  window.showDirectoryPicker = async (o) => {
    window.__picks.push({ kind: "dir", id: o.id });
    return (await root()).getDirectoryHandle("out", { create: true });
  };
  window.__readOpfs = async (dir, name) => {
    try { return await (await (await (await root()).getDirectoryHandle(dir)).getFileHandle(name)).getFile().then((f) => f.size); }
    catch { return -1; }
  };
})();
"""


def _open(browser: Browser, base_url: str) -> tuple[Page, list[str]]:
    context = browser.raw_new_context()
    context.add_init_script(MOCK)
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(f"{base_url}/{TOOL}")
    return page, errors


def _picks(page: Page) -> list[dict]:
    return page.evaluate("window.__picks")


def test_save_dialog_opens_in_loaded_files_folder(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        expect(page.locator("#saveDirBtn")).to_have_text("保存先: 毎回選ぶ")
        # 入力欄のクリックはファイル選択ダイアログ(差し替え)に回り、選んだ画像が読み込まれる
        page.click("#drop")
        expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)
        assert _picks(page) == [{"kind": "open", "id": "imagetools-open"}]
        page.click("#btnPng")
        expect(page.locator("#toast")).to_contain_text("を保存しました")
        save = _picks(page)[-1]
        assert save["kind"] == "save" and save["id"] == "imagetools-save"
        assert save["name"].endswith(".png")
        # 読み込んだファイルのハンドルを startIn に渡している = 同じフォルダで開く
        assert save["startInIsLoaded"] is True
        assert page.evaluate("(n) => window.__readOpfs('picked', n)", save["name"]) > 0
        assert errors == []
    finally:
        page.context.close()


def test_cancel_in_save_dialog_does_not_download(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.get_by_role("button", name="サンプルを読み込む").click()
        expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)
        page.evaluate("window.__abortSave = true")
        downloads: list[object] = []
        page.on("download", lambda d: downloads.append(d))
        page.click("#btnPng")
        expect(page.locator("#toast")).to_have_text("保存をキャンセルしました")
        assert downloads == []
        # サンプル(ファイルから読んでいない)なので startIn は付かない
        assert _picks(page)[-1]["startInIsLoaded"] is False
        assert errors == []
    finally:
        page.context.close()


def test_save_folder_is_remembered_and_written_directly(browser: Browser, base_url: str):
    page, errors = _open(browser, base_url)
    try:
        page.click("#saveDirBtn")
        expect(page.locator("#saveDirDialog")).to_be_visible()
        page.get_by_role("button", name="フォルダを選ぶ").click()
        expect(page.locator("#saveDirDialog")).to_be_hidden()
        expect(page.locator("#saveDirBtn")).to_have_text("保存先: out")

        # 再読み込みしても(IndexedDB から)保存先を覚えている
        page.reload()
        expect(page.locator("#saveDirBtn")).to_have_text("保存先: out")
        page.get_by_role("button", name="サンプルを読み込む").click()
        expect(page.locator("#btnJson")).to_be_enabled(timeout=10_000)

        page.click("#btnJson")
        expect(page.locator("#toast")).to_contain_text("out/")
        assert [p["kind"] for p in _picks(page)] == []  # 保存ダイアログは出ない
        name = page.locator("#toast").inner_text().split("out/")[1].split(" を保存")[0]
        assert page.evaluate("(n) => window.__readOpfs('out', n)", name) > 0

        # 同じ名前があれば確認し、断れば保存しない
        messages: list[str] = []
        page.once("dialog", lambda d: (messages.append(d.message), d.dismiss()))
        page.click("#btnJson")
        expect(page.locator("#toast")).to_have_text("保存をキャンセルしました")
        assert "上書きしますか" in messages[0]
        # 認めれば上書きする
        page.once("dialog", lambda d: d.accept())
        page.click("#btnJson")
        expect(page.locator("#toast")).to_contain_text("out/" + name)
        json.loads(page.evaluate("""async (n) => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('out')).getFileHandle(n)).getFile()).text()""", name))

        # 解除すると保存ダイアログに戻る
        page.click("#saveDirBtn")
        page.get_by_role("button", name="設定を解除").click()
        expect(page.locator("#saveDirBtn")).to_have_text("保存先: 毎回選ぶ")
        page.click("#btnJson")
        expect(page.locator("#toast")).to_contain_text("を保存しました")
        assert _picks(page)[-1]["kind"] == "save"
        assert errors == []
    finally:
        page.context.close()


def test_without_api_there_is_no_save_folder_button(browser: Browser, base_url: str):
    # Firefox / Safari 相当(API なし)ではボタンを出さず、従来のダウンロード保存のまま
    page = browser.new_context(accept_downloads=True).new_page()
    try:
        page.goto(f"{base_url}/{TOOL}")
        page.get_by_role("button", name="サンプルを読み込む").click()
        expect(page.locator("#btnPng")).to_be_enabled(timeout=10_000)
        assert page.locator("#saveDirBtn").count() == 0
        with page.expect_download():
            page.click("#btnPng")
    finally:
        page.context.close()

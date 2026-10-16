"""トップページのツールカードがカード全体でクリックできることを確認する。"""

from __future__ import annotations

import re

import pytest
from playwright.sync_api import Browser, expect

CARD_COUNT_MIN = 1
# カード内のタイトル以外の要素(説明文・入出力欄・ファイル名)
CLICK_TARGETS = [".desc", "dd", ".file"]


@pytest.mark.parametrize("target", CLICK_TARGETS)
def test_card_body_click_opens_tool(browser: Browser, base_url: str, target: str):
    context = browser.new_context()
    try:
        context.route(re.compile(r"^https://fonts\.(googleapis|gstatic)\.com/"), lambda route: route.abort())
        page = context.new_page()
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        cards = page.locator(".card")
        count = cards.count()
        assert count >= CARD_COUNT_MIN
        for i in range(count):
            card = page.locator(".card").nth(i)
            href = card.locator("h2 a").get_attribute("href")
            # 要素の上はリンクの重ね合わせ(::after)が覆うので、Playwright の要素クリックではなく座標でクリックする
            box = card.locator(target).first.bounding_box()
            assert box is not None
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            expect(page).to_have_url(f"{base_url}/{href}")
            page.go_back(wait_until="domcontentloaded")
    finally:
        context.close()


def test_card_link_is_single_tab_stop(browser: Browser, base_url: str):
    # キーボード操作ではカードごとにタイトルのリンク1つだけにフォーカスが止まる
    page = browser.new_page()
    try:
        page.route(re.compile(r"^https://fonts\.(googleapis|gstatic)\.com/"), lambda route: route.abort())
        page.goto(f"{base_url}/index.html", wait_until="domcontentloaded")
        cards = page.locator(".card")
        for i in range(cards.count()):
            assert cards.nth(i).locator("a, button, [tabindex]").count() == 1
    finally:
        page.close()

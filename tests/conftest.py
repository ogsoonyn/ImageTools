"""Playwright スモークテスト用の共通フィクスチャ。

リポジトリのルート(SITE_DIR 指定時はビルド結果)を静的サーバーで配信し、各ページを Chromium で開く。
"""

from __future__ import annotations

import functools
import http.server
import os
import threading
from pathlib import Path

import pytest
from playwright.sync_api import Browser, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
# 配信するディレクトリ。SITE_DIR=dist を指定するとビルド結果(npm run build の出力)を開く
SITE = (ROOT / os.environ["SITE_DIR"]).resolve() if os.environ.get("SITE_DIR") else ROOT


def discover_pages() -> list[str]:
    """テスト対象のページ(リポジトリルートからの相対パス)を列挙する。"""
    pages = []
    if (ROOT / "index.html").exists():
        pages.append("index.html")
    pages += sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "tools").glob("*.html"))
    return pages


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    # GitHub Pages と同じく charset=utf-8 を付けて返す(<meta charset> のないページが文字化けしないように)
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
    }

    def log_message(self, format, *args):  # noqa: A002 - 親クラスのシグネチャに合わせる
        pass


@pytest.fixture(scope="session")
def base_url() -> str:
    """BASE_URL が指定されていればそれを使い、なければ一時的な静的サーバーを立てる。"""
    if url := os.environ.get("BASE_URL"):
        yield url.rstrip("/")
        return
    handler = functools.partial(_QuietHandler, directory=str(SITE))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="session")
def browser() -> Browser:
    # PLAYWRIGHT_CHROMIUM_EXECUTABLE で既存の Chromium を指定できる(ブラウザを別途入れている環境向け)
    executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or None
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=executable)
        yield browser
        browser.close()

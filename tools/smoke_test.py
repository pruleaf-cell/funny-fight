#!/usr/bin/env python3

import contextlib
import http.server
import socket
import socketserver
import threading
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


def _find_free_port():
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=3) as r:
        data = r.read()
    return data.decode("utf-8", errors="replace")


def main() -> int:
    if not SITE.exists():
        print("FAIL: missing /site directory")
        return 1

    port = _find_free_port()

    # Serve repo root; pages are under /site/
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(ROOT), **kwargs)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)

    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    time.sleep(0.1)

    try:
        index = _fetch(f"http://127.0.0.1:{port}/site/")
        assert "<canvas" in index, "index.html should include a canvas"
        assert "ROHAN" in index and "DEV" in index, "index.html should mention both fighters"
        assert "game.js" in index, "index.html should load game.js"
        assert "style.css" in index, "index.html should load style.css"

        js = _fetch(f"http://127.0.0.1:{port}/site/game.js")
        assert "AudioContext" in js or "webkitAudioContext" in js, "game.js should include WebAudio"
        assert "ROHAN" in js and "DEV" in js, "game.js should include both fighter names"

        css = _fetch(f"http://127.0.0.1:{port}/site/style.css")
        assert ":root" in css and "--rohan" in css and "--dev" in css, "style.css should include theme vars"

        print("OK: smoke test passed")
        return 0
    except AssertionError as e:
        print(f"FAIL: {e}")
        return 1
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())


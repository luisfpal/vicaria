"""Serve standalone/dist and nothing else: GET and HEAD of the built app files, no listing, no API, no uploads.

    python3 standalone/serve_static.py [dist_dir] [port]     # binds 127.0.0.1 only; a tunnel publishes it

Paths without a file extension get index.html (the app's own routes, like /book/x). Precompressed .gz siblings
are sent to browsers that accept gzip.
"""
from __future__ import annotations

import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent / "dist").resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8790
BASE = (sys.argv[3] if len(sys.argv) > 3 else "").rstrip("/")  # serve dist under this path, as GitHub Pages does
TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json",
         ".webmanifest": "application/manifest+json", ".zip": "application/zip", ".woff2": "font/woff2",
         ".css": "text/css", ".html": "text/html; charset=utf-8", ".png": "image/png", ".txt": "text/plain"}
HEADERS = [("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"), ("X-Frame-Options", "DENY"),
           ("Cross-Origin-Opener-Policy", "same-origin"), ("Permissions-Policy", "camera=(), microphone=(), geolocation=()")]


class Static(BaseHTTPRequestHandler):
    server_version = "static"

    def log_message(self, *a):
        pass

    def _resolve(self) -> Path | None:
        path = unquote(urlparse(self.path).path)
        if BASE:
            if path != BASE and not path.startswith(BASE + "/"):
                return None
            path = path[len(BASE):] or "/"
        if "\x00" in path or "\\" in path or path.startswith("/api/"):
            return None  # there is no API here: the app answers /api on the device
        p = (ROOT / path.lstrip("/")).resolve()
        if p != ROOT and ROOT not in p.parents:
            return None
        if p.is_file() and not p.name.endswith(".gz"):
            return p
        if "." not in path.rsplit("/", 1)[-1]:
            return ROOT / "index.html"
        return None

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        p = self._resolve()
        if p is None:
            self.send_error(404)
            return
        gz = p.with_name(p.name + ".gz")
        use_gz = gz.is_file() and "gzip" in self.headers.get("Accept-Encoding", "")
        data = (gz if use_gz else p).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", TYPES.get(p.suffix) or mimetypes.guess_type(p.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")  # the service worker keeps the copies; always check for a new build
        if use_gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        for k, v in HEADERS:
            self.send_header(k, v)
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def _no(self):
        self.send_error(405)

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _no


if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    print(f"static {ROOT} on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Static).serve_forever()

"""Run the real Commonplace server inside the browser (Pyodide in a Web Worker), with no network server at all.

The service worker hands each /api request to the page, the page hands it to the worker, and handle() runs it
through server.Handler exactly as it runs on a computer, over an in-memory socket. Only three things differ:
  * files live in /data (IndexedDB-backed), so the library format is the same as on a computer;
  * threads cannot start in a browser, so a background job runs right after the request that started it;
  * urllib's HTTP calls to AI providers go through the browser (synchronous XMLHttpRequest, allowed in workers).
"""
from __future__ import annotations

import io
import os
import sys

DATA = "/data"
os.environ.setdefault("BOOK_READER_LIBRARY", f"{DATA}/library")
os.environ.setdefault("COMMONPLACE_KEYS", f"{DATA}/keys")
os.environ.setdefault("BOOK_READER_CONFIG", f"{DATA}/config.json")

# -- threads: run the target after the current request finishes ------------------------------------------
import threading
import concurrent.futures as _cf

_deferred: list = []


def _start(self):
    _deferred.append(self.run)


threading.Thread.start = _start


class _SyncExecutor:
    """ThreadPoolExecutor stand-in: work runs at submit time, in order."""

    def __init__(self, *a, **k):
        pass

    def submit(self, fn, *args, **kwargs):
        f = _cf.Future()
        try:
            f.set_result(fn(*args, **kwargs))
        except BaseException as e:  # noqa: BLE001 - a Future carries the error to whoever reads it
            f.set_exception(e)
        return f

    def map(self, fn, *its, timeout=None, chunksize=1):
        return [fn(*a) for a in zip(*its)]

    def shutdown(self, wait=True, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


_cf.ThreadPoolExecutor = _SyncExecutor


def run_deferred() -> int:
    """Run background jobs queued by requests. Returns how many ran."""
    n = 0
    while _deferred:
        job = _deferred.pop(0)
        n += 1
        try:
            job()
        except Exception:  # noqa: BLE001 - a failed job records its own error in the library
            pass
    return n


def pending() -> int:
    return len(_deferred)


# -- HTTP to AI providers through the browser -------------------------------------------------------------
import email.message
import urllib.error
import urllib.request

_real_urlopen = urllib.request.urlopen


class _Resp(io.BytesIO):
    def __init__(self, data: bytes, status: int, headers: email.message.Message, url: str):
        super().__init__(data)
        self.status = self.code = status
        self.headers = self.msg = headers
        self.url = url

    def getcode(self):
        return self.status

    def info(self):
        return self.headers


def _browser_urlopen(req, data=None, timeout=None, **kw):
    try:
        import js  # only inside Pyodide
    except ImportError:
        return _real_urlopen(req, data, timeout, **kw)
    if isinstance(req, str):
        req = urllib.request.Request(req, data=data)
    url = req.full_url
    if url.startswith("http://127.0.0.1:8785"):  # the desktop narrator's default address: not on this device
        raise urllib.error.URLError("no narrator on this device")
    if not url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise urllib.error.URLError("only https and this device are allowed from the browser")
    try:
        xhr = js.XMLHttpRequest.new()
        xhr.open(req.get_method(), url, False)
    except Exception as e:  # noqa: BLE001
        raise urllib.error.URLError(f"cannot open {url}: {e}") from None
    xhr.overrideMimeType("text/plain; charset=x-user-defined")  # bytes through untouched
    headers = dict(req.header_items())
    if "api.anthropic.com" in url:
        headers["anthropic-dangerous-direct-browser-access"] = "true"
    for k, v in headers.items():
        if k.lower() not in ("content-length", "host", "connection", "user-agent", "accept-encoding"):
            xhr.setRequestHeader(k, v)
    body = req.data
    try:
        if body is None:
            xhr.send()
        else:
            xhr.send(js.Uint8Array.new(body))
    except Exception as e:  # noqa: BLE001 - network or CORS failure
        raise urllib.error.URLError(f"network or CORS error: {e}") from None
    if xhr.status == 0:
        raise urllib.error.URLError("network or CORS error")
    raw = bytes(ord(c) & 0xFF for c in str(xhr.responseText))
    msg = email.message.Message()
    for line in str(xhr.getAllResponseHeaders()).split("\r\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            msg[k.strip()] = v.strip()
    if xhr.status >= 400:
        raise urllib.error.HTTPError(url, int(xhr.status), str(xhr.statusText), msg, io.BytesIO(raw))
    return _Resp(raw, int(xhr.status), msg, url)


urllib.request.urlopen = _browser_urlopen

# -- the server, over an in-memory socket -----------------------------------------------------------------
sys.path.insert(0, "/app")
from book_reader import server  # noqa: E402


class _Sock:
    def __init__(self, raw: bytes):
        self._in = io.BytesIO(raw)
        self.out = bytearray()

    def makefile(self, mode, *a, **k):
        return self._in

    def sendall(self, b):
        self.out += b

    def settimeout(self, *a):
        pass

    def setsockopt(self, *a):
        pass

    def close(self):
        pass

    def shutdown(self, *a):
        pass


class _Server:
    server_name = "localhost"
    server_port = 443


def handle(method: str, path: str, headers: dict, body: bytes | None):
    """One request through the real Handler. Returns (status, [(header, value)], body bytes)."""
    if hasattr(body, "to_bytes"):  # a JavaScript Uint8Array
        body = body.to_bytes()
    body = bytes(body or b"")
    if hasattr(headers, "to_py"):
        headers = headers.to_py()
    h = {k: v for k, v in dict(headers).items() if k.lower() not in ("content-length", "accept-encoding", "connection")}
    h["Host"] = "localhost"
    if body:
        h["Content-Length"] = str(len(body))
    head = f"{method} {path} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in h.items()) + "\r\n"
    sock = _Sock(head.encode("latin-1") + body)
    server.Handler(sock, ("127.0.0.1", 0), _Server())
    raw = bytes(sock.out)
    sep = raw.find(b"\r\n\r\n")
    if sep < 0:
        return 502, [], b"no response"
    lines = raw[:sep].decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ")[1])
    hs = [tuple(x.strip() for x in ln.split(":", 1)) for ln in lines[1:] if ":" in ln]
    return status, [x for x in hs if x[0].lower() not in ("content-length", "server", "date", "connection")], raw[sep + 4:]


# -- sync between the user's own devices (no server: see web/sync.js) ------------------------------------
import json as _json
import re
from pathlib import Path as _Path

from book_reader import library as _library, sync as _sync

_PENDING = _Path(DATA) / "pending"  # operations and cards for books this device does not have yet


def _cards(bid: str) -> dict:
    d = _library.LIB / bid / "cards"
    return {p.name: p.read_text() for p in sorted(d.glob("*.json"))} if d.is_dir() else {}


def _apply_pending():
    if not _PENDING.is_dir():
        return
    have = {b["id"] for b in _library.list_books()}
    for f in _PENDING.glob("*.json"):
        bid = f.stem
        if bid in have:
            got = _json.loads(f.read_text())
            _sync.add(bid, got.get("ops") or [])
            _write_cards(bid, got.get("cards") or {})
            f.unlink()


def _write_cards(bid: str, cards: dict) -> int:
    d, n = _library.LIB / bid / "cards", 0
    for name, text in cards.items():
        if not (name.endswith(".json") and name[:-5].isdigit()):
            continue
        p = d / name
        if not p.exists():
            d.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
            n += 1
    return n


def sync_export() -> dict:
    _apply_pending()
    out = _sync.export_all()
    out["cards"] = {b: _cards(b) for b in out["books"]}
    out["have"] = [{"id": b["id"], "title": b["title"]} for b in _library.list_books()]
    if _PENDING.is_dir():  # pass along what other devices sent for books this one lacks, so it reaches the rest
        for f in _PENDING.glob("*.json"):
            got = _json.loads(f.read_text())
            out["books"].setdefault(f.stem, got.get("ops") or [])
            out["cards"].setdefault(f.stem, got.get("cards") or {})
    return out


def sync_import(data: dict) -> dict:
    res = _sync.import_all(data)
    cards = data.get("cards") or {}
    n = 0
    for bid in res["skipped_books"]:
        _PENDING.mkdir(parents=True, exist_ok=True)
        f = _PENDING / f"{bid}.json"
        if not re.fullmatch(r"[\w-]{1,120}", bid):
            continue
        old = _json.loads(f.read_text()) if f.exists() else {"ops": [], "cards": {}}
        seen = {o.get("id") for o in old["ops"]}
        old["ops"] += [o for o in data["books"][bid] if o.get("id") not in seen]
        old["cards"] = {**(cards.get(bid) or {}), **old["cards"]}
        f.write_text(_json.dumps(old))
    for bid, cs in cards.items():
        if bid not in res["skipped_books"]:
            n += _write_cards(bid, cs)
    return {**res, "cards": n}


def sync_adopt(lib: str) -> dict:
    if not (lib.startswith("cp-") and len(lib) < 40 and lib[3:].isalnum()):
        raise ValueError("bad library id")
    _library.LIB.mkdir(parents=True, exist_ok=True)
    (_library.LIB / "library.json").write_text(_json.dumps({"id": lib, "format": 2}))
    return {"id": lib}


def _json_resp(obj, code=200):
    return code, [("Content-Type", "application/json")], _json.dumps(obj).encode()


_handle = handle


def handle(method: str, path: str, headers: dict, body: bytes | None):  # noqa: F811 - wraps the server
    if path.startswith("/api/x/"):
        if hasattr(body, "to_bytes"):
            body = body.to_bytes()
        try:
            if path == "/api/x/sync/export":
                return _json_resp(sync_export())
            if path == "/api/x/sync/import" and method == "POST":
                return _json_resp(sync_import(_json.loads(bytes(body or b"{}"))))
            if path == "/api/x/sync/adopt" and method == "POST":
                return _json_resp(sync_adopt(str(_json.loads(bytes(body or b"{}")).get("library", ""))))
            if path.startswith("/api/x/epub/"):
                bid = path.rsplit("/", 1)[1]
                p = _library.LIB / bid / "book.epub"
                if "/" in bid or ".." in bid or not p.is_file():
                    return _json_resp({"error": "not found"}, 404)
                return 200, [("Content-Type", "application/epub+zip")], p.read_bytes()
        except (ValueError, KeyError) as e:
            return _json_resp({"error": str(e)}, 400)
        return _json_resp({"error": "not found"}, 404)
    out = _handle(method, path, headers, body)
    if method == "POST" and path == "/api/books" and out[0] == 200:
        _apply_pending()  # a book arrived: operations other devices sent for it apply now
    return out

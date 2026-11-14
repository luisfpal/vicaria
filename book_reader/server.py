"""A small local HTTP server: JSON API, Server-Sent Events for streaming, static files."""
from __future__ import annotations

import json
import mimetypes
import re
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import lru_cache
from urllib.parse import parse_qs, quote, urlparse

import json as _json

import gzip
import hashlib
import zipfile

import threading

from . import backgrounds, cards, chat, diagram, excalidraw, figure, ideas, library, llm, quality, shelf, structure, sync, tts

STATIC = Path(__file__).resolve().parent / "static"
MAX_UPLOAD = 200 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "Commonplace"

    def log_message(self, fmt, *args):  # quiet; never log request bodies
        pass

    # -- helpers --------------------------------------------------------------------------------
    def _body(self, data: bytes, ctype: str, code=200, headers=()):
        """Send a body, gzipped when the browser accepts it and it is worth it (text over 1 KB)."""
        gz = len(data) > 1024 and "gzip" in self.headers.get("Accept-Encoding", "") and not ctype.startswith(("image/", "audio/"))
        if gz:
            data = _gzip(data)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, obj, code=200):
        self._body(json.dumps(obj).encode(), "application/json", code, [("Cache-Control", "no-cache")])

    def send_file(self, path: Path, ctype=None, download=None, cache="no-cache"):
        """Static files carry an ETag, so a revisit costs one small 304 instead of the whole file."""
        st = path.stat()
        tag = f'"{int(st.st_mtime)}-{st.st_size}"'
        if self.headers.get("If-None-Match") == tag and not download:
            self.send_response(304); self.send_header("ETag", tag); self.end_headers(); return
        hs = [("Cache-Control", cache), ("ETag", tag)]
        if download:
            hs.append(("Content-Disposition", f'attachment; filename="{download}"'))
        self._body(_read_cached(str(path), st.st_mtime), ctype or mimetypes.guess_type(path.name)[0] or "application/octet-stream", 200, hs)

    IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
                   ".webp": "image/webp", ".svg": "image/svg+xml"}

    def send_image(self, book_id, inner):
        """An image from inside the book's EPUB. Only paths the EPUB itself lists as images; SVG can never run script."""
        b = library.book(book_id)
        inner = b.cover if inner is None else inner
        ext = "." + inner.rsplit(".", 1)[-1].lower() if "." in inner else ""
        if inner not in b.images or ext not in self.IMAGE_TYPES:
            return self.send_json({"error": "not found"}, 404)
        epub_path = library.LIB / book_id / "book.epub"
        tag = '"' + hashlib.sha1(f"{epub_path.stat().st_mtime}{inner}".encode()).hexdigest()[:16] + '"'
        if self.headers.get("If-None-Match") == tag:
            self.send_response(304); self.send_header("ETag", tag); self.end_headers(); return
        with zipfile.ZipFile(epub_path) as zf:
            data = zf.read(inner)
        self.send_response(200)
        self.send_header("Content-Type", self.IMAGE_TYPES[ext])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=604800")
        self.send_header("ETag", tag)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        self.end_headers()
        self.wfile.write(data)

    def send_speech(self, voice, text):
        """One narrated passage. GET so an <audio> element can play it directly; cached on disk and in the browser."""
        if not text.strip():
            return self.send_json({"error": "no text"}, 400)
        cache = library.LIB / ".tts-cache" / hashlib.sha1(f"kokoro\n{voice}\n{text}".encode()).hexdigest()
        if cache.is_file():
            audio = cache.read_bytes()
        else:
            try:
                audio, _ = tts.speak(voice, text)
            except RuntimeError as e:
                return self.send_json({"error": str(e)}, 502)
            cache.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache.with_suffix(".part")
            tmp.write_bytes(audio)
            tmp.replace(cache)
        # Safari plays media only from servers that answer byte ranges
        lo, hi, code = 0, len(audio) - 1, 200
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        if m and (m.group(1) or m.group(2)):
            lo, hi = (int(m.group(1)), min(int(m.group(2) or hi), hi)) if m.group(1) else (max(0, len(audio) - int(m.group(2))), hi)
            if lo > hi:
                self.send_response(416); self.send_header("Content-Range", f"bytes */{len(audio)}"); self.end_headers(); return
            code = 206
        self.send_response(code)
        self.send_header("Content-Type", tts.mime(audio))
        self.send_header("Accept-Ranges", "bytes")
        if code == 206:
            self.send_header("Content-Range", f"bytes {lo}-{hi}/{len(audio)}")
        self.send_header("Content-Length", str(hi - lo + 1))
        self.send_header("Cache-Control", "private, max-age=2592000")
        self.end_headers()
        self.wfile.write(audio[lo:hi + 1])

    def sse(self, gen):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def emit(event, data):
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        try:
            for piece in gen:
                if piece is library.RESET:
                    emit("reset", {})
                else:
                    emit("chunk", piece)
            emit("done", {})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                emit("fail", str(e) if isinstance(e, (llm.LLMError, KeyError, IndexError)) else f"Unexpected error: {e}")
            except OSError:
                pass

    # -- routes ---------------------------------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = u.path
        try:
            if path in ("/", "/ideas", "/settings") or re.fullmatch(r"/book/[\w-]+(/\d+|/book|/matter)?", path):
                return self.send_file(STATIC / "index.html", "text/html; charset=utf-8")
            if path == "/sw.js":  # served from the root so it may look after every page
                return self.send_file(STATIC / "sw.js", "text/javascript; charset=utf-8")
            if path == "/manifest.webmanifest":
                return self.send_file(STATIC / "manifest.webmanifest", "application/manifest+json")
            if path == "/api/settings":
                return self.send_json(llm.settings_view())
            if path == "/api/sync":
                return self.send_json(sync.export_all() if q.get("library") == sync.library_id() else {"error": "pairing code does not match"},
                                      200 if q.get("library") == sync.library_id() else 403)
            if path == "/api/library":
                return self.send_json({"id": sync.library_id(), "reader": sync.reader()})
            if path == "/api/graph/node":
                return self.send_json({"passages": ideas.evidence(q.get("id", ""))})
            if path.startswith("/static/"):
                f = (STATIC / path[len("/static/"):]).resolve()
                if STATIC in f.parents and f.is_file():
                    return self.send_file(f)
                return self.send_json({"error": "not found"}, 404)
            if path == "/api/providers":
                return self.send_json(llm.public_view())
            if path == "/api/books":
                return self.send_json(library.list_books())
            if path == "/api/voices":
                return self.send_json(tts.voices())
            if path == "/api/tts":
                return self.send_speech(q.get("voice", ""), q.get("text", "")[:2000])
            if path == "/api/ideas":
                return self.send_json(ideas.lattice())
            if path == "/api/trash":
                return self.send_json({"books": shelf.trash()})
            if path == "/api/graph":
                return self.send_json(ideas.graph())
            if path == "/api/across":
                if q.get("make") == "1":
                    try:
                        cards.make_across(q.get("provider") or None)
                    except llm.LLMError as e:
                        return self.send_json({"error": str(e)}, 502)
                return self.send_json({"across": cards.across()})
            m = re.fullmatch(r"/api/backgrounds/([0-9a-f]{16})", path)
            if m:
                f = backgrounds.find(m.group(1))
                return self.send_file(f[0], f[1], cache="public, max-age=31536000, immutable") if f else self.send_json({"error": "not found"}, 404)
            m = re.fullmatch(r"/api/books/([\w-]+)/(image|cover)", path)
            if m:
                return self.send_image(m.group(1), q.get("p", "") if m.group(2) == "image" else None)
            m = re.fullmatch(r"/api/books/([\w-]+)/search", path)
            if m:
                return self.send_json({"results": library.search(m.group(1), q.get("q", ""))})
            m = re.fullmatch(r"/api/books/([\w-]+)/highlights\.md", path)
            if m:
                bid = m.group(1); b = library.book(bid)
                lines = [f"# {b.title}", f"*{', '.join(b.authors)}*" if b.authors else "", "", "## Highlights", ""]
                last = None
                for h in sync.highlights(bid):
                    ch = h.get("chapter", 0)
                    if ch != last and 0 <= ch < len(b.chapters):
                        lines += ["", f"### {b.chapters[ch].title}", ""]; last = ch
                    lines.append(f"> {' '.join(str(h.get('quote', '')).split())}\n")
                body = "\n".join(lines).strip().encode() + b"\n"
                self.send_response(200)
                self.send_header("Content-Type", "text/markdown; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{bid}-highlights.md"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            m = re.fullmatch(r"/api/books/([\w-]+)/(position|highlights|offline)", path)
            if m:
                bid, what = m.groups()
                if what == "position":
                    return self.send_json({"position": sync.position(bid)})
                if what == "highlights":
                    return self.send_json({"highlights": sync.highlights(bid)})
                return self.send_json({"urls": offline_urls(bid)})
            m = re.fullmatch(r"/api/books/([\w-]+)/matter", path)
            if m:
                b = library.book(m.group(1))
                return self.send_json({"sections": [{"index": c.index, "title": c.title, "blocks": c.blocks}
                                                    for c in b.chapters if c.kind == "matter"]})
            m = re.fullmatch(r"/api/books/([\w-]+)/chapters/(\d+)/card", path)
            if m:
                bid, i = m.group(1), int(m.group(2))
                c = cards.card(bid, i)
                if q.get("make") == "1" and (not c or q.get("force") == "1"):  # force: write it again (new card rules)
                    try:
                        c = cards.make_card(bid, i, q.get("provider") or None, force=q.get("force") == "1")
                    except llm.LLMError as e:
                        return self.send_json({"error": str(e)}, 502)
                fig = next((x for x in library.book(bid).chapters[i].blocks if x["type"] == "img"), None)
                return self.send_json({"card": c, "diagram": figure.view((c or {}).get("diagram")), "figure": fig})
            m = re.fullmatch(r"/api/books/([\w-]+)/core", path)
            if m:
                bid = m.group(1)
                c = cards.core(bid)
                return self.send_json({"core": c, "diagram": figure.view((c or {}).get("diagram")),
                                       "job": cards.job(bid)})
            if path == "/api/skills":
                return self.send_json(chat.skills())
            m = re.fullmatch(r"/api/books/([\w-]+)/chat/(book|\d+)", path)
            if m:
                return self.send_json({"messages": chat.messages(m.group(1), m.group(2))})
            m = re.fullmatch(r"/api/books/([\w-]+)/chat/(book|\d+)/(\d+)\.excalidraw", path)
            if m:
                bid, scope, n = m.group(1), m.group(2), int(m.group(3))
                lay = chat.messages(bid, scope)[n].get("diagram")
                if not lay:
                    return self.send_json({"error": "no diagram"}, 404)
                body = _json.dumps(diagram.to_excalidraw(lay, library.book(bid).title), indent=1).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Disposition", f'attachment; filename="{bid}-{scope}-diagram-{n}.excalidraw"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            m = re.fullmatch(r"/api/books/([\w-]+)", path)
            if m:
                bid = m.group(1)
                b = library.book(bid)
                return self.send_json({
                    "id": bid, "title": b.title, "authors": b.authors, "language": b.language, "cover": bool(b.cover),
                    "synthesis": library.synthesis(bid) is not None, "job": cards.job(bid),
                    "core": cards.core(bid), "structure": {"flagged": b.toc != "ai" and quality.score(b)["score"] < quality.THRESHOLD, "ai": b.toc == "ai"},
                    "matter": list(dict.fromkeys(c.title.strip(" .") for c in b.chapters if c.kind == "matter" and c.words >= 20)),
                    "chapters": [{"index": c.index, "title": c.title, "words": c.words, "kind": c.kind, "depth": c.depth,
                                  "parent": c.parent, "trail": c.trail, "heads": c.heads,
                                  "lesson": (cards.card(bid, c.index) or {}).get("core") if c.kind == "chapter" else None}
                                 for c in b.chapters if c.kind != "matter"]})
            m = re.fullmatch(r"/api/books/([\w-]+)/chapters/(\d+)", path)
            if m:
                bid, i = m.group(1), int(m.group(2))
                c = library.book(bid).chapters[i]
                return self.send_json({"index": i, "title": c.title, "kind": c.kind, "words": c.words,
                                       "blocks": c.blocks, "note": library.note(bid, i)})
            m = re.fullmatch(r"/api/books/([\w-]+)/chapters/(\d+)/distill", path)
            if m and library.book(m.group(1)).chapters[int(m.group(2))].kind != "chapter":
                return self.send_json({"error": "Front and back matter is not distilled."}, 400)
            if m:
                return self.sse(library.distill_chapter(m.group(1), int(m.group(2)), q.get("provider") or None,
                                                        force=q.get("force") == "1"))
            m = re.fullmatch(r"/api/books/([\w-]+)/synthesis", path)
            if m:
                return self.send_json({"synthesis": library.synthesis(m.group(1))})
            m = re.fullmatch(r"/api/books/([\w-]+)/synthesis/distill", path)
            if m:
                return self.sse(library.distill_book(m.group(1), q.get("provider") or None, force=q.get("force") == "1"))
            m = re.fullmatch(r"/api/books/([\w-]+)/job", path)
            if m:
                return self.send_json(library.job_status(m.group(1)))
            m = re.fullmatch(r"/api/books/([\w-]+)/glossary", path)
            if m:
                return self.send_json({"terms": cards.glossary(m.group(1))})
            m = re.fullmatch(r"/api/books/([\w-]+)/structure", path)
            if m:
                return self.send_json(structure.status(m.group(1)))
            m = re.fullmatch(r"/api/books/([\w-]+)/(?:chapters/(\d+)/)?map\.excalidraw", path)
            if m:
                bid, i = m.group(1), m.group(2)
                if i is None:
                    n, title, name = library.synthesis(bid), library.book(bid).title, "whole-book-map"
                else:
                    n, title, name = library.note(bid, int(i)), library.book(bid).chapters[int(i)].title, f"chapter-{int(i):02d}-map"
                if not n:
                    return self.send_json({"error": "no notes yet"}, 404)
                body = excalidraw.dumps(n["markdown"], title).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Disposition", f'attachment; filename="{bid}-{name}.excalidraw"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            m = re.fullmatch(r"/api/books/([\w-]+)/export", path)
            if m:
                out = library.export(m.group(1))
                return self.send_file(out, "text/markdown; charset=utf-8", download=f"{m.group(1)}-study-guide.md")
            self.send_json({"error": "not found"}, 404)
        except (KeyError, IndexError):
            self.send_json({"error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e)}, 500)

    def do_PUT(self):
        self.do_POST()

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_UPLOAD:
                return self.send_json({"error": "file too large"}, 413)
            body = self.rfile.read(n)
            if u.path == "/api/backgrounds":
                return self.send_json({"id": backgrounds.save(body)})
            if u.path == "/api/books":
                bid = library.import_epub(body, self.headers.get("X-Filename", "book.epub"))
                shelf.added(bid)
                threading.Thread(target=structure.sweep, daemon=True).start()
                return self.send_json({"id": bid})
            m = re.fullmatch(r"/api/trash/([\w-]+)/restore", u.path)
            if m:
                return self.send_json(shelf.restore(m.group(1)))
            m = re.fullmatch(r"/api/books/([\w-]+)/models", u.path)
            if m:
                try:
                    return self.send_json(ideas.tag_book(m.group(1), json.loads(body or b"{}").get("provider") or None))
                except llm.LLMError as e:
                    return self.send_json({"error": str(e)}, 502)
            m = re.fullmatch(r"/api/books/([\w-]+)/chat/(book|\d+)", u.path)
            if m:
                req = json.loads(body or b"{}")
                return self.sse(chat.respond(m.group(1), m.group(2), req.get("provider") or None,
                                             message=req.get("message"), generate=req.get("generate")))
            if u.path == "/api/ops":  # operations from one device: {"book": id or null, "ops": [...]}
                req = json.loads(body or b"{}")
                return self.send_json({"added": sync.add(req.get("book") or None, req.get("ops") or [])})
            if u.path == "/api/sync":
                return self.send_json(sync.import_all(json.loads(body or b"{}")))
            if u.path == "/api/settings":
                req = json.loads(body or b"{}")
                llm.set_choice(str(req.get("provider", "")), str(req.get("model", "")), req.get("custom"), req.get("fallback"))
                return self.send_json(llm.settings_view())
            m = re.fullmatch(r"/api/keys/([\w-]+)(/check)?", u.path)
            if m:
                pid = m.group(1)
                if not m.group(2):
                    llm.save_key(pid, str(json.loads(body or b"{}").get("key", "")))
                return self.send_json({"check": llm.check(pid), **llm.settings_view()})
            if u.path == "/api/recap":
                req = json.loads(body or b"{}")
                try:
                    return self.send_json({"recap": chat.recap(req["book"], int(req["chapter"]), int(req.get("block", 0)))})
                except llm.LLMError as e:
                    return self.send_json({"error": str(e)}, 502)
            m = re.fullmatch(r"/api/books/([\w-]+)/cards", u.path)
            if m:
                return self.send_json(cards.start(m.group(1), (json.loads(body or b"{}").get("provider")) or None))
            m = re.fullmatch(r"/api/books/([\w-]+)/structure/(repair|revert)", u.path)
            if m:
                if m.group(2) == "revert":
                    return self.send_json(structure.revert(m.group(1)))
                return self.send_json(structure.repair(m.group(1), (json.loads(body or b"{}").get("provider")) or None))
            m = re.fullmatch(r"/api/books/([\w-]+)/job", u.path)
            if m:
                provider = (json.loads(body or b"{}").get("provider")) or None
                return self.send_json(library.start_job(m.group(1), provider))
            self.send_json({"error": "not found"}, 404)
        except ValueError as e:
            self.send_json({"error": str(e)}, 400)
        except KeyError:
            self.send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        k = re.fullmatch(r"/api/keys/(\w+)", urlparse(self.path).path)
        if k:
            try:
                return self.send_json({"removed": llm.remove_key(k.group(1)), **llm.settings_view()})
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
        m = re.fullmatch(r"/api/books/([\w-]+)", urlparse(self.path).path)
        if m:
            try:
                return self.send_json(shelf.delete(m.group(1)))
            except KeyError:
                return self.send_json({"error": "not found"}, 404)
        m = re.fullmatch(r"/api/books/([\w-]+)/chat/(book|\d+)", urlparse(self.path).path)
        if not m:
            return self.send_json({"error": "not found"}, 404)
        chat.clear(m.group(1), m.group(2))
        self.send_json({"ok": True})


@lru_cache(maxsize=64)
def _gzip_cached(data: bytes) -> bytes:
    return gzip.compress(data, 6)


def _gzip(data: bytes) -> bytes:
    return _gzip_cached(data) if len(data) > 64 * 1024 else gzip.compress(data, 6)


@lru_cache(maxsize=64)
def _read_cached(path: str, mtime: float) -> bytes:
    return Path(path).read_bytes()


def offline_urls(book_id: str) -> list[str]:
    """Everything Read needs for one book, so the app can keep it for reading without a connection."""
    b = library.book(book_id)
    base = f"/api/books/{book_id}"
    urls = [base, f"{base}/core", f"{base}/matter", f"{base}/position", f"{base}/highlights"]
    if b.cover:
        urls.append(f"{base}/cover")
    for c in b.chapters:
        if c.kind == "chapter":
            urls += [f"{base}/chapters/{c.index}", f"{base}/chapters/{c.index}/card"]
            urls += [f"{base}/image?p={quote(x['src'], safe='')}" for x in c.blocks if x["type"] == "img"]
    return urls


def serve(host="127.0.0.1", port=8765):
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    print(f"Commonplace on http://{host}:{port}  (library: {library.LIB})", flush=True)
    httpd.serve_forever()

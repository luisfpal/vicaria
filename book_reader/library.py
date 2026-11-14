"""Books and notes on disk. Markdown files are the source of truth; no database.

library/<book-id>/book.epub
library/<book-id>/notes/NN-<title>.md   one per distilled chapter
library/<book-id>/book.md               the whole-book synthesis
library/<book-id>/study-guide.md        export: synthesis + every chapter
"""
from __future__ import annotations

import json
import os
import re
import time
import shutil
import threading
from functools import lru_cache
from pathlib import Path
from typing import Iterator

from . import epub, excalidraw, llm, prompts

LIB = Path(os.environ.get("BOOK_READER_LIBRARY", Path(__file__).resolve().parent.parent / "library"))
HEADER = re.compile(r"^<!-- book_reader digest=(\S+) v=(\S+) model=(\S+) -->\n")
RESET = object()  # yielded when a malformed draft is thrown away and rewritten
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def slug(s: str, n: int = 60) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:n].strip("-") or "book"


def _lock(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


@lru_cache(maxsize=16)
def _parse(path: str, mtime: float, fix_mtime: float = 0) -> epub.Book:
    b = epub.parse(path)
    if fix_mtime:
        from . import structure
        try:
            structure.apply(b, json.loads((Path(path).parent / "structure.json").read_text()))
        except (OSError, ValueError, KeyError):
            pass  # an unreadable repair is ignored: the book opens as the EPUB splits it
    return b


def book(book_id: str) -> epub.Book:
    """The parsed book, with its AI structure repair applied when there is one (structure.json beside the EPUB)."""
    p = LIB / book_id / "book.epub"
    if not p.is_file():
        raise KeyError(book_id)
    fix = LIB / book_id / "structure.json"
    return _parse(str(p), p.stat().st_mtime, fix.stat().st_mtime if fix.is_file() else 0)


@lru_cache(maxsize=16)
def raw(book_id: str, mtime: float = 0) -> epub.Book:
    """The book as split without any repair: to find cards made before a repair, and to measure what repairs change."""
    return epub.parse(str(LIB / book_id / "book.epub"), repair=False)


def import_epub(data: bytes, filename: str = "book.epub") -> str:
    tmp = LIB / ".incoming.epub"
    LIB.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(data)
    try:
        b = epub.parse(str(tmp))
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise ValueError(f"Not a readable EPUB: {e}") from None
    book_id = slug(b.title) or slug(Path(filename).stem)
    (LIB / book_id / "notes").mkdir(parents=True, exist_ok=True)
    shutil.move(str(tmp), LIB / book_id / "book.epub")
    return book_id


def list_books() -> list[dict]:
    out = []
    if LIB.is_dir():
        for d in sorted(LIB.iterdir()):
            if (d / "book.epub").is_file():
                b = book(d.name)
                chapters = [c for c in b.chapters if c.kind == "chapter"]
                done = sum(1 for c in chapters if note(d.name, c.index))
                out.append({"id": d.name, "title": b.title, "authors": b.authors,
                            "chapters": len(chapters), "distilled": done, "cover": bool(b.cover),
                            "synthesis": (d / "book.md").is_file(), "progress": _position(d.name)})
    return out


def _position(book_id: str) -> dict | None:
    from . import sync
    return sync.position(book_id)


def progress(book_id: str) -> dict | None:
    """Where the reader stopped: library/<book>/progress.json, shared by every device that opens this library."""
    p = LIB / book_id / "progress.json"
    try:
        return json.loads(p.read_text()) if p.is_file() else None
    except ValueError:
        return None




def note_path(book_id: str, ch: epub.Chapter) -> Path:
    return LIB / book_id / "notes" / f"{ch.index:02d}-{slug(ch.title, 40)}.md"


def _read(path: Path) -> tuple[str, dict] | None:
    if not path.is_file():
        return None
    raw = path.read_text()
    m = HEADER.match(raw)
    meta = {"digest": m.group(1), "v": m.group(2), "model": m.group(3)} if m else {}
    return raw[m.end():] if m else raw, meta


def note(book_id: str, index: int) -> dict | None:
    ch = book(book_id).chapters[index]
    got = _read(note_path(book_id, ch))
    if not got:
        return None
    md, meta = got
    if meta and (meta["digest"] != ch.digest or meta["v"] != prompts.VERSION):
        return None  # stale: chapter text or prompt changed
    return {"markdown": md, "model": meta.get("model", "edited")}


def synthesis(book_id: str) -> dict | None:
    got = _read(LIB / book_id / "book.md")
    if not got:
        return None
    md, meta = got
    return {"markdown": md, "model": meta.get("model", "edited")}


def _write(path: Path, md: str, digest: str, model: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"<!-- book_reader digest={digest} v={prompts.VERSION} model={model} -->\n{md.strip()}\n")


def _generate(provider, system, user, headings, attempts=2):
    """Stream a draft; if its shape is wrong, throw it away (RESET) and write it once more."""
    for attempt in range(attempts):
        parts = []
        for piece in llm.stream(provider, system, user):
            parts.append(piece)
            yield piece
        body = "".join(parts).strip()
        if not prompts.shape_problems(body, headings) or attempt == attempts - 1:
            return body
        yield RESET


def distill_chapter(book_id: str, index: int, provider: str, force: bool = False) -> Iterator[str]:
    """Yield Markdown pieces; the full note is saved when the stream completes."""
    b = book(book_id)
    ch = b.chapters[index]
    with _lock(f"{book_id}/{index}"):
        cached = None if force else note(book_id, index)
        if cached:
            yield cached["markdown"]
            return
        system, user = prompts.chapter_prompt(b, ch)
        body = yield from _generate(provider, system, user, prompts.CHAPTER_HEADINGS)
        md = f"# {ch.title}\n\n" + body
        _write(note_path(book_id, ch), md, ch.digest, llm.model_name(provider))
    export(book_id)


def distill_book(book_id: str, provider: str, force: bool = False) -> Iterator[str]:
    b = book(book_id)
    notes = []
    for c in b.chapters:
        if c.kind == "chapter":
            n = note(book_id, c.index)
            if not n:
                raise llm.LLMError(f"Chapter \"{c.title}\" is not distilled yet.")
            notes.append((c.title, n["markdown"]))
    with _lock(f"{book_id}/book"):
        cached = None if force else synthesis(book_id)
        if cached:
            yield cached["markdown"]
            return
        system, user = prompts.book_prompt(b, notes)
        body = yield from _generate(provider, system, user, prompts.BOOK_HEADINGS)
        md = f"# {b.title}: the whole book\n\n" + body
        _write(LIB / book_id / "book.md", md, "book", llm.model_name(provider))
    export(book_id)


def export(book_id: str) -> Path:
    with _lock(f"{book_id}/export"):  # parallel chapter jobs all export; one at a time
        return _export(book_id)


def _export(book_id: str) -> Path:
    b = book(book_id)
    lines = [f"# {b.title}", f"*{', '.join(b.authors)}*" if b.authors else "", ""]
    syn = synthesis(book_id)
    if syn:
        lines += [syn["markdown"].split("\n", 1)[-1].strip(), "", "---", ""]
    for c in b.chapters:
        n = note(book_id, c.index) if c.kind == "chapter" else None
        if n:
            lines += [n["markdown"].replace("\n## ", "\n### ").replace(f"# {c.title}", f"## {c.title}", 1), ""]
    # editable Excalidraw maps next to the Markdown
    diagrams = LIB / book_id / "diagrams"
    diagrams.mkdir(exist_ok=True)
    for old in diagrams.glob("*.excalidraw"):
        old.unlink()
    if syn:
        (diagrams / "whole-book-map.excalidraw").write_text(excalidraw.dumps(syn["markdown"], b.title))
    for c in b.chapters:
        n = note(book_id, c.index) if c.kind == "chapter" else None
        if n and "```map" in n["markdown"]:
            (diagrams / f"chapter-{c.index:02d}-map.excalidraw").write_text(excalidraw.dumps(n["markdown"], c.title))
    out = LIB / book_id / "study-guide.md"
    out.write_text("\n".join(lines).strip() + "\n")
    return out


# ---- background "distill the whole book" job --------------------------------------------------
_jobs: dict[str, dict] = {}


def job_status(book_id: str) -> dict:
    return _jobs.get(book_id, {"state": "idle"})


def start_job(book_id: str, provider: str, workers: int = 4) -> dict:
    if job_status(book_id).get("state") == "running":
        return job_status(book_id)
    b = book(book_id)
    todo = [c.index for c in b.chapters if c.kind == "chapter" and not note(book_id, c.index)]
    st = _jobs[book_id] = {"state": "running", "total": len(todo) + 1, "done": 0, "errors": [], "current": []}

    def one(i):
        st["current"].append(i)
        try:
            for _ in distill_chapter(book_id, i, provider):
                pass
        except Exception as e:
            st["errors"].append(f"{b.chapters[i].title}: {e}")
        finally:
            st["current"].remove(i)
            st["done"] += 1

    def run():
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(one, todo))
        if not st["errors"]:
            try:
                for _ in distill_book(book_id, provider, force=True):
                    pass
            except Exception as e:
                st["errors"].append(f"Synthesis: {e}")
        if not st["errors"]:
            try:  # file the book's principles under mental models for the library-wide latticework
                from . import ideas
                ideas.tag_book(book_id, provider)
            except Exception as e:
                st["errors"].append(f"Mental models: {e}")
        st["done"] = st["total"]
        st["state"] = "error" if st["errors"] else "done"

    threading.Thread(target=run, daemon=True).start()
    return st


def _fold(t: str) -> str:
    """Lower case without accents, same length as the input, so offsets found in it point into the original text."""
    import unicodedata
    return "".join((unicodedata.normalize("NFKD", ch)[:1] or ch).lower() for ch in t)


def search(book_id: str, q: str, limit: int = 60) -> list[dict]:
    """Every place a phrase appears in the book's chapters and parts, in reading order, with a little context."""
    q = " ".join(q.split())
    if len(q) < 2:
        return []
    needle, out = _fold(q), []
    for c in book(book_id).chapters:
        if c.kind == "matter":
            continue
        for i, b in enumerate(c.blocks):
            t = b.get("text") or ""
            hay, at = _fold(t), 0
            while (at := hay.find(needle, at)) >= 0:
                a, z = max(0, at - 70), min(len(t), at + len(q) + 70)
                out.append({"chapter": c.index, "title": c.title, "block": i, "offset": at, "len": len(q),
                            "before": ("…" if a else "") + t[a:at], "match": t[at:at + len(q)], "after": t[at + len(q):z] + ("…" if z < len(t) else "")})
                if len(out) >= limit:
                    return out
                at += len(needle)
    return out

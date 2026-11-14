"""Deleting a book: it moves to a trash folder for 30 days, then goes for good. Undo puts it back as it was.

    library/.trash/<book>/            the whole book folder: the EPUB, cards, notes, mental models, chats, operations
    library/.trash/<book>/trashed.json  {"t": ms, "title": ...}

Deleting and restoring are also operations ("shelf", in library/.ops), so a paired copy of the library applies the
same change when it syncs: for each book the newest shelf operation wins (see SYNC.md).
"""
from __future__ import annotations

import json
import shutil
import time

from . import library, sync

DAYS = 30


def _trash():
    return library.LIB / ".trash"


def _dev() -> str:
    return "server-" + sync.library_id()[3:11]


def _record(book_id: str, state: str) -> None:
    now = time.time_ns()
    sync.add(None, [{"id": f"{_dev()}.{now}", "dev": _dev(), "t": now // 1_000_000, "k": "shelf", "v": {"book": book_id, "state": state}}])


def _forget(book_id: str) -> None:
    from . import chat
    library._parse.cache_clear()
    chat._index.cache_clear()  # the search index of the book's paragraphs


def _move_to_trash(book_id: str, t: int) -> dict:
    src = library.LIB / book_id
    title = library.book(book_id).title
    dst = _trash() / book_id
    if dst.exists():
        shutil.rmtree(dst)  # an older deleted copy of the same book: the newer one is kept
    _trash().mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    (dst / "trashed.json").write_text(json.dumps({"t": t, "title": title}))
    _forget(book_id)
    return {"id": book_id, "title": title}


def _move_back(book_id: str) -> dict:
    src = _trash() / book_id
    if not (src / "book.epub").is_file():
        raise KeyError(book_id)
    if (library.LIB / book_id).exists():
        raise ValueError("A book with the same name is in the library again; delete that copy first.")
    (src / "trashed.json").unlink(missing_ok=True)
    shutil.move(str(src), str(library.LIB / book_id))
    _forget(book_id)
    return {"id": book_id, "title": library.book(book_id).title}


def delete(book_id: str) -> dict:
    library.book(book_id)  # KeyError when there is no such book
    _record(book_id, "trash")
    return _move_to_trash(book_id, int(time.time() * 1000))


def restore(book_id: str) -> dict:
    out = _move_back(book_id)
    _record(book_id, "shelf")
    return out


def added(book_id: str) -> None:
    """A newly imported book wins over an older deletion of the same book on a paired copy."""
    _record(book_id, "shelf")


def trash() -> list[dict]:
    """Books deleted in the last 30 days, newest first. Older ones are removed for good here."""
    out, now = [], time.time() * 1000
    if _trash().is_dir():
        for d in _trash().iterdir():
            try:
                meta = json.loads((d / "trashed.json").read_text())
            except (OSError, ValueError):
                continue
            left = DAYS - (now - meta["t"]) / 86_400_000
            if left <= 0:
                shutil.rmtree(d, ignore_errors=True)
                continue
            out.append({"id": d.name, "title": meta.get("title", d.name), "t": meta["t"], "days_left": max(1, int(left + 0.999))})
    return sorted(out, key=lambda x: -x["t"])


def apply() -> None:
    """Make the folders match the newest shelf operation of each book (after operations arrive from a paired copy)."""
    newest: dict[str, dict] = {}
    for o in sync.ops(None):
        if o.get("k") == "shelf" and (b := str(o["v"].get("book", ""))):
            if b not in newest or sync._key(o) > sync._key(newest[b]):
                newest[b] = o
    for b, o in newest.items():
        here = (library.LIB / b / "book.epub").is_file()
        if o["v"].get("state") == "trash" and here:
            _move_to_trash(b, o["t"])
        elif o["v"].get("state") == "shelf" and not here and (_trash() / b / "book.epub").is_file():
            _move_back(b)

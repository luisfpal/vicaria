"""Reading position, highlights and reader settings as append-only operations, merged last-writer-wins.

Each device writes only its own file, so two devices never edit the same file:

    library/<book>/ops/<device>.jsonl     position and highlight operations for one book
    library/.ops/<device>.jsonl           reader settings (theme, type) for the whole library

An operation is one JSON line: {"id": "<device>.<n>", "dev": "<device>", "t": <ms since 1970>, "k": kind, "v": value}.
Kinds: "pos" (where reading stopped), "hl" (a highlight added or changed), "hl-" (a highlight removed), "reader",
"shelf" (a book deleted or restored: {"book": id, "state": "trash" | "shelf"}). A "reader" value may name a background
picture ("bg": its id, with "bgBlur" and "bgDim"); the export carries that one picture (backgrounds.py).
Merging is a set union by "id"; the current value of any key is the operation with the largest (t, id).
Union is commutative, associative and idempotent, so devices can sync in any order, any number of times, through any
peer, and end up the same (a state-based CRDT: a grow-only set of operations with a last-writer-wins read).
Derived files (progress.json, highlights.json) are rewritten from the operations and can always be rebuilt.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

from . import library

KINDS = {"pos", "hl", "hl-", "reader", "listen", "shelf"}
DEV = re.compile(r"^[a-z0-9-]{4,40}$")
_lock = threading.Lock()


def library_id() -> str:
    """A random id made once per library. Two copies sync only when their ids match (the pairing code)."""
    f = library.LIB / "library.json"
    try:
        return json.loads(f.read_text())["id"]
    except (OSError, ValueError, KeyError):
        library.LIB.mkdir(parents=True, exist_ok=True)
        lid = "cp-" + secrets.token_hex(8)
        f.write_text(json.dumps({"id": lid, "format": 2}))
        return lid


def _dir(book_id: str | None) -> Path:
    if book_id is None:
        return library.LIB / ".ops"
    library.book(book_id)  # KeyError when there is no such book
    return library.LIB / book_id / "ops"


def ops(book_id: str | None) -> list[dict]:
    d, out = _dir(book_id), []
    if d.is_dir():
        for f in sorted(d.glob("*.jsonl")):
            for line in f.read_text().splitlines():
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue  # a torn last line from a crash is skipped, never fatal
    return out


def _valid(op: dict) -> dict | None:
    try:
        dev, t, k, v, oid = str(op["dev"]), int(op["t"]), str(op["k"]), op["v"], str(op["id"])
    except (KeyError, TypeError, ValueError):
        return None
    if not DEV.match(dev) or k not in KINDS or not oid.startswith(dev + ".") or not isinstance(v, dict):
        return None
    t = min(t, int(time.time() * 1000) + 5 * 60_000)  # a clock far in the future cannot win forever
    return {"id": oid, "dev": dev, "t": t, "k": k, "v": v}


def add(book_id: str | None, new: list[dict]) -> int:
    """Append operations not seen before (by id). Returns how many were new."""
    with _lock:
        d = _dir(book_id)
        seen = {o.get("id") for o in ops(book_id)}
        fresh: dict[str, list[str]] = {}
        for raw in new:
            op = _valid(raw) if isinstance(raw, dict) else None
            if op and op["id"] not in seen:
                seen.add(op["id"])
                fresh.setdefault(op["dev"], []).append(json.dumps(op, ensure_ascii=False, separators=(",", ":")))
        if fresh:
            d.mkdir(parents=True, exist_ok=True)
            for dev, lines in fresh.items():
                with open(d / f"{dev}.jsonl", "a") as f:
                    f.write("\n".join(lines) + "\n")
                    f.flush()
                    os.fsync(f.fileno())
            if book_id is not None:
                _materialize(book_id)
        return sum(len(v) for v in fresh.values())


def _key(o: dict):
    return (o["t"], o["id"])


def latest(all_ops: list[dict], kind: str) -> dict | None:
    xs = [o for o in all_ops if o.get("k") == kind]
    return max(xs, key=_key) if xs else None


def position(book_id: str) -> dict | None:
    """The newest position from any device, and each device's own last position."""
    all_ops = ops(book_id)
    best = latest(all_ops, "pos")
    if not best:
        return library.progress(book_id)  # a library from before operations
    per = {}
    for o in all_ops:
        if o["k"] == "pos" and (o["dev"] not in per or _key(o) > _key(per[o["dev"]])):
            per[o["dev"]] = o
    return {**best["v"], "t": best["t"], "dev": best["dev"],
            "devices": {d: {**o["v"], "t": o["t"]} for d, o in per.items()}}


def highlights(book_id: str) -> list[dict]:
    cur: dict[str, tuple] = {}
    for o in sorted(ops(book_id), key=_key):
        hid = str(o["v"].get("id", ""))
        if o["k"] == "hl" and hid:
            cur[hid] = (o, o["v"])
        elif o["k"] == "hl-" and hid in cur:
            del cur[hid]
    return [{**v, "t": o["t"]} for o, v in sorted(cur.values(), key=lambda x: (x[1].get("chapter", 0), x[1].get("block", 0), x[1].get("start", 0)))]


def reader() -> dict | None:
    o = latest(ops(None), "reader")
    return {**o["v"], "t": o["t"], "dev": o.get("dev")} if o else None


def _materialize(book_id: str):
    """progress.json and highlights.json: plain views of the operations, for people and other tools."""
    pos = latest(ops(book_id), "pos")
    if pos:
        v = pos["v"]
        out = {"chapter": int(v.get("chapter", 0)), "block": int(v.get("block", 0)), "percent": int(v.get("percent", 0)),
               "offset": int(v.get("offset", 0)), "quote": str(v.get("quote", ""))[:80],
               "at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(pos["t"] / 1000))}
        _write(library.LIB / book_id / "progress.json", out)
    hs = highlights(book_id)
    if hs or (library.LIB / book_id / "highlights.json").is_file():
        _write(library.LIB / book_id / "highlights.json", hs)


def _write(p: Path, obj):
    tmp = p.with_suffix(".part")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    tmp.replace(p)


def export_all() -> dict:
    """Every operation in the library, for a peer that holds the same library id."""
    from . import backgrounds
    r = reader() or {}
    out = {"library": library_id(), "books": {}, "reader": ops(None), "backgrounds": backgrounds.export(r.get("bg"))}
    for b in library.list_books():
        out["books"][b["id"]] = ops(b["id"])
    return out


def import_all(data: dict) -> dict:
    if data.get("library") != library_id():
        raise ValueError("Different library: the pairing code does not match.")
    n = add(None, data.get("reader") or [])
    from . import backgrounds, shelf
    backgrounds.import_(data.get("backgrounds"))  # the picture behind the theme, when the other copy uses one
    shelf.apply()  # a book deleted or restored on the other copy
    skipped = []
    for bid, xs in (data.get("books") or {}).items():
        try:
            n += add(bid, xs)
        except KeyError:
            skipped.append(bid)  # the peer has a book this copy does not; files travel separately
    return {"added": n, "skipped_books": skipped}

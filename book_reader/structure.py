"""Repairing how a book is split into chapters, in two layers.

1. Rules, always on, no AI: they fix what the contents of an EPUB commonly get wrong (found on a corpus of public
   domain books, tools/corpus.py): a chapter heading in the text that the contents skip (Ikigai's "Chapter 5"), a
   heading left dangling at the end of the previous file, no contents at all, chapters called "Section 4", and back
   matter (licenses, short appendices, indexes) that should never get lesson cards.
2. An AI repair, only for books that still score below quality.THRESHOLD: the model reads the candidate headings and
   proposes where chapters start. The proposal is kept beside the book (structure.json) and used only if it scores
   better; the EPUB is never changed, and removing the file (Undo) brings the original split back.
"""
from __future__ import annotations

import hashlib
import json
import re
import time

from . import quality

APPENDIX = re.compile(r"^\s*(appendix|appendices|index|notes?|endnotes|glossary|footnotes|transcriber)", re.I)
SHORT_BACK = 1500  # an appendix, index or notes section shorter than this is reference, not a chapter to learn from


def _split(book, c, j, title):
    from .epub import Chapter
    new = Chapter(index=0, title=title, depth=c.depth, blocks=c.blocks[j:], trail=list(c.trail))
    c.blocks = c.blocks[:j]
    book.chapters.insert(book.chapters.index(c) + 1, new)
    return new


def _title_at(blocks, j, stop=()):
    """A heading line, joined with the short line under it when that is its name: "Chapter 5: Flow and creativity".
    Not when that line starts a piece of its own (a tag in `stop`): "PART 1" over "1.1 A chapter" stays two."""
    t = blocks[j]["text"].strip()
    if j + 1 < len(blocks) and blocks[j + 1]["type"] != "img" and blocks[j + 1]["type"] not in stop:
        nxt = blocks[j + 1]["text"].strip()
        if 0 < len(nxt) <= 70 and not nxt.endswith((".", ",", ";")) and quality.heading(nxt) is None:
            return f"{t}: {nxt}", 2
    return t, 1


def _is_heading(b) -> bool:
    return b["type"] in ("h1", "h2", "h3") and 0 < len(b["text"]) <= 120 or quality.heading(b["text"]) is not None


def _levels(book, min_words=100) -> dict[str, int]:
    """The heading tags that mark chapters, with their depth: from the top level down, as long as the pieces they cut the
    book into stay longer than a short poem (100 words on average; 600 split the poems of a collection and the chapters of
    Leviathan too coarsely on the Gutenberg corpus, and 100 still cut nowhere a real chapter does not start)."""
    count = {t: 0 for t in ("h1", "h2", "h3")}
    for c in book.chapters:
        for b in c.blocks:
            if b["type"] in count and 0 < len(b["text"].strip()) <= 120:
                count[b["type"]] += 1
    body = sum(c.words for c in book.chapters)
    chosen, n = [], 0
    for t in ("h1", "h2", "h3"):
        if not count[t]:
            continue
        if chosen and body / (n + count[t]) < min_words:
            break
        chosen.append(t)
        n += count[t]
    return {t: (k if count[chosen[0]] > 1 or len(chosen) == 1 else max(0, k - 1)) for k, t in enumerate(chosen)}


def rules(book) -> list[str]:
    """Fix the split in place; returns what was changed, in words."""
    done = []
    # a heading the contents skipped: start a chapter there
    for ci, j, text in sorted(quality.missed_headings(book), key=lambda x: (-x[0], -x[1])):
        c = book.chapters[ci]
        title, n = _title_at(c.blocks, j)
        new = _split(book, c, j, title)
        if n == 2:
            new.blocks = new.blocks  # the heading lines stay in the text, as the book prints them
        done.append(f"added the chapter \u201c{title[:60]}\u201d that the contents skipped")
    # the next chapter's heading left at the end of this file: move it to where it belongs
    for a, b in zip(book.chapters, book.chapters[1:]):
        hb = quality.heading(b.title.split(":")[0]) or quality.heading(b.title)
        for j in range(max(0, len(a.blocks) - 3), len(a.blocks)):
            h = quality.heading(a.blocks[j]["text"])
            if j and h and hb and h[:2] == hb[:2]:
                b.blocks = a.blocks[j:] + b.blocks
                a.blocks = a.blocks[:j]
                done.append(f"moved the heading \u201c{b.title[:40]}\u201d to its chapter")
                break
    # no usable contents, or names that are not names: chapters from the headings in the text
    if book.toc == "files" or sum(bool(quality.GENERIC.match(c.title)) for c in book.chapters) > 0.5 * max(1, len(book.chapters)):
        levels = _levels(book)
        for c in list(book.chapters):
            hs = [j for j, b in enumerate(c.blocks) if b["type"] in levels or quality.heading(b["text"])]
            if hs and hs[0] <= 2 and quality.GENERIC.match(c.title):
                c.title = _title_at(c.blocks, hs[0], levels)[0]
                c.depth = levels.get(c.blocks[hs[0]]["type"], c.depth)
            for j in reversed([j for j in hs if 0 < j < len(c.blocks) - 1]):
                new = _split(book, c, j, _title_at(c.blocks, j, levels)[0])
                new.depth = levels.get(new.blocks[0]["type"], c.depth)
        # a file with no heading of its own continues the chapter before it (long chapters are often cut into files)
        for c in list(book.chapters[1:]):
            k = book.chapters.index(c)
            if quality.GENERIC.match(c.title) and k > 0:
                book.chapters[k - 1].blocks += c.blocks
                book.chapters.remove(c)
        body = [c for c in book.chapters if c.words >= 500]
        if len(body) == 1 and quality.GENERIC.match(body[0].title):  # a work in one piece (a play with no marked acts)
            body[0].title = book.title
        done.append("found the chapters from the headings in the text")
    for k, c in enumerate(book.chapters):
        c.index = k
    return done


def kinds(book) -> None:
    """After nesting: back matter that would otherwise get lesson cards."""
    for c in book.chapters:
        if c.kind != "chapter":
            continue
        low = c.text[:6000].lower()
        if "project gutenberg" in low and ("license" in low or "licence" in low):
            c.kind = "matter"
        elif APPENDIX.match(c.title) and c.words < SHORT_BACK:
            c.kind = "matter"


# ---- the AI layer: a proposal kept beside the book, used only when it is better, removable at any time ----------
def _flat(book):
    out = []
    for c in book.chapters:
        out.extend(c.blocks)
    return out


def fingerprint(book) -> str:
    return hashlib.sha256("\n".join(b["text"] for b in _flat(book)).encode()).hexdigest()[:16]


def apply(book, data: dict):
    """Re-cut the book at the proposed starts. Ignored when the text changed since the proposal was made."""
    from .epub import Chapter, _nest
    if data.get("fingerprint") != fingerprint(book):
        return book
    blocks, starts = _flat(book), sorted(data["starts"], key=lambda s: s["block"])
    chs = []
    for n, s in enumerate(starts):
        hi = starts[n + 1]["block"] if n + 1 < len(starts) else len(blocks)
        if hi > s["block"]:
            chs.append(Chapter(index=len(chs), title=s["title"], depth=int(s.get("depth", 0)), blocks=blocks[s["block"]:hi]))
    if starts and starts[0]["block"] > 0:  # whatever comes before the first start is front matter
        chs.insert(0, Chapter(index=0, title="Front matter", depth=0, blocks=blocks[:starts[0]["block"]], kind="matter"))
        for k, c in enumerate(chs):
            c.index = k
    book.chapters = chs
    _nest(book.chapters)
    kinds(book)
    for c in book.chapters:
        if c.title == "Front matter":
            c.kind = "matter"
    book.toc = "ai"
    return book


PROMPT = """You are fixing how an e-book was split into chapters. Below are the short lines of the book that might be
headings, each with its block number and the first words after it. Also listed: the current chapter starts.

Return the chapter starts a careful editor would use: real chapters (and parts, acts, books or letters when the book
is built that way), each starting at the block of its heading, with the book's own title for it. Front matter (title
page, contents, copyright) and back matter (index, notes, license) are not chapters: start the first chapter at the
first real one. Never invent numbering the book does not have. Keep the book's order.

Reply with JSON only: {{"starts": [{{"block": <number>, "title": "<the book's heading>", "depth": 0}}]}}
(depth 1 for a chapter inside a part).

Book: {title}
Current chapter starts: {current}
Candidate headings:
{candidates}"""


def candidates(book, limit=400):
    out, k = [], 0
    for c in book.chapters:
        for j, b in enumerate(c.blocks):
            t = b["text"].strip()
            if b["type"] != "img" and 0 < len(t) <= 90 and (_is_heading(b) or (t.isupper() and len(t) > 3) or j == 0):
                after = next((x["text"][:60] for x in c.blocks[j + 1:j + 3] if x["text"]), "")
                out.append(f"{k + j}: {t} | {after}")
        k += len(c.blocks)
    return out[:limit]


def propose(book, provider=None) -> dict | None:
    """Ask the AI for a better split. Returns the proposal when it scores better than the current split, else None."""
    from . import llm
    before = quality.score(book)
    cur, k = [], 0
    for c in book.chapters:
        cur.append(f"{k}:{c.title[:40]}")
        k += len(c.blocks)
    prompt = PROMPT.format(title=book.title, current="; ".join(cur[:120]), candidates="\n".join(candidates(book)))
    raw = "".join(llm.stream(provider, "You restructure e-books precisely. Reply with JSON only.", prompt, max_tokens=6000))
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        starts = [{"block": int(s["block"]), "title": str(s["title"]).strip()[:120], "depth": int(s.get("depth", 0))}
                  for s in json.loads(m.group(0))["starts"] if str(s.get("title", "")).strip()]
    except (AttributeError, ValueError, KeyError, TypeError):
        return None
    total = len(_flat(book))
    starts = sorted({s["block"]: s for s in starts if 0 <= s["block"] < total}.values(), key=lambda s: s["block"])
    if len(starts) < 2:
        return None
    data = {"source": "ai", "model": llm.model_name(provider), "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "fingerprint": fingerprint(book), "starts": starts, "before": before}
    import copy
    after = quality.score(apply(copy.deepcopy(book), data))
    data["after"] = after
    return data if after["score"] > before["score"] else None


# ---- the repair as the app runs it: one book at a time, in the background, revertible ----
_jobs: dict[str, dict] = {}


def _files(book_id: str):
    from . import library
    d = library.LIB / book_id
    return d / "book.epub", d / "structure.json", d / "structure.tried"


def status(book_id: str) -> dict:
    """What the reader shows: the split's score, its problems, whether an AI repair is applied, running or failed."""
    from . import library
    epub_path, fix, _ = _files(book_id)
    b = library.book(book_id)
    q = quality.score(b)
    out = {"score": q["score"], "issues": q["issues"], "flagged": q["score"] < quality.THRESHOLD, "toc": b.toc,
           "rules": b.repairs, "job": _jobs.get(book_id)}
    if fix.is_file() and b.toc == "ai":
        d = json.loads(fix.read_text())
        out["ai"] = {"model": d.get("model"), "at": d.get("at"), "before": d.get("before", {}).get("score")}
    return out


def repair(book_id: str, provider: str | None = None, wait: bool = False) -> dict:
    """Ask the AI for a better split of this book, in the background. Kept only when it scores better; the EPUB is never
    touched (the new split is structure.json beside it), and revert() goes back."""
    import threading
    from . import library
    if (_jobs.get(book_id) or {}).get("state") == "running":
        return status(book_id)
    _jobs[book_id] = {"state": "running"}

    def work():
        epub_path, fix, tried = _files(book_id)
        try:
            b = library._parse(str(epub_path), epub_path.stat().st_mtime, 0)  # the split the rules made, no earlier AI fix
            tried.write_text(fingerprint(b))
            data = propose(b, provider)
            if data is None:
                _jobs[book_id] = {"state": "kept", "message": "The AI's split was not better, so the book keeps its own."}
                return
            fix.write_text(json.dumps(data, indent=1, ensure_ascii=False))
            _jobs[book_id] = {"state": "done", "before": data["before"]["score"], "after": data["after"]["score"]}
        except Exception as e:  # noqa: BLE001  any provider failure ends the job, the book stays as it was
            _jobs[book_id] = {"state": "failed", "message": str(e)[:200]}

    t = threading.Thread(target=work, daemon=True)
    t.start()
    if wait:
        t.join()
    return status(book_id)


def revert(book_id: str) -> dict:
    """Undo an AI repair: the proposal is kept aside (structure.reverted.json), and is not tried again by itself."""
    _, fix, _ = _files(book_id)
    if fix.is_file():
        fix.replace(fix.with_name("structure.reverted.json"))
    _jobs.pop(book_id, None)
    return status(book_id)


def sweep(provider: str | None = None):
    """On start and after an import: repair, once, each book whose split scores below the threshold, when an AI is set up.
    A book is tried once per text (structure.tried), so a failed or reverted repair does not spend again."""
    from . import library, llm
    try:
        if not llm.configured(llm.resolve(provider)):
            return
    except Exception:  # noqa: BLE001
        return
    for d in sorted(library.LIB.iterdir()) if library.LIB.is_dir() else []:
        epub_path, fix, tried = _files(d.name)
        if not epub_path.is_file() or fix.is_file() or fix.with_name("structure.reverted.json").is_file():
            continue
        try:
            b = library._parse(str(epub_path), epub_path.stat().st_mtime, 0)
            if quality.score(b)["score"] >= quality.THRESHOLD or (tried.is_file() and tried.read_text() == fingerprint(b)):
                continue
        except Exception:  # noqa: BLE001  a book that does not parse is not the sweep's business
            continue
        repair(d.name, provider, wait=True)

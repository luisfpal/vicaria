"""How well a book was split into chapters, scored from the result alone (no answer key), so any imported book can be
checked. 1.0 is clean; below THRESHOLD the book is flagged and, when an AI is available, its structure is repaired.

Each check returns a penalty and a plain reason. The checks come from where splitting broke on a corpus of public
domain books (tools/corpus.py): text dropped, a whole book in one chapter, one chapter swallowing most of a book,
chapters named "Section 4", a book shredded into fragments, license text read as a chapter, and chapter headings in the
text that the contents skipped (a missing "Chapter 5").
"""
from __future__ import annotations

import re

THRESHOLD = 0.75
NUM = r"([0-9]{1,3}|[IVXLCDM]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third)"
KEY = (r"(chapter|book|part|act|canto|lecture|letter|stave|volume|kapitel|teil|buch|cap[ií]tulo|chapitre|livre|libro|parte|"
       r"canto|hoofdstuk|luku|глава|第)")
HEADING = re.compile(rf"^\s*{KEY}\s+{NUM}\b[\s.:,–\u2014-]*(.{{0,90}})$", re.I)
GENERIC = re.compile(r"^\s*(section \d+|chapter|untitled|.*\.x?html?|.*split.*|part\d+|)\s*$", re.I)  # "I" or "12" are real titles


def inner_headings(c) -> int:
    """Lines inside a chapter that look like headings of their own (marked as headings, or short and in capitals)."""
    n = 0
    for b in c.blocks[2:]:
        t = b["text"].strip()
        if re.fullmatch(r"(the end|finis|fin)\W*", t, re.I):
            continue
        if b["type"] != "img" and 3 < len(t) <= 90 and (b["type"].startswith("h") or t.isupper() or heading(t)):
            n += 1
    return n


def heading(text: str):
    """("chapter", 5, rest) for a line that reads like a chapter heading, else None."""
    if len(text) > 110:
        return None
    m = HEADING.match(text.strip())
    if not m:
        return None
    return m.group(1).lower(), number(m.group(2)), m.group(3).strip()


WORDS = {w: i + 1 for i, w in enumerate("one two three four five six seven eight nine ten eleven twelve".split())}
WORDS.update(first=1, second=2, third=3)


def number(t: str) -> int | None:
    t = t.strip().lower()
    if t.isdigit():
        return int(t)
    if t in WORDS:
        return WORDS[t]
    vals = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
    if t and all(ch in vals for ch in t):
        n = 0
        for a, b in zip(t, t[1:] + " "):
            n += -vals[a] if b != " " and vals[a] < vals[b] else vals[a]
        return n
    return None


def missed_headings(book) -> list[tuple[int, int, str]]:
    """(chapter index, block, text) of chapter headings inside a chapter's text, of the same kind as the book's own
    chapter titles, whose number is not already a chapter: splits the contents left out."""
    titled = {}
    for c in book.chapters:
        h = heading(c.title.split(":")[0]) or heading(c.title)
        if h:
            titled.setdefault(h[0], set()).add(h[1])
    out = []
    for c in book.chapters:
        if c.kind == "matter":
            continue
        for j, b in enumerate(c.blocks):
            if j < 2 or b["type"] == "img":
                continue
            h = heading(b["text"])
            if h and h[0] in titled and h[1] not in titled[h[0]] and len(titled[h[0]]) >= 2:
                out.append((c.index, j, b["text"].strip()))
    return out


def score(book) -> dict:
    chs = [c for c in book.chapters if c.kind == "chapter"]
    body = max(1, book.body_words)
    words = [c.words for c in chs]
    issues, pen = [], 0.0

    def flag(p, why):
        nonlocal pen
        pen += p
        issues.append(why)

    if not chs and body > 500:
        flag(1.0, "no chapters found")
    kept = sum(c.words for c in book.chapters)
    if body > 500 and kept / body < 0.9:
        flag(min(0.6, (0.9 - kept / body) * 3), f"{100 - 100 * kept // body}% of the text is in no chapter")
    if len(chs) == 1 and body > 12000 and inner_headings(chs[0]) >= 3:  # a long story told in one piece is fine
        flag(0.5, f"one chapter for {body:,} words")
    if len(chs) >= 4 and body > 40000 and max(words) > 0.5 * body:
        flag(0.3, f"one chapter holds {100 * max(words) // body}% of the book")
    generic = [c for c in chs if GENERIC.match(c.title)]
    if chs and len(generic) / len(chs) > 0.3:
        flag(0.3, f"{len(generic)} of {len(chs)} chapters have no real name (\u201c{generic[0].title}\u201d)")
    tiny = [w for w in words if w < 150]
    if len(chs) > 10 and len(tiny) / len(chs) > 0.4:
        flag(0.25, f"{len(tiny)} of {len(chs)} chapters are under 150 words")
    lic = [c for c in chs if re.search(r"project gutenberg", c.title + " " + c.text[:3000], re.I) and "license" in c.text.lower()]
    if lic:
        flag(0.3, f"license text read as a chapter (\u201c{lic[0].title[:40]}\u201d)")
    miss = missed_headings(book)
    if miss:
        flag(min(0.4, 0.15 * len(miss)), f"contents skip {len(miss)} chapter heading(s) in the text, e.g. \u201c{miss[0][2][:40]}\u201d")
    return {"score": round(max(0.0, 1.0 - pen), 2), "issues": issues, "chapters": len(chs), "toc": book.toc}

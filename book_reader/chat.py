"""Conversations with one chapter or with the whole book, plus on-demand generators (diagram, skill summary).

Each conversation is one Markdown file, library/<book>/chat/chapter-NN.md or chat/book.md:
    <!-- msg role=user kind=ask -->
    text...
A chapter chat sees only that chapter's text and notes; it never accumulates the rest of the book.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Iterator

from . import diagram, library, llm, prompts

SKILLS = Path(__file__).resolve().parent.parent / "skills"
MSG = re.compile(r"^<!-- msg role=(user|assistant) kind=([\w:.-]+) -->\n", re.M)
HISTORY = 24  # messages sent back to the model

RULES = """You are a reading companion talking with one reader about {scope} of "{title}"{authors}.
He reads to learn the lessons and mental models in it, the way a wise, experienced reader would hand them on, and to act on them.

How you answer:
- Ground everything in the book material below. When you use it, name where it comes from, e.g. (Ch. {example}).
- If the book does not say, say "The book does not say." first; then you may add your own view, marked [Inference].
- Lead with the answer in one or two sentences, then the reasoning step by step. Use the author's own examples.
- Plain, exact sentences. No filler, no flattery, no restating the question, no em dashes.
- Reply in the language the reader writes in."""


# ---- storage -----------------------------------------------------------------------------------
def _path(book_id: str, scope: str) -> Path:
    return library.LIB / book_id / "chat" / ("book.md" if scope == "book" else f"chapter-{int(scope):02d}.md")


def messages(book_id: str, scope: str) -> list[dict]:
    p = _path(book_id, scope)
    if not p.is_file():
        return []
    parts = MSG.split(p.read_text())
    out = []
    for i in range(1, len(parts) - 2, 3):
        m = {"role": parts[i], "kind": parts[i + 1], "content": parts[i + 2].strip()}
        if m["kind"] == "diagram" and m["role"] == "assistant":
            m["diagram"] = diagram.layout(diagram.parse(m["content"]))
        out.append(m)
    return out


def _append(book_id: str, scope: str, role: str, kind: str, content: str):
    p = _path(book_id, scope)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        f.write(f"<!-- msg role={role} kind={kind} -->\n{content.strip()}\n\n")


def clear(book_id: str, scope: str):
    _path(book_id, scope).unlink(missing_ok=True)


# ---- skills ------------------------------------------------------------------------------------
def skills() -> list[dict]:
    out = []
    for f in sorted(SKILLS.glob("*.md")):
        lines = f.read_text().strip().splitlines()
        name = lines[0].lstrip("# ").strip() if lines else f.stem
        desc = next((l[1:].strip() for l in lines[1:] if l.startswith(">")), "")
        out.append({"id": f.stem, "name": name, "description": desc})
    return out


def skill_body(skill_id: str) -> tuple[str, str]:
    f = SKILLS / f"{skill_id}.md"
    if not re.fullmatch(r"[\w-]+", skill_id) or not f.is_file():
        raise KeyError(skill_id)
    lines = f.read_text().strip().splitlines()
    return lines[0].lstrip("# ").strip(), "\n".join(l for l in lines[1:] if not l.startswith(">")).strip()


# ---- retrieval: BM25 over the book's text, standard library only ------------------------------
STOP = set("the and for that with this from have not are was were but his her its they them their which what when "
           "who will would there been can could into than then also more most such only other some any all one "
           "our out you your has had him she does did how why".split())


def _tokens(s: str) -> list[str]:
    return [w for w in re.findall(r"[a-zà-ÿ0-9]+", s.lower()) if len(w) > 2 and w not in STOP]


@lru_cache(maxsize=8)
def _index(book_id: str, mtime: float):
    b = library.book(book_id)
    chunks = []
    for c in b.chapters:
        if c.kind != "chapter":
            continue
        buf = ""
        for blk in c.blocks:
            buf += blk["text"] + "\n"
            if len(buf) > 1200:
                chunks.append((c.title, buf.strip())); buf = ""
        if buf.strip():
            chunks.append((c.title, buf.strip()))
    docs = [Counter(_tokens(t)) for _, t in chunks]
    df = Counter(w for d in docs for w in d)
    avg = sum(sum(d.values()) for d in docs) / max(1, len(docs))
    return chunks, docs, df, avg


def retrieve(book_id: str, query: str, k: int = 6) -> list[tuple[str, str]]:
    p = library.LIB / book_id / "book.epub"
    chunks, docs, df, avg = _index(book_id, p.stat().st_mtime)
    n, q = len(docs), set(_tokens(query))
    scores = []
    for i, d in enumerate(docs):
        L, s = sum(d.values()), 0.0
        for w in q:
            if w in d:
                idf = math.log(1 + (n - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * d[w] * 2.5 / (d[w] + 1.5 * (0.25 + 0.75 * L / avg))
        scores.append((s, i))
    return [chunks[i] for s, i in sorted(scores, reverse=True)[:k] if s > 0]


# ---- context -----------------------------------------------------------------------------------
def _system(book_id: str, scope: str, query: str) -> str:
    b = library.book(book_id)
    authors = f" by {', '.join(b.authors)}" if b.authors else ""
    if scope == "book":
        first = next((c.title for c in b.chapters if c.kind == "chapter"), "1")
        parts = [RULES.format(scope="the whole book", title=b.title, authors=authors, example=first),
                 "Table of contents:\n" + prompts.toc_lines(b.chapters)]
        syn = library.synthesis(book_id)
        if syn:
            parts.append("=== WHOLE-BOOK SYNTHESIS ===\n" + syn["markdown"])
        notes = [(c.title, library.note(book_id, c.index)) for c in b.chapters if c.kind == "chapter"]
        joined = "\n\n".join(f"--- Notes on {t} ---\n{n['markdown']}" for t, n in notes if n)
        if joined:
            parts.append("=== CHAPTER NOTES ===\n" + joined[:120_000])
        hits = retrieve(book_id, query)
        if hits:
            parts.append("=== PASSAGES FROM THE BOOK MOST RELEVANT TO THE LATEST QUESTION ===\n" +
                         "\n\n".join(f"[{t}]\n{x}" for t, x in hits))
        return "\n\n".join(parts)
    ch = b.chapters[int(scope)]
    parts = [RULES.format(scope=f'one chapter, "{ch.title}",', title=b.title, authors=authors, example=ch.title),
             "Where this chapter sits:\n" + prompts.toc_lines(b.chapters, ch.index),
             f"=== FULL TEXT OF \"{ch.title}\" ===\n" + ch.text[:prompts.MAX_CHARS]]
    n = library.note(book_id, ch.index)
    if n:
        parts.append("=== STUDY NOTES ALREADY WRITTEN FOR THIS CHAPTER ===\n" + n["markdown"])
    parts.append("You only know this chapter. If asked about other chapters, say so and suggest the whole-book chat.")
    return "\n\n".join(parts)


def _request(kind: str, scope: str) -> tuple[str, str]:
    """(what the chat shows, what the model is told) for a generator."""
    whole = scope == "book"
    if kind == "diagram":
        return ("Draw a concept diagram of the whole book" if whole else "Draw a concept diagram of this chapter",
                diagram.instructions(whole))
    if kind.startswith("skill:"):
        name, body = skill_body(kind[6:])
        what = "the whole book" if whole else "this chapter"
        return (f"Summarize {what} with the skill: {name}",
                f"Summarize {what} following this skill exactly.\n\n{body}\n\n"
                "Write Markdown. Ground it in the book material; cite chapters. Never invent examples or quotes.")
    raise KeyError(kind)


def respond(book_id: str, scope: str, provider: str, message: str | None = None,
            generate: str | None = None) -> Iterator[str]:
    """Stream the assistant's reply; both turns are saved when it completes."""
    if scope != "book":
        library.book(book_id).chapters[int(scope)]  # 404 on a bad index
    if generate:
        shown, told = _request(generate, scope)
        kind = "diagram" if generate == "diagram" else generate
    else:
        shown = told = (message or "").strip()
        kind = "ask"
        if not shown:
            raise llm.LLMError("Empty message.")
    history = [{"role": m["role"], "content": m["content"]} for m in messages(book_id, scope)][-HISTORY:]
    query = " ".join([m["content"] for m in history if m["role"] == "user"][-2:] + [shown])
    system = _system(book_id, scope, query)
    parts = []
    for piece in llm.stream_chat(provider, system, history + [{"role": "user", "content": told}],
                                 max_tokens=6000, temperature=0.4):
        parts.append(piece)
        yield piece
    reply = "".join(parts).strip()
    if not reply:
        raise llm.LLMError("The model returned nothing.")
    with library._lock(f"{book_id}/chat/{scope}"):
        _append(book_id, scope, "user", kind, shown)
        _append(book_id, scope, "assistant", kind, reply)


def recap(book_id: str, chapter: int, block: int, provider: str | None = None) -> str:
    """One or two spoken sentences on what came just before, for a listener coming back after a break."""
    b = library.book(book_id)
    blocks = [x["text"] for x in b.chapters[chapter].blocks[:max(0, block)] if x["type"] != "img"]
    before = "\n".join(blocks)[-2500:]
    if len(before) < 200:
        return ""
    system = ("You help a listener pick up an audiobook after a break. In at most two short spoken sentences, say what "
              "the last part was about, so the next sentence makes sense. No preamble, no quotes, no lists, no spoilers "
              "of what comes next. Start with 'Previously,'.")
    text = "".join(llm.stream(provider, system, f"Book: {b.title}\nChapter: {b.chapters[chapter].title}\n\nThe last part:\n{before}", max_tokens=90))
    return " ".join(text.split())[:400]

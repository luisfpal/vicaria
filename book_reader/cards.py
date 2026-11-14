"""Punch cards: the default output. One core lesson and three key lessons per chapter; one core lesson and five
key lessons per book; a few lessons across books. Short and non-repetitive by construction: limits, a
repetition check and the diagram shape are checked here, and a card that fails is rewritten once.

library/<book>/cards/NN.json   chapter card (with the chapter digest and prompt version)
library/<book>/core.json       book card
library/across.json            lessons across books
"""
from __future__ import annotations

import hashlib
import json
import re
import threading

from . import figure, library, llm, prompts

VERSION = "c3"
LIMITS = {"core": 30, "lesson": 14, "why": 32, "remember": 18, "timeless": 14}

STYLE = """You hand on the lessons of a book the way the best book explainers do: one big idea, a few memorable \
lessons, timeless rather than topical. Plain words a smart 15-year-old understands. Every lesson must be \
something the reader can use or see the world through, grounded in the text. No filler, no praise, no em dashes, \
no "the author argues". Every field must add something no other field says: never restate a claim in new words. \
Define before you use: any word the book gives its own meaning (an everyday word it redefines, like "game", "stroke" \
or "script", or a technical term) goes in "terms" with the book's own definition, in plain words. Never pass off an \
outside definition as the book's; if the book only shows the meaning, say how the book uses it. \
Reply with JSON only."""

DIAGRAM = """"diagram": decide first whether these ideas have a structure that a list cannot show. Pick exactly one type:
 "cause": one thing causes or produces another, in a chain of at least 3 steps (causes may join or branch)
 "process": ordered steps that lead to a result
 "cycle": a feedback loop, where the last step feeds the first again
 "compare": two things contrasted on the same aspects
 "map": concepts joined by different named relationships (requires, produces, is part of, contrasts with)
 "none": the ideas are parallel points with no real relationship between them. Choose none rather than force a diagram.
Every edge must be a relationship the text states or clearly shows: never invent a cause. When the text contrasts two
things (people and machines, old and new, two methods), compare usually teaches best.
For cause, process, cycle or map: {{"type": "...", "title": "the question it answers, at most 10 words",
  "nodes": [{{"id": "a", "label": "2 to 5 words"}}], "edges": [{{"from": "a", "to": "b", "label": "a verb, 1 to 3 words"}}]}}
  with 3 to 7 nodes named after things in this {scope}. Never hang every node off one centre node: that is a list.
  At least one edge must join two nodes that are not the main idea.
For compare: {{"type": "compare", "title": "...", "sides": ["A", "B"],
  "rows": [{{"aspect": "1 to 3 words", "a": "at most 8 words", "b": "at most 8 words"}}]}} with 3 to 5 rows.
For none: {{"type": "none", "why": "one short reason"}}."""

CHAPTER = """Book: {title}{authors}
Chapter: {chapter}

Write the card for this chapter as JSON:
{{"core": "the chapter's one claim, a single sentence, at most 25 words",
 "lessons": [{{"lesson": "a sub-claim that the core does not already state, at most 12 words",
              "why": "the evidence, mechanism or concrete example from the text behind that sub-claim, at most 30 words; do not repeat its words"}}],
 "remember": "a memorable line ONLY if it adds something new (an image, a rule of thumb, a question) and reuses no example above; otherwise an empty string",
 "terms": [{{"term": "a word or phrase used above in this book's own sense", "meaning": "the book's definition, plain words, at most 25 words"}}],
 """ + DIAGRAM.replace("{scope}", "chapter") + """}}
Exactly 3 lessons, each a different sub-claim. "terms": every word in the core and lessons that a reader new to this
book would misread (0 to 5 of them; [] when there are none). The book's title words count when the book redefines them.

--- CHAPTER TEXT ---
{text}"""

BOOK = """Book: {title}{authors}
Below are the cards of every chapter, in order. Write the card of the whole book as JSON:
{{"core": "the one big idea of the book, a single sentence, at most 25 words",
 "lessons": [{{"lesson": "a key sub-claim the core does not already state, at most 12 words",
              "why": "evidence, mechanism or example behind it, at most 30 words; do not repeat its words",
              "chapters": ["exact chapter titles it comes from"]}}],
 "timeless": ["an idea worth keeping for life that none of the lessons already states, at most 14 words"],
 "remember": "a memorable line ONLY if it adds something new; otherwise an empty string",
 """ + DIAGRAM.replace("{scope}", "book: how its big ideas connect") + """}}
Exactly 5 lessons and up to 3 timeless ideas. Integrate across chapters; do not list chapters one by one.

{cards}"""

ACROSS = """Below are the core lessons of several books one reader has read. Find what they teach TOGETHER that no \
single book teaches alone: the connections, tensions and shared principles. JSON:
{{"lessons": [{{"lesson": "a lesson that needs two or more of these books, at most 25 words",
              "why": "how the books combine to show it, at most 30 words", "books": ["exact book titles"]}}]}}
Exactly 3 lessons, each naming at least two books.

{cores}"""


def words(s) -> int:
    return len(str(s or "").split())


# ---- repetition check: every field must add new information ------------------------------------
STOP = set("""a an the and or but if then so of to in on at by for with from into onto over under as is are was
were be been being it its this that these those there their they them he she his her you your we our us i me my
not no nor do does did done can could will would should may might must have has had than too very just also only
more most less much many such what which who whom whose when where why how all any each every some one ones own
same other another about out up down off again further once here both few new old get gets got make makes made
way ways thing things""".split())


def content_words(s) -> set[str]:
    out = set()
    for w in re.findall(r"[a-z]+", str(s or "").lower().replace("\u2019", "'")):
        if len(w) < 3 or w in STOP:
            continue
        for suf in ("ing", "ed", "es", "s"):
            if w.endswith(suf) and len(w) - len(suf) >= 4 and not w.endswith("ss"):
                w = w[: -len(suf)]
                break
        out.add(w)
    return out


def overlap(a, b) -> float:
    """Jaccard similarity of content words, or near-total containment of a short phrase in a longer one."""
    A, B = content_words(a), content_words(b)
    if not A or not B:
        return 0.0
    inter = len(A & B)
    j = inter / len(A | B)
    small = min(len(A), len(B))
    contain = inter / small if small >= 3 else 0.0
    return max(j, 0.0 if contain < 0.8 else contain * 0.75)


def elements(c: dict) -> list[tuple[str, str]]:
    out = [("core", c.get("core", ""))]
    for i, l in enumerate(c.get("lessons") or []):
        if isinstance(l, dict):
            out += [(f"lesson {i + 1}", l.get("lesson", "")), (f"lesson {i + 1} body", l.get("why", ""))]
    if c.get("example"):
        out.append(("example", c["example"]))
    if c.get("remember"):
        out.append(("remember", c["remember"]))
    out += [(f"timeless {k + 1}", t) for k, t in enumerate(c.get("timeless") or [])]
    return [(k, v) for k, v in out if str(v).strip()]


REPEAT = 0.35  # content-word overlap above this means two lines say the same thing


def repeats(c: dict, threshold: float = REPEAT) -> list[tuple[str, str, float]]:
    """Pairs of card fields that say the same thing (content-word overlap above the threshold)."""
    els, out = elements(c), []
    for i, (ka, a) in enumerate(els):
        for kb, b in els[i + 1:]:
            s = overlap(a, b)
            if s > threshold:
                out.append((ka, kb, round(s, 2)))
    return out


def problems(card: dict, n_lessons: int, kind: str = "chapter") -> list[str]:
    """What is wrong with a card (empty = fine): length, shape, repetition and the diagram."""
    out = []
    if kind != "across" and not card.get("core"):
        out.append("missing core")
    for k in ("core", "remember"):
        if words(card.get(k)) > LIMITS[k]:
            out.append(f"{k} has {words(card.get(k))} words, limit {LIMITS[k]}")
    ls = card.get("lessons") or []
    if len(ls) != n_lessons:
        out.append(f"{len(ls)} lessons, need {n_lessons}")
    for i, l in enumerate(ls):
        if not isinstance(l, dict) or not l.get("lesson"):
            out.append(f"lesson {i + 1} empty")
            continue
        for k in ("lesson", "why"):
            if kind != "across" and words(l.get(k)) > LIMITS[k]:
                out.append(f"lesson {i + 1} {k} has {words(l.get(k))} words, limit {LIMITS[k]}")
    for t in card.get("timeless") or []:
        if words(t) > LIMITS["timeless"]:
            out.append(f"timeless idea has {words(t)} words, limit {LIMITS['timeless']}")
    if kind != "across":
        for a, b, s in repeats(card):
            out.append(f"{a} and {b} say the same thing ({int(s * 100)}% shared words): make {b} add new information")
        out += figure.problems(card.get("diagram"))
    return out


def _json(raw: str) -> dict:
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        return json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        return {}


def _settle(card: dict) -> dict:
    """After the one rewrite: drop optional fields that still repeat, drop a diagram that still fails."""
    for _ in range(4):
        rep = repeats(card)
        drop = next((b for a, b, _s in rep if b == "remember" or b.startswith("timeless")), None) or \
            next((a for a, b, _s in rep if a == "remember" or a.startswith("timeless")), None)
        if not drop:
            break
        if drop == "remember":
            card["remember"] = ""
        else:
            k = int(drop.split()[1]) - 1
            card["timeless"] = [t for j, t in enumerate(card["timeless"]) if j != k]
    if rest := repeats(card):
        card["repeats"] = [list(r) for r in rest]
    d = card.get("diagram")
    if isinstance(d, dict) and d.get("type") != "none" and figure.problems(d):
        card["diagram"] = {"type": "none", "why": "omitted: " + "; ".join(figure.problems(d))[:200]}
    return card


def _ask(provider, prompt, n, kind):
    card, probs, first = {}, ["no reply"], []
    for attempt in range(2):
        raw = "".join(llm.stream(provider, STYLE, prompt, max_tokens=2500))
        card = _json(raw)
        probs = problems(card, n, kind)
        if not probs:
            break
        if attempt == 0:
            first = probs
            prompt += "\n\nYour last reply had these problems, fix every one: " + "; ".join(probs)
    if not card.get("lessons"):
        raise llm.LLMError("The model did not return a usable card; try again.")
    card["lessons"] = card["lessons"][:n]
    if first:
        card["rewritten_for"] = first
    if kind != "across":
        card = _settle(card)
    card["model"] = llm.model_name(provider)
    return card


# ---- a second reader: does every field add something, and is the diagram true and useful? -----
REVIEW_SYSTEM = """You are a strict editor checking a study card against its source. You judge; you do not rewrite. \
Reply with JSON only."""

REVIEW = """Card (JSON):
{card}

Check two things and reply as JSON:
{{"restates": [{{"field": "the field name, e.g. remember, timeless 2, lesson 3 body", "same_as": "the field it repeats"}}],
 "diagram": {{"keep": true, "reason": "one short sentence"}}}}
1. restates: list every field that tells the reader nothing new because another field already makes the same claim or
   uses the same example, even in different words. Field names: core, lesson N, lesson N body, remember, timeless N.
   List only the later, weaker field of each pair. Compare fields of this card with each other, never with the source.
   A lesson body that gives the evidence, mechanism or example for its own lesson is doing its job: not a repeat.
   An empty list is a fine answer.
2. diagram: keep is false if any edge claims a relationship the source does not state or clearly show, if a node label
   is unclear on its own, or if the diagram teaches nothing the lessons do not already make obvious. Otherwise true.
   If there is no diagram, answer keep true.

--- SOURCE ---
{source}"""


def _field(card: dict, name: str):
    """(container, key) for a field name such as "remember", "timeless 2" or "lesson 3 body"."""
    p = name.lower().split()
    try:
        if p[0] in ("remember", "core"):
            return card, p[0]
        if p[0] == "timeless":
            return card["timeless"], int(p[1]) - 1
        if p[0] == "lesson":
            return card["lessons"][int(p[1]) - 1], "why" if p[-1] == "body" else "lesson"
    except (KeyError, IndexError, ValueError, TypeError):
        pass
    return None, None


def review(provider, card: dict, source: str) -> dict:
    """A fresh reader drops repeated optional fields and diagrams that are untrue or teach nothing."""
    shown = {k: v for k, v in card.items() if k in ("core", "lessons", "remember", "timeless", "diagram")}
    try:
        raw = "".join(llm.stream(provider, REVIEW_SYSTEM, REVIEW.format(card=json.dumps(shown, ensure_ascii=False),
                                                                         source=source[:prompts.MAX_CHARS]), max_tokens=800))
    except llm.LLMError:
        return card
    r = _json(raw)
    drop_timeless, flagged = set(), []
    for x in r.get("restates") or []:
        name = str((x or {}).get("field", "")).strip().lower()
        box, key = _field(card, name)
        if box is None or name == "core":
            continue
        if name == "remember":
            card["remember"] = ""
        elif name.startswith("timeless"):
            drop_timeless.add(key)
        else:
            flagged.append([name, str(x.get("same_as", "")), "reviewer"])
    if drop_timeless:
        card["timeless"] = [t for j, t in enumerate(card["timeless"]) if j not in drop_timeless]
    if flagged:
        card["repeats"] = (card.get("repeats") or []) + flagged
    d, verdict = card.get("diagram"), r.get("diagram") or {}
    if isinstance(d, dict) and d.get("type") != "none" and verdict.get("keep") is False:
        card["diagram"] = {"type": "none", "why": "omitted by review: " + str(verdict.get("reason", ""))[:200], "was": d}
    card["reviewed"] = bool(r)
    return card


REDO = """A reviewer rejected the diagram for this card: {reason}
Card (JSON): {card}

Draw it again, fixing that, as JSON {{"diagram": ...}}. Use only relationships the source states or clearly shows.
""" + DIAGRAM.replace("{scope}", "{scope}") + """

--- SOURCE ---
{source}"""


def checked(provider, card: dict, source: str, scope: str) -> dict:
    """Review the card; if the reviewer drops the diagram, redraw it once with the reason, then review again."""
    card = review(provider, card, source)
    d = card.get("diagram") or {}
    if not str(d.get("why", "")).startswith("omitted by review"):
        return card
    shown = {k: card[k] for k in ("core", "lessons") if k in card}
    try:
        raw = "".join(llm.stream(provider, STYLE, REDO.replace("{scope}", scope).format(
            reason=d["why"][len("omitted by review: "):], card=json.dumps(shown, ensure_ascii=False),
            source=source[:prompts.MAX_CHARS]), max_tokens=1200))
    except llm.LLMError:
        return card
    new = _json(raw).get("diagram")
    if isinstance(new, dict) and new.get("type") != "none" and not figure.problems(new):
        again = review(provider, {**card, "diagram": new}, source)
        if (again.get("diagram") or {}).get("type") != "none":
            again["diagram_redrawn"] = True
            return again
    return card


# ---- storage -----------------------------------------------------------------------------------
def _cpath(book_id, index):
    return library.LIB / book_id / "cards" / f"{index:02d}.json"


def card(book_id: str, index: int) -> dict | None:
    ch = library.book(book_id).chapters[index]
    p = _cpath(book_id, index)
    c = json.loads(p.read_text()) if p.is_file() else {}
    if c.get("digest") == ch.digest and c.get("v") == VERSION:
        return c
    if ch.kind == "chapter" and _remap(book_id):  # the split changed (a repair): cards follow their chapters
        return card(book_id, index)
    return None


def _remap(book_id: str) -> bool:
    """After the chapters were re-split, move each saved card to the chapter that now holds the same text (90% of its
    paragraphs), under its new index. A chapter whose text changed more than that gets a new card. Runs once per split."""
    b = library.book(book_id)
    d = library.LIB / book_id / "cards"
    mark = d / f".layout-{hashlib.sha256('|'.join(c.digest for c in b.chapters).encode()).hexdigest()[:12]}"
    if not d.is_dir() or mark.exists():
        return False
    old = {c.digest: c for c in library.raw(book_id).chapters}
    old.update({c.digest: c for c in library._parse(str(library.LIB / book_id / "book.epub"), 0).chapters})
    saved = [json.loads(f.read_text()) for f in sorted(d.glob("*.json")) if not f.name.startswith(".")]
    moved = 0
    for ch in b.chapters:
        here = _cpath(book_id, ch.index)
        if ch.kind != "chapter" or (here.is_file() and json.loads(here.read_text()).get("digest") == ch.digest):
            continue
        mine = {x["text"] for x in ch.blocks if x["text"]}
        for c in saved:
            oc = old.get(c.get("digest"))
            theirs = {x["text"] for x in oc.blocks if x["text"]} if oc else set()
            if oc and c.get("v") == VERSION and len(mine & theirs) >= 0.9 * max(len(mine), len(theirs), 1):
                here.write_text(json.dumps({**c, "digest": ch.digest, "was": c["digest"]}, indent=1, ensure_ascii=False))
                moved += 1
                break
    mark.write_text(str(moved))
    return moved > 0


def make_card(book_id: str, index: int, provider: str, force=False) -> dict:
    b = library.book(book_id)
    ch = b.chapters[index]
    if ch.kind != "chapter":
        raise ValueError("Front and back matter is not distilled.")
    with library._lock(f"{book_id}/card/{index}"):
        if not force and (c := card(book_id, index)):
            return c
        authors = f" by {', '.join(b.authors)}" if b.authors else ""
        c = _ask(provider, CHAPTER.format(title=b.title, authors=authors, chapter=ch.title,
                                          text=ch.text[:prompts.MAX_CHARS]), 3, "chapter")
        c = checked(provider, c, ch.text, "chapter")
        c["terms"] = terms(c.get("terms"))
        c.update(digest=ch.digest, v=VERSION)
        p = _cpath(book_id, index)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(c, indent=1, ensure_ascii=False))
        return c


def terms(raw) -> list[dict]:
    """The card's defined terms, cleaned: at most 5, each a short term and a definition of at most 40 words."""
    out = []
    for t in raw if isinstance(raw, list) else []:
        if isinstance(t, dict) and str(t.get("term", "")).strip() and str(t.get("meaning", "")).strip():
            out.append({"term": str(t["term"]).strip()[:60], "meaning": " ".join(str(t["meaning"]).split()[:40])})
    return out[:5]


def glossary(book_id: str) -> list[dict]:
    """Every term the book's cards define, once, with the chapter where the reader meets it first."""
    seen: dict[str, dict] = {}
    for ch in library.book(book_id).chapters:
        if ch.kind == "chapter":
            for t in (card(book_id, ch.index) or {}).get("terms") or []:
                seen.setdefault(t["term"].lower(), {**t, "chapter": ch.index, "title": ch.title})
    return sorted(seen.values(), key=lambda t: t["term"].lower())


def core(book_id: str) -> dict | None:
    p = library.LIB / book_id / "core.json"
    if not p.is_file():
        return None
    c = json.loads(p.read_text())
    return c if c.get("v") == VERSION else None


def make_core(book_id: str, provider: str, force=False) -> dict:
    b = library.book(book_id)
    with library._lock(f"{book_id}/core"):
        if not force and (c := core(book_id)):
            return c
        parts = []
        for ch in b.chapters:
            if ch.kind == "chapter":
                c = card(book_id, ch.index)
                if not c:
                    raise llm.LLMError(f'Chapter "{ch.title}" has no card yet.')
                ls = "\n".join(f"- {l['lesson']}: {l.get('why', '')}" for l in c["lessons"])
                parts.append(f"=== {ch.title} ===\nCore: {c['core']}\n{ls}")
        authors = f" by {', '.join(b.authors)}" if b.authors else ""
        c = _ask(provider, BOOK.format(title=b.title, authors=authors, cards="\n\n".join(parts)), 5, "book")
        c = checked(provider, c, "\n\n".join(parts), "book: how its big ideas connect")
        c["v"] = VERSION
        (library.LIB / book_id / "core.json").write_text(json.dumps(c, indent=1, ensure_ascii=False))
        return c


def across() -> dict | None:
    p = library.LIB / "across.json"
    return json.loads(p.read_text()) if p.is_file() else None


def make_across(provider: str) -> dict:
    cores = [(b["title"], core(b["id"])) for b in library.list_books()]
    cores = [(t, c) for t, c in cores if c]
    if len(cores) < 2:
        raise llm.LLMError("Needs two books with a core lesson.")
    text = "\n\n".join(f"=== {t} ===\nCore: {c['core']}\n" + "\n".join(f"- {l['lesson']}" for l in c["lessons"])
                       for t, c in cores)
    c = _ask(provider, ACROSS.format(cores=text), 3, "across")
    (library.LIB / "across.json").write_text(json.dumps(c, indent=1, ensure_ascii=False))
    return c


# ---- background job: every chapter card, then the book card ------------------------------------
_jobs: dict[str, dict] = {}


def job(book_id: str) -> dict:
    return _jobs.get(book_id, {"state": "idle"})


def start(book_id: str, provider: str, workers: int = 4) -> dict:
    if job(book_id).get("state") == "running":
        return job(book_id)
    b = library.book(book_id)
    todo = [c.index for c in b.chapters if c.kind == "chapter" and not card(book_id, c.index)]
    st = _jobs[book_id] = {"state": "running", "total": len(todo) + 1, "done": 0, "errors": []}

    def one(i):
        try:
            make_card(book_id, i, provider)
        except Exception as e:
            st["errors"].append(f"{b.chapters[i].title}: {e}")
        st["done"] += 1

    def run():
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(workers) as ex:
            list(ex.map(one, todo))
        if not st["errors"]:
            try:
                make_core(book_id, provider, force=True)
            except Exception as e:
                st["errors"].append(f"Book card: {e}")
        st["done"] = st["total"]
        st["state"] = "error" if st["errors"] else "done"

    threading.Thread(target=run, daemon=True).start()
    return st

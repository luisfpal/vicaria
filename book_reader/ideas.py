"""The latticework (Munger): every principle from every book's notes, filed under the mental models it uses.

Principles are read from the notes already on disk (### N. title + its claim). One model call per book tags
each principle with 1 or 2 mental models, reusing the names already in the library, so the same model
found in two books becomes one node with both books hanging off it. Stored in library/<book>/models.json."""
from __future__ import annotations

import json
import re
from collections import defaultdict

from . import library, llm

PROMPT = """Below are the principles a reader extracted from "{title}". Tag each one with the 1 or 2 mental models it \
is an instance of: the reusable, cross-disciplinary ideas Charlie Munger meant by a latticework, drawn from physics, \
chemistry, biology, mathematics, economics, psychology, engineering, philosophy, history.

Rules:
- Pick the most precise established model that genuinely explains why the principle holds. A wrong tag is worse than a narrow one.
- Short canonical name, 1 to 4 words, as the field names it (e.g. "Conservation of mass", "Capillary action", \
"Reductionism", "Path dependence", "Falsifiability", "Social proof", "Equilibrium").
- Names already in this reader's library (reuse one exactly only when it is truly the same model): {known}
- Prefer the model over the book's topic ("Capillary action", not "Candle wick").
- For each tag, one plain sentence on how this principle uses the model: name the mechanism, never restate the principle.
Reply with JSON only: {{"ideas": [{{"id": "...", "models": [{{"name": "...", "how": "..."}}]}}]}}

Principles:
{items}"""


def _principles(md: str) -> list[tuple[str, str]]:
    sec = re.search(r"^## Principles\s*\n(.*?)(?=^## )", md, re.S | re.M)
    if not sec:
        return []
    out = []
    for m in re.finditer(r"^### (?:\d+\.\s*)?([^\n]+)\n(.*?)(?=^### |\Z)", sec.group(1), re.S | re.M):
        body = re.sub(r"\[(Author|Clarification|Inference|My illustration)\]\s*", "", m.group(2)).strip()
        claim = body.split("\n\n")[0].replace("**Why it holds:**", "").strip()
        out.append((m.group(1).strip(), claim[:300]))
    return out


def collect(book_id: str) -> list[dict]:
    book, ideas = library.book(book_id), []
    for c in book.chapters:
        n = library.note(book_id, c.index) if c.kind == "chapter" else None
        for k, (title, claim) in enumerate(_principles(n["markdown"]) if n else []):
            ideas.append({"id": f"{c.index}.{k}", "chapter": c.title, "chapter_index": c.index, "title": title, "claim": claim})
    return ideas


def _tags_path(book_id):
    return library.LIB / book_id / "models.json"


def tags(book_id: str) -> dict:
    p = _tags_path(book_id)
    return json.loads(p.read_text()) if p.is_file() else {}


def known_models(exclude: str | None = None) -> list[str]:
    names = set()
    for b in library.list_books():
        if b["id"] != exclude:
            for ms in tags(b["id"]).get("ideas", {}).values():
                names.update(m["name"] for m in ms)
    return sorted(names)


def tag_book(book_id: str, provider: str) -> dict:
    ideas = collect(book_id)
    if not ideas:
        raise llm.LLMError("Distill some chapters first: mental models are read from the chapter notes.")
    items = "\n".join(f"{i['id']}: {i['title']}. {i['claim']}" for i in ideas)
    prompt = PROMPT.format(title=library.book(book_id).title, known=", ".join(known_models(book_id)) or "(none yet)", items=items)
    raw = "".join(llm.stream(provider, "You classify ideas precisely. Reply with JSON only.", prompt, max_tokens=6000))
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        got = json.loads(m.group(0)) if m else {}
    except json.JSONDecodeError:
        got = {}
    valid = {i["id"] for i in ideas}
    out = {}
    for it in got.get("ideas", []):
        if str(it.get("id")) in valid:
            ms = [{"name": str(x.get("name", "")).strip()[:40], "how": str(x.get("how", "")).strip()[:300]}
                  for x in it.get("models", []) if isinstance(x, dict) and x.get("name")]
            if ms:
                out[str(it["id"])] = ms[:2]
    if not out:
        raise llm.LLMError("The model did not return usable tags; try again or pick another model.")
    data = {"model": llm.model_name(provider), "ideas": out}
    _tags_path(book_id).write_text(json.dumps(data, indent=1, ensure_ascii=False))
    return data


def lattice() -> dict:
    """Mental models as nodes; each holds the ideas (from any book) that use it. Cross-book models first."""
    models: dict[str, dict] = defaultdict(lambda: {"ideas": [], "books": set()})
    books = []
    for b in library.list_books():
        t = tags(b["id"]).get("ideas", {})
        ideas = collect(b["id"])
        books.append({"id": b["id"], "title": b["title"], "authors": b["authors"], "ideas": len(ideas),
                      "tagged": bool(t), "stale": bool(t) and any(i["id"] not in t for i in ideas)})
        for i in ideas:
            for m in t.get(i["id"], []):
                key = m["name"].lower()
                node = models[key]
                node.setdefault("name", m["name"])
                node["ideas"].append({**i, "book": b["id"], "book_title": b["title"], "how": m["how"]})
                node["books"].add(b["id"])
    out = [{"name": v["name"], "books": sorted(v["books"]), "ideas": v["ideas"]} for v in models.values()]
    out.sort(key=lambda m: (-len(m["books"]), -len(m["ideas"]), m["name"]))
    return {"books": books, "models": out}


def _first(text: str) -> str:
    """The first line of a claim, without list numbering: the supporting sentence."""
    return re.sub(r"^\d+\.\s*", "", (text or "").strip().split("\n")[0])


def _body(title: str, options: list[str], quote=None) -> str:
    """What may sit under a title on the graph: the first option that says something the title does not (content-word
    overlap at most 0.35, the card rule in DECISIONS 12), else a short quote from the chapter that also passes, else nothing."""
    from . import cards
    for o in options:
        if o and o.strip() and cards.overlap(title, o) <= cards.REPEAT:
            return o.strip()
    for q in (quote() if quote else []):
        if cards.overlap(title, q["text"]) <= cards.REPEAT:
            return "\u201c" + q["text"].strip("\u201c\u201d\" ") + "\u201d"
    return ""


def graph() -> dict:
    """The Ideas graph, like a vault of linked notes: books, their chapters (each with its one-line lesson), the book's
    key lessons linked to the chapters they come from, lessons that need several books, and mental models linked to
    every chapter that uses them, which is how chapters of different books meet."""
    from . import cards
    nodes, links, titles = [], [], {}
    norm = lambda x: re.sub(r"[^a-z0-9 ]", "", x.lower()).strip()
    for b in library.list_books():
        bid = b["id"]
        titles[b["title"]] = bid
        nodes.append({"id": f"b:{bid}", "type": "book", "label": b["title"], "book": bid, "authors": b["authors"]})
        chs = [ch for ch in library.book(bid).chapters if ch.kind == "chapter"]
        for ch in chs:
            nodes.append({"id": f"c:{bid}:{ch.index}", "type": "chapter", "label": ch.title, "book": bid, "book_title": b["title"],
                          "index": ch.index, "lesson": (cards.card(bid, ch.index) or {}).get("core", "")})
            links.append({"source": f"b:{bid}", "target": f"c:{bid}:{ch.index}"})
        c = cards.core(bid)
        for k, l in enumerate((c or {}).get("lessons", [])):
            nid = f"l:{bid}:{k}"
            want = [norm(t) for t in l.get("chapters") or []]
            src = [{"index": ch.index, "title": ch.title} for ch in chs
                   if any(w == norm(ch.title) or (norm(ch.title) and (w.startswith(norm(ch.title) + " ") or norm(ch.title).endswith(" " + w))) for w in want)]
            nodes.append({"id": nid, "type": "lesson", "label": l["lesson"], "why": _body(l["lesson"], [l.get("why", "")]),
                          "book": bid, "book_title": b["title"], "sources": src})
            links += [{"source": f"c:{bid}:{x['index']}", "target": nid} for x in src] or [{"source": f"b:{bid}", "target": nid}]
    have = {n["id"] for n in nodes}
    for m in lattice()["models"]:
        nid = "m:" + m["name"].lower()
        nodes.append({"id": nid, "type": "model", "label": m["name"], "shared": len(m["books"]) > 1, "books": m["books"],
                      "ideas": [{**{k: i[k] for k in ("title", "claim", "book", "book_title", "chapter", "chapter_index")},
                                   "how": _body(i["title"], [i["how"], _first(i["claim"])], lambda i=i: _best_blocks(
                                       i["book"], [i["chapter_index"]], i["title"] + " " + i["claim"], 1, n=140))}
                                for i in m["ideas"][:12]]})
        for t in dict.fromkeys(f"c:{i['book']}:{i['chapter_index']}" for i in m["ideas"]):
            if t in have:
                links.append({"source": t, "target": nid})
    a = cards.across()
    for k, l in enumerate((a or {}).get("lessons", [])):
        bs = [titles[t] for t in l.get("books", []) if t in titles]
        if len(bs) < 2:
            continue
        nid = f"x:{k}"
        nodes.append({"id": nid, "type": "across", "label": l["lesson"], "why": _body(l["lesson"], [l.get("why", "")]),
                      "books": [{"id": x, "title": t} for t, x in titles.items() if x in bs]})
        links += [{"source": f"b:{x}", "target": nid} for x in bs]
    return {"nodes": nodes, "links": links}


# ---- evidence: the passages in the books behind an idea, so a click on the graph leads back into the text ----------
def _best_blocks(book_id: str, chapter_indexes: list[int] | None, query: str, k: int = 1, n: int = 300) -> list[dict]:
    """Paragraphs that best match the query (BM25 over paragraphs, idf from the whole book). No model call."""
    import math
    from collections import Counter
    from . import chat
    b = library.book(book_id)
    chs = [c for c in b.chapters if c.kind == "chapter" and (chapter_indexes is None or c.index in chapter_indexes)]
    _, docs, df, _ = chat._index(book_id, (library.LIB / book_id / "book.epub").stat().st_mtime)
    N, q = max(1, len(docs)), set(chat._tokens(query))
    scored = []
    for c in chs:
        for j, blk in enumerate(c.blocks):
            if blk["type"] == "img" or len(blk["text"]) < 60:
                continue
            d = Counter(chat._tokens(blk["text"]))
            L, s = sum(d.values()) or 1, 0.0
            for w in q & d.keys():
                idf = math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5))
                s += idf * d[w] * 2.2 / (d[w] + 1.2 * (0.25 + 0.75 * L / 60))
            if s > 0:
                scored.append((s, c, j, blk["text"]))
    scored.sort(key=lambda x: -x[0])
    out, used = [], set()
    for s, c, j, text in scored:
        if c.index in used:
            continue  # one passage per chapter reads better than three from the same page
        used.add(c.index)
        out.append({"book": book_id, "book_title": b.title, "chapter": c.index, "chapter_title": c.title, "block": j,
                    "text": _excerpt(text, q, n)})
        if len(out) >= k:
            break
    return out


def _excerpt(text: str, q: set, n: int = 300) -> str:
    """The sentence richest in query words, with its neighbours, cut to about n characters at sentence ends."""
    from . import chat
    sents = re.split(r"(?<=[.!?])\s+", text.strip())
    if len(text) <= n:
        return text.strip()
    best = max(range(len(sents)), key=lambda i: len(q & set(chat._tokens(sents[i]))))
    lo = hi = best
    while True:
        grow = False
        if hi + 1 < len(sents) and len(" ".join(sents[lo:hi + 2])) <= n:
            hi += 1; grow = True
        if lo > 0 and len(" ".join(sents[lo - 1:hi + 1])) <= n:
            lo -= 1; grow = True
        if not grow:
            break
    out = " ".join(sents[lo:hi + 1])
    if len(out) > n:
        out = out[:n].rsplit(" ", 1)[0] + "…"
    return ("… " if lo > 0 else "") + out + (" …" if hi < len(sents) - 1 and not out.endswith("…") else "")


def evidence(node_id: str) -> list[dict]:
    from . import cards
    kind, _, rest = node_id.partition(":")
    if kind == "c":
        bid, i = rest.rsplit(":", 1)
        c = cards.card(bid, int(i)) or {}
        q = " ".join([c.get("core", "")] + [l.get("lesson", "") for l in c.get("lessons", [])])
        return _best_blocks(bid, [int(i)], q, 2) if q.strip() else []
    if kind == "l":
        bid, k = rest.rsplit(":", 1)
        node = next((n for n in graph()["nodes"] if n["id"] == node_id), None)
        if not node:
            return []
        idx = [s["index"] for s in node["sources"]] or None
        return _best_blocks(bid, idx, node["label"] + " " + node.get("why", ""), 3)
    if kind == "m":
        m = next((x for x in lattice()["models"] if x["name"].lower() == rest), None)
        out = []
        for i in (m or {}).get("ideas", [])[:6]:
            out += _best_blocks(i["book"], [i["chapter_index"]], " ".join([i.get("title", ""), i.get("claim", ""), i.get("how", "")]), 1)
        return out
    if kind == "x":
        node = next((n for n in graph()["nodes"] if n["id"] == node_id), None)
        out = []
        for b in (node or {}).get("books", []):
            out += _best_blocks(b["id"], None, node["label"] + " " + node.get("why", ""), 1)
        return out
    return []

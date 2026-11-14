"""Concept diagrams on demand: the model writes a small graph as JSON, we lay it out once (top-down tree plus
cross-links) and draw that same layout in the app (SVG) and as an editable Excalidraw file.

Rules come from Novak's criteria for good concept maps (docs/RESEARCH.md)."""
from __future__ import annotations

import json
import random
import re
import textwrap

from .excalidraw import ACCENT, INK, LINE, PAPER, _base, _text


def instructions(whole: bool) -> str:
    size = "12 to 22 concepts, up to 4 levels deep" if whole else "7 to 13 concepts, up to 3 levels deep"
    return f"""Draw a concept diagram of {"the whole book: how its main ideas form one system" if whole else "this chapter"}.
A good learning diagram (Novak's rules) has:
1. A focus question it answers.
2. One idea per box: a short noun phrase of 1 to 5 words. Never a sentence in a box.
3. Every link labelled with a specific verb phrase of 1 to 3 words (causes, requires, limits, is evidence for, prevents, leads to). Never "related to", "is", "includes". Reading box, link, box aloud must give a true statement from the book.
4. Most general idea at the top, specific ones below, at most 4 children per box. Include the author's key example as a box at the bottom of its branch.
5. 1 to 3 cross-links between different branches: the non-obvious connections that make the ideas one system.
6. {size}. Only what explains; nothing decorative. Every box connected.

Reply with exactly one fenced block and then 2 to 4 sentences on how to read the diagram (start at the top; say which cross-link matters most and why). The block:
```diagram
{{"focus": "the question the diagram answers?",
 "nodes": [{{"id": "a", "label": "Short concept"}}, {{"id": "b", "label": "Another"}}],
 "links": [{{"from": "a", "to": "b", "label": "requires"}}],
 "cross": [{{"from": "b", "to": "a", "label": "reinforces"}}]}}
```
"links" form the tree from the top concept down; "cross" are the cross-links. Use the language the reader is using."""


def parse(md: str) -> dict | None:
    m = re.search(r"```(?:diagram|json)\s*\n(.*?)```", md, re.S)
    if not m:
        return None
    try:
        g = json.loads(m.group(1))
    except json.JSONDecodeError:
        return None
    if not isinstance(g, dict) or not g.get("nodes"):
        return None
    g["prose"] = (md[:m.start()] + md[m.end():]).strip()
    return g


def _wrap(label: str) -> list[str]:
    return textwrap.wrap(label, 20) or [""]


def layout(g: dict | None) -> dict | None:
    if not g:
        return None
    nodes = {}
    for n in g["nodes"]:
        if isinstance(n, dict) and n.get("id") is not None and str(n["id"]) not in nodes:
            lines = _wrap(str(n.get("label", n["id"])))
            nodes[str(n["id"])] = {"id": str(n["id"]), "label": " ".join(lines), "lines": lines,
                                   "w": max(110, min(210, max(len(l) for l in lines) * 8 + 32)), "h": 20 + 19 * len(lines),
                                   "kids": [], "parent": None}
    edges = []
    for cross, key in ((False, "links"), (True, "cross")):
        for e in g.get(key) or []:
            a, b = str(e.get("from")), str(e.get("to"))
            if a in nodes and b in nodes and a != b:
                edges.append({"from": a, "to": b, "label": str(e.get("label") or ""), "cross": cross})

    def ancestor(a, b):  # is a an ancestor of b (or b itself)?
        while b is not None:
            if a == b:
                return True
            b = nodes[b]["parent"]
        return False

    for e in edges:  # first tree link into a node makes the parent; the rest become cross-links
        if not e["cross"] and nodes[e["to"]]["parent"] is None and not ancestor(e["to"], e["from"]):
            nodes[e["to"]]["parent"] = e["from"]
            nodes[e["from"]]["kids"].append(e["to"])
        else:
            e["cross"] = True
    roots = [k for k, n in nodes.items() if n["parent"] is None]
    GAP, VGAP, INDENT, SGAP = 28, 70, 22, 10

    def stacked(n):  # 3+ leaf children hang as a compact column instead of a wide row
        return len(n["kids"]) >= 3 and all(not nodes[c]["kids"] for c in n["kids"])

    def width(k, d):
        n = nodes[k]
        n["level"] = d
        for c in n["kids"]:
            width(c, d + 1)
        if stacked(n):
            n["sub"] = max(n["w"], INDENT + max(nodes[c]["w"] for c in n["kids"]))
        else:
            kids = sum(nodes[c]["sub"] for c in n["kids"]) + GAP * max(0, len(n["kids"]) - 1)
            n["sub"] = max(n["w"], kids)
        return n["sub"]

    def place(k, x0, y):
        n = nodes[k]
        n["y"] = y
        if stacked(n):
            n["x"] = x0 + (n["sub"] - max(n["w"], INDENT + max(nodes[c]["w"] for c in n["kids"]))) / 2
            cy = y + n["h"] + 26
            for c in n["kids"]:
                nodes[c].update(x=n["x"] + INDENT, y=cy, stack=True)
                cy += nodes[c]["h"] + SGAP
            return
        n["x"] = x0 + (n["sub"] - n["w"]) / 2
        kids = sum(nodes[c]["sub"] for c in n["kids"]) + GAP * max(0, len(n["kids"]) - 1)
        x = x0 + (n["sub"] - kids) / 2
        for c in n["kids"]:
            place(c, x, y + n["h"] + VGAP)
            x += nodes[c]["sub"] + GAP

    x = 0.0
    for r in roots:
        width(r, 0)
        place(r, x, 60.0)
        x += nodes[r]["sub"] + GAP * 2

    def clip(n, tx, ty):  # point on n's border toward (tx, ty)
        cx, cy = n["x"] + n["w"] / 2, n["y"] + n["h"] / 2
        dx, dy = tx - cx, ty - cy
        if not dx and not dy:
            return cx, cy
        s = min(n["w"] / 2 / abs(dx) if dx else 1e9, n["h"] / 2 / abs(dy) if dy else 1e9)
        return cx + dx * s, cy + dy * s

    for e in edges:
        a, b = nodes[e["from"]], nodes[e["to"]]
        if not e["cross"] and b.get("stack"):
            e.update(x1=a["x"] + INDENT / 2, y1=a["y"] + a["h"], x2=b["x"], y2=b["y"] + b["h"] / 2, stack=True)
        elif not e["cross"]:
            e.update(x1=a["x"] + a["w"] / 2, y1=a["y"] + a["h"], x2=b["x"] + b["w"] / 2, y2=b["y"])
        else:
            x1, y1 = clip(a, b["x"] + b["w"] / 2, b["y"] + b["h"] / 2)
            x2, y2 = clip(b, a["x"] + a["w"] / 2, a["y"] + a["h"] / 2)
            e.update(x1=x1, y1=y1, x2=x2, y2=y2)
    out_nodes = [{k: n[k] for k in ("id", "label", "lines", "x", "y", "w", "h", "level")} for n in nodes.values()]
    W = max((n["x"] + n["w"] for n in out_nodes), default=0)
    H = max((n["y"] + n["h"] for n in out_nodes), default=0)
    return {"focus": str(g.get("focus") or ""), "nodes": out_nodes, "edges": edges, "width": W, "height": H + 20,
            "prose": g.get("prose", "")}


def to_excalidraw(lay: dict, title: str) -> dict:
    random.seed(json.dumps(lay, sort_keys=True))
    els, boxes = [], {}
    if lay["focus"]:
        els.append(_text(0, 0, max(lay["width"], 400), 32, lay["focus"], 24, None, ACCENT) | {"textAlign": "left"})
    for n in lay["nodes"]:
        root = n["level"] == 0
        box = _base("rectangle", n["x"], n["y"], n["w"], n["h"], roundness={"type": 3},
                    backgroundColor=ACCENT if root else PAPER, strokeColor=ACCENT if root else INK)
        t = _text(n["x"] + 6, n["y"] + 6, n["w"] - 12, n["h"] - 12, "\n".join(n["lines"]), 16, box["id"],
                  PAPER if root else INK)
        box["boundElements"].append({"id": t["id"], "type": "text"})
        boxes[n["id"]] = box
        els += [box, t]
    for e in lay["edges"]:
        a, b = boxes[e["from"]], boxes[e["to"]]
        dx, dy = e["x2"] - e["x1"], e["y2"] - e["y1"]
        arrow = _base("arrow", e["x1"], e["y1"], dx, dy, points=e.get("pts") or [[0, 0], [dx, dy]],
                      strokeColor=ACCENT if e["cross"] else LINE, strokeStyle="dashed" if e["cross"] else "solid",
                      startArrowhead=None, endArrowhead="arrow", roundness={"type": 2},
                      startBinding={"elementId": a["id"], "focus": 0, "gap": 4},
                      endBinding={"elementId": b["id"], "focus": 0, "gap": 4})
        a["boundElements"].append({"id": arrow["id"], "type": "arrow"})
        b["boundElements"].append({"id": arrow["id"], "type": "arrow"})
        els.append(arrow)
        if e["label"]:
            lt = _text(e["x1"] + dx / 2 - 45, e["y1"] + dy / 2 - 10, 90, 20, e["label"], 14, arrow["id"],
                       ACCENT if e["cross"] else INK)
            arrow["boundElements"].append({"id": lt["id"], "type": "text"})
            els.append(lt)
    return {"type": "excalidraw", "version": 2, "source": "book_reader", "elements": els,
            "appState": {"viewBackgroundColor": "#f7f4ee", "gridSize": None}, "files": {}}

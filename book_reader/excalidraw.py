"""Turn a note's ```map tree into an editable Excalidraw file (left-to-right tree, relations on arrows)."""
from __future__ import annotations

import json
import random
import re

ACCENT, INK, PAPER, LINE = "#b4532a", "#22201c", "#fffdf8", "#8a8378"


def parse_map(md: str) -> list[dict]:
    m = re.search(r"```map\s*\n(.*?)```", md, re.S)
    if not m:
        return []
    root = {"kids": [], "depth": -1}
    stack = [root]
    for line in m.group(1).splitlines():
        mm = re.match(r"^(\s*)[-*]\s+(.*)$", line)
        if not mm:
            continue
        depth = len(mm.group(1).replace("\t", "  ")) // 2
        label, rel = mm.group(2).strip(), None
        r = re.match(r"^\[([^\]]+)\]\s*(.*)$", label)
        if r:
            rel, label = r.group(1), r.group(2)
        node = {"label": label, "rel": rel, "depth": depth, "kids": []}
        while len(stack) > 1 and stack[-1]["depth"] >= depth:
            stack.pop()
        stack[-1]["kids"].append(node)
        stack.append(node)
    return root["kids"]


def _base(kind, x, y, w, h, **kw):
    seed = random.randint(1, 2**31 - 1)
    el = {"id": f"{kind[:2]}{seed:x}", "type": kind, "x": x, "y": y, "width": w, "height": h, "angle": 0,
          "strokeColor": INK, "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": 1.5,
          "strokeStyle": "solid", "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
          "roundness": None, "seed": seed, "version": 1, "versionNonce": seed ^ 0x5bd1e995, "isDeleted": False,
          "boundElements": [], "updated": 1, "link": None, "locked": False}
    el.update(kw)
    return el


def _text(x, y, w, h, s, size, container=None, color=INK):
    return _base("text", x, y, w, h, text=s, originalText=s, fontSize=size, fontFamily=1, textAlign="center",
                 verticalAlign="middle", containerId=container, lineHeight=1.25, autoResize=True, strokeColor=color)


def to_excalidraw(md: str, title: str) -> dict:
    roots = parse_map(md)
    if len(roots) != 1:
        roots = [{"label": title, "rel": None, "kids": roots}]
    random.seed(hash(md) & 0xFFFFFFFF)
    els: list[dict] = []
    col_w: dict[int, float] = {}

    def size(n, d=0):
        n["d"] = d
        n["w"] = max(110, 9.5 * len(n["label"]) + 32) if d else max(160, 12 * len(n["label"]) + 40)
        n["h"] = 48 if d else 60
        col_w[d] = max(col_w.get(d, 0), n["w"])
        for k in n["kids"]:
            size(k, d + 1)

    leaf_y = [0.0]

    def place(n):
        if n["kids"]:
            for k in n["kids"]:
                place(k)
            n["y"] = (n["kids"][0]["y"] + n["kids"][-1]["y"]) / 2
        else:
            n["y"] = leaf_y[0]
            leaf_y[0] += 72

    def draw(n):
        x = sum(col_w[i] + 120 for i in range(n["d"]))
        root = n["d"] == 0
        box = _base("rectangle", x, n["y"] - n["h"] / 2, n["w"], n["h"], roundness={"type": 3},
                    backgroundColor=ACCENT if root else PAPER, strokeColor=ACCENT if root else INK)
        t = _text(x + 8, n["y"] - 14, n["w"] - 16, 28, n["label"], 22 if root else 18, box["id"],
                  PAPER if root else INK)
        box["boundElements"].append({"id": t["id"], "type": "text"})
        els.extend([box, t])
        n["box"], n["x"] = box, x
        for k in n["kids"]:
            draw(k)
            kx = sum(col_w[i] + 120 for i in range(k["d"]))
            x0, y0, x1, y1 = x + n["w"], n["y"], kx, k["y"]
            arrow = _base("arrow", x0, y0, x1 - x0, y1 - y0, points=[[0, 0], [x1 - x0, y1 - y0]],
                          strokeColor=LINE, startArrowhead=None, endArrowhead="arrow", roundness={"type": 2},
                          startBinding={"elementId": box["id"], "focus": 0, "gap": 4},
                          endBinding={"elementId": k["box"]["id"], "focus": 0, "gap": 4})
            box["boundElements"].append({"id": arrow["id"], "type": "arrow"})
            k["box"]["boundElements"].append({"id": arrow["id"], "type": "arrow"})
            els.append(arrow)
            if k["rel"]:
                lt = _text(x0 + (x1 - x0) / 2 - 40, y0 + (y1 - y0) / 2 - 10, 80, 20, k["rel"], 14, arrow["id"], ACCENT)
                arrow["boundElements"].append({"id": lt["id"], "type": "text"})
                els.append(lt)

    for r in roots:
        size(r)
        place(r)
        draw(r)
    return {"type": "excalidraw", "version": 2, "source": "book_reader", "elements": els,
            "appState": {"viewBackgroundColor": "#f7f4ee", "gridSize": None}, "files": {}}


def dumps(md: str, title: str) -> str:
    return json.dumps(to_excalidraw(md, title), indent=1)

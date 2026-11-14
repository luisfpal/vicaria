"""Diagrams that earn their place. A card's diagram is drawn only when the ideas have a structure a list cannot
show: a cause chain, a process, a feedback loop, a comparison, or a concept map with named relationships.
The model picks the type (or "none"); this module checks the shape in code and turns it into Mermaid source
that the app renders with the bundled Mermaid. A star (every node hanging off one centre) is a list in disguise
and is rejected.

Shape (stored in the card under "diagram"):
  {"type": "cause|process|cycle|map", "title": "...", "nodes": [{"id", "label"}], "edges": [{"from", "to", "label"}]}
  {"type": "compare", "title": "...", "sides": ["A", "B"], "rows": [{"aspect", "a", "b"}]}
  {"type": "none", "why": "..."}
"""
from __future__ import annotations

TYPES = {"cause": "Cause and effect", "process": "Process", "cycle": "Feedback loop", "map": "Concept map",
         "compare": "Comparison"}
FLOW = {"cause", "process", "cycle", "map"}


def _w(s) -> int:
    return len(str(s or "").split())


def _adj(nodes, edges):
    out = {n: [] for n in nodes}
    for e in edges:
        out[e["from"]].append(e["to"])
    return out


def _longest_path(nodes, edges) -> int:
    """Number of nodes on the longest simple directed path (graphs here have at most 8 nodes)."""
    adj, best = _adj(nodes, edges), 0

    def walk(n, seen):
        nonlocal best
        best = max(best, len(seen))
        for m in adj[n]:
            if m not in seen:
                walk(m, seen | {m})
    for n in nodes:
        walk(n, {n})
    return best


def _has_cycle(nodes, edges) -> bool:
    adj, state = _adj(nodes, edges), {}

    def dfs(n):
        state[n] = 1
        for m in adj[n]:
            if state.get(m) == 1 or (m not in state and dfs(m)):
                return True
        state[n] = 2
        return False
    return any(n not in state and dfs(n) for n in nodes)


def is_star(nodes, edges) -> bool:
    """All nodes hang from one hub and no edge joins two other nodes: a list drawn as boxes."""
    if len(nodes) < 3 or not edges:
        return False
    for hub in nodes:
        if all(hub in (e["from"], e["to"]) for e in edges):
            if len(nodes) >= 4:
                return True
            outs = sum(e["from"] == hub for e in edges)
            return outs in (0, len(edges))  # three nodes: a->b, a->c is a fan; a->b->c is a chain
    return False


def problems(d) -> list[str]:
    """What is wrong with a diagram spec (empty = fine, including a deliberate "none")."""
    if not isinstance(d, dict):
        return ["diagram missing: give a diagram object or type none"]
    t = d.get("type")
    if t == "none":
        return []
    if t not in TYPES:
        return [f"diagram type {t!r} is not one of {sorted(TYPES) + ['none']}"]
    out = []
    if t == "compare":
        sides, rows = d.get("sides") or [], d.get("rows") or []
        if len(sides) != 2 or not all(str(s).strip() for s in sides):
            out.append("compare needs exactly 2 sides")
        if not 3 <= len(rows) <= 5:
            out.append(f"compare has {len(rows)} rows, need 3 to 5")
        for r in rows:
            if not isinstance(r, dict) or not all(str(r.get(k, "")).strip() for k in ("aspect", "a", "b")):
                out.append("every compare row needs aspect, a and b"); break
            if _w(r["a"]) > 9 or _w(r["b"]) > 9 or _w(r["aspect"]) > 4:
                out.append(f"compare row {r['aspect']!r} is too long (aspect <= 3 words, cells <= 8)")
        return out
    nodes = [n for n in d.get("nodes") or [] if isinstance(n, dict) and str(n.get("id", "")).strip()]
    ids = [str(n["id"]) for n in nodes]
    edges = [e for e in d.get("edges") or [] if isinstance(e, dict)]
    if not 3 <= len(nodes) <= 8:
        return [f"diagram has {len(nodes)} nodes, need 3 to 7"]
    if len(set(ids)) != len(ids):
        out.append("duplicate node ids")
    for n in nodes:
        if not str(n.get("label", "")).strip() or _w(n["label"]) > 6:
            out.append(f"node {n['id']} label must be 2 to 5 words")
    labels = [str(n.get("label", "")).strip().lower() for n in nodes]
    if len(set(labels)) != len(labels):
        out.append("two nodes have the same label")
    for e in edges:
        e["from"], e["to"] = str(e.get("from")), str(e.get("to"))
        if e["from"] not in ids or e["to"] not in ids:
            out.append(f"edge {e['from']}->{e['to']} points to a missing node")
        if not str(e.get("label", "")).strip() or _w(e["label"]) > 4:
            out.append(f"edge {e['from']}->{e['to']} needs a 1 to 3 word verb label")
    if out:
        return out
    if len(edges) < len(nodes) - 1:
        return ["some nodes are not connected"]
    seen, todo = {ids[0]}, [ids[0]]
    while todo:
        n = todo.pop()
        for e in edges:
            for a, b in ((e["from"], e["to"]), (e["to"], e["from"])):
                if a == n and b not in seen:
                    seen.add(b); todo.append(b)
    if len(seen) != len(ids):
        out.append("some nodes are not connected")
    if is_star(ids, edges):
        out.append("every node hangs off one centre node: that is a list, not a diagram. Show how the parts "
                   "relate to each other, or choose type none")
    if t == "cycle" and not _has_cycle(ids, edges):
        out.append("a feedback loop needs edges that return to the start")
    if t in ("cause", "process") and _longest_path(ids, edges) < 3:
        out.append(f"a {t} diagram needs a chain of at least 3 steps")
    return out


def clean(d) -> dict | None:
    """The diagram to show, or None (no diagram, or one that failed its checks)."""
    if not isinstance(d, dict) or d.get("type") in (None, "none") or problems(d):
        return None
    return d


def _q(s) -> str:
    return '"' + str(s).replace('"', "#quot;").replace("\n", " ").strip() + '"'


def mermaid(d) -> str | None:
    """Mermaid flowchart source for a flow diagram (compare is drawn as a table by the app)."""
    d = clean(d)
    if not d or d["type"] not in FLOW:
        return None
    ids = {str(n["id"]): f"n{k}" for k, n in enumerate(d["nodes"])}
    lines = ["flowchart TD"]
    for n in d["nodes"]:
        lines.append(f"  {ids[str(n['id'])]}[{_q(n['label'])}]")
    for e in d["edges"]:
        lines.append(f"  {ids[e['from']]} -->|{_q(e['label'])}| {ids[e['to']]}")
    return "\n".join(lines)


def view(d) -> dict | None:
    """What the app needs to draw a card's diagram."""
    d = clean(d)
    if not d:
        return None
    return {"type": d["type"], "kind": TYPES[d["type"]], "title": d.get("title", ""), "mermaid": mermaid(d),
            "sides": d.get("sides"), "rows": d.get("rows")}

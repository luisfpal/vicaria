// Drawing marks on a section. Marks arrive sorted by place; text nodes of a block are indexed once and shared by all
// marks in that block, so the work grows with the text plus the marks, not with their product.
import type { Mark } from "../core/marks";

type Index = { nodes: Text[]; starts: number[]; text: string };
function indexBlock(block: Element): Index {
  const nodes: Text[] = [], starts: number[] = []; let text = "";
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { starts.push(text.length); nodes.push(n as Text); text += (n as Text).data; }
  return { nodes, starts, text };
}
function pointIn(ix: Index, off: number): [Text, number] | null {
  if (!ix.nodes.length) return null;
  let lo = 0, hi = ix.nodes.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ix.starts[mid] <= off) lo = mid; else hi = mid - 1; }
  const n = ix.nodes[lo]; return [n, Math.min(off - ix.starts[lo], n.data.length)];
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type Span = { start: number; end: number; m: Mark };
const MATHY = "math, svg";

// Returns the marks that could not be drawn (text changed beyond what the anchor can find).
// One pass per block: every mark becomes a span of the block's text, the text nodes are split once at all span edges,
// and each piece is wrapped in the marks that cover it (nested, longest outside). Text inside math or SVG is not
// wrapped (that breaks rendering); the formula itself carries the color instead.
export function paintMarks(root: HTMLElement, marks: Mark[], section: number, how: "auto" | "dom" | "highlight" = "auto"): Mark[] {
  const { spans, missed, ix } = spansFor(root, marks, section);
  const useHl = how === "highlight" || (how === "auto" && canHighlight());
  clearHighlights();
  if (useHl) paintHighlights(spans, ix); else for (const [b, list] of spans) paintBlock(ix(b)!, list);
  return missed;
}

function spansFor(root: HTMLElement, marks: Mark[], section: number) {
  const missed: Mark[] = [];
  const blocks = new Map<number, Element>();
  for (const b of root.querySelectorAll("[data-b]")) blocks.set(+(b as HTMLElement).dataset.b!, b);
  const cache = new Map<number, Index>();
  const ix = (b: number) => { let x = cache.get(b); if (!x) { const el = blocks.get(b); if (!el) return null; cache.set(b, x = indexBlock(el)); } return x; };
  const spans = new Map<number, Span[]>();
  const add = (b: number, start: number, end: number, m: Mark) => { if (end <= start) return; const l = spans.get(b); if (l) l.push({ start, end, m }); else spans.set(b, [{ start, end, m }]); };
  for (const m of marks) {
    if (!m.at || m.at.section !== section || m.gone || !(m.color || m.note) || m.bookmark) continue;
    const a = m.at, eb = a.endBlock ?? a.block;
    const si = ix(a.block), ei = ix(eb);
    if (!si || !ei || !a.exact) { missed.push(m); continue; }
    if (eb === a.block) {
      let s = a.offset, e = a.endOffset ?? a.offset + a.exact.length;
      const got = si.text.slice(s, e);
      if (got !== a.exact && norm(got) !== norm(a.exact)) {
        // text moved inside the block: look for the quote with its context, then alone
        let i = si.text.indexOf(a.prefix + a.exact + a.suffix); if (i >= 0) i += a.prefix.length; else i = si.text.indexOf(a.exact);
        if (i < 0) { missed.push(m); continue; }
        s = i; e = i + a.exact.length;
      }
      add(a.block, s, e, m);
    } else {
      const e = a.endOffset ?? 0, parts = [si.text.slice(a.offset)];
      for (let k = a.block + 1; k < eb; k++) parts.push(ix(k)?.text ?? "");
      parts.push(ei.text.slice(0, e));
      if (norm(parts.join(" ")) !== norm(a.exact)) { missed.push(m); continue; }
      add(a.block, a.offset, si.text.length, m);
      for (let k = a.block + 1; k < eb; k++) { const x = ix(k); if (x) add(k, 0, x.text.length, m); }
      add(eb, 0, e, m);
    }
  }
  return { spans, missed, ix };
}

// The CSS Custom Highlight API draws marks without touching the page: no extra elements, so no extra style and
// layout work (measured: about 110 ms at 4x CPU for 500 marks with elements). Used where supported, except when the
// reader asks for more contrast (highlights cannot have an outline), where marks are elements as before.
declare const Highlight: { new (...r: Range[]): { priority: number; add(r: Range): void } };
const HL = typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined;
export const canHighlight = () => !!HL && typeof Highlight !== "undefined" && !matchMedia("(prefers-contrast: more)").matches;
export interface Painted { m: Mark; range: Range }
let painted: Painted[] = [];
function clearHighlights() { painted = []; if (HL) for (const k of [...HL.keys()]) if (k.startsWith("vic-")) HL.delete(k); }
function paintHighlights(spans: Map<number, Span[]>, ix: (b: number) => Index | null) {
  const groups = new Map<string, Range[]>();
  for (const [b, list] of spans) {
    const x = ix(b)!;
    for (const sp of list) {
      const s = pointIn(x, sp.start), e = pointIn(x, sp.end); if (!s || !e) continue;
      const r = document.createRange(); r.setStart(s[0], s[1]); r.setEnd(e[0], e[1]);
      painted.push({ m: sp.m, range: r });
      const key = sp.m.color ? `vic-${sp.m.color}${sp.m.style && sp.m.style !== "fill" ? "-" + sp.m.style : ""}` : "vic-none";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
      if (sp.m.note && !(sp.m.style && sp.m.style !== "fill")) (groups.get("vic-note") ?? groups.set("vic-note", []).get("vic-note")!).push(r);
    }
  }
  for (const [k, rs] of groups) { const h = new Highlight(...rs); h.priority = k === "vic-note" ? 2 : k.includes("-", 4) ? 1 : 0; HL!.set(k, h); }
}
// the mark under a point (smallest one when they overlap), for taps and clicks
export function markAt(x: number, y: number): Painted | null {
  if (!painted.length) return null;
  const d = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
  let node: Node | null = null, off = 0;
  if (d.caretPositionFromPoint) { const c = d.caretPositionFromPoint(x, y); if (c) { node = c.offsetNode; off = c.offset; } }
  else { const r = document.caretRangeFromPoint?.(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
  if (!node) return null;
  let best: Painted | null = null, size = Infinity;
  for (const p of painted) {
    try { if (!p.range.isPointInRange(node, off)) continue; } catch { continue; }
    // the caret lands between characters: make sure the point is really over the mark's text, not just next to it
    if (![...p.range.getClientRects()].some(b => x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1)) continue;
    const n = p.range.toString().length; if (n < size) { best = p; size = n; }
  }
  return best;
}
export const paintedMarks = () => painted;
if (typeof window !== "undefined") (window as unknown as { __vicPaintedRanges: () => Range[] }).__vicPaintedRanges = () => painted.map(p => p.range);
if (typeof window !== "undefined") (window as unknown as { __vicPainted: () => { id: string; text: string; c?: string; s?: string; n: boolean }[] }).__vicPainted = () => painted.map(p => ({ id: p.m.id, text: p.range.toString(), c: p.m.color, s: p.m.style, n: !!p.m.note }));

function makeMark(m: Mark): HTMLElement {
  const el = document.createElement("mark");
  el.className = "hl"; el.dataset.h = m.id; el.dataset.c = m.color || "none";
  if (m.style && m.style !== "fill") el.dataset.s = m.style;
  if (m.note) el.dataset.n = "1";
  return el;
}
function paintBlock(ix: Index, list: Span[]) {
  // longest first, so it ends up outside; ties by place then id, so the result never depends on input order
  list.sort((x, y) => (y.end - y.start) - (x.end - x.start) || x.start - y.start || (x.m.id < y.m.id ? -1 : 1));
  const cuts = [...new Set(list.flatMap(s => [s.start, s.end]))].sort((x, y) => x - y);
  // split text nodes at every cut, keeping a list of [start, node] pieces in text order
  const pieces: [number, Text][] = [];
  let c = 0;
  ix.nodes.forEach((n, i) => {
    let at = ix.starts[i]; const end = at + n.data.length; let node = n;
    while (c < cuts.length && cuts[c] <= at) c++;
    while (c < cuts.length && cuts[c] < end) { const rest = node.splitText(cuts[c] - at); pieces.push([at, node]); at = cuts[c]; node = rest; c++; }
    pieces.push([at, node]);
  });
  for (const [at, node] of pieces) {
    const len = node.data.length; if (!len) continue;
    const over = list.filter(s => s.start <= at && at + len <= s.end);
    if (!over.length) continue;
    const mathy = node.parentElement?.closest(MATHY);
    if (mathy) { (mathy as HTMLElement).dataset.hc ||= over[0].m.color || "none"; continue; }
    let outer: HTMLElement | null = null, inner: HTMLElement | null = null;
    for (const s of over) { const el = makeMark(s.m); if (inner) inner.append(el); else outer = el; inner = el; }
    node.replaceWith(outer!); inner!.append(node);
  }
}

// One quiet column in the margin: at most one glyph per paragraph for its notes, sticky notes, bookmarks, loved
// places and AI answers. Positions come from layout, so they are recomputed when the page reflows.
export interface Glyph { block: number; marks: Mark[]; top: number; left: number }
export function glyphsFor(root: HTMLElement, marks: Mark[], section: number): Glyph[] {
  const by = new Map<number, Mark[]>();
  for (const m of marks) {
    if (!m.at || m.at.section !== section || m.gone) continue;
    if (!(m.note || m.sticky || m.bookmark || m.loved || m.ask)) continue;
    const b = m.at.block; const l = by.get(b); if (l) l.push(m); else by.set(b, [m]);
  }
  const out: Glyph[] = [];
  const box = root.getBoundingClientRect();
  const wrap = root.parentElement!.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(root).paddingRight) || 0;
  // just right of the text column, or at the screen edge when the text fills the screen
  const left = Math.min(box.right - pad + 10 - wrap.left, wrap.width - 18);
  for (const [block, ms] of by) {
    const el = root.querySelector<HTMLElement>(`[data-b="${block}"]`); if (!el) continue;
    out.push({ block, marks: ms, top: el.getBoundingClientRect().top - box.top, left: Math.max(0, left) });
  }
  return out.sort((a, b) => a.top - b.top);
}

// Highlight anchors: block index + text offset, with a text quote to re-find the spot if the text moved.
import type { Anchor } from "../core/types";

function textNodes(root: Node): Text[] {
  const out: Text[] = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}
function offsetIn(block: Element, node: Node, off: number): number {
  let n = 0;
  for (const t of textNodes(block)) { if (t === node) return n + off; n += t.data.length; }
  // node is an element: count text before its off-th child
  if (node.nodeType === 1) { const r = document.createRange(); r.setStart(block, 0); r.setEnd(node, off); return r.toString().length; }
  return n;
}
function pointAt(block: Element, off: number): [Text, number] | null {
  let n = 0; const ts = textNodes(block);
  for (const t of ts) { if (off <= n + t.data.length) return [t, off - n]; n += t.data.length; }
  const last = ts[ts.length - 1]; return last ? [last, last.data.length] : null;
}
const blockOf = (n: Node | null): HTMLElement | null => { let e: Node | null = n; while (e && !(e instanceof HTMLElement && e.dataset.b != null)) e = e.parentNode; return e as HTMLElement | null; };

export function anchorFromRange(r: Range, section: number): Anchor | null {
  const sb = blockOf(r.startContainer), eb = blockOf(r.endContainer);
  if (!sb || !eb) return null;
  const offset = offsetIn(sb, r.startContainer, r.startOffset), endOffset = offsetIn(eb, r.endContainer, r.endOffset);
  const exact = r.toString(); if (!exact.trim()) return null;
  const sText = sb.textContent || "", eText = eb.textContent || "";
  return { section, block: +sb.dataset.b!, offset, endBlock: +eb.dataset.b!, endOffset, exact: exact.slice(0, 4000), prefix: sText.slice(Math.max(0, offset - 32), offset), suffix: eText.slice(endOffset, endOffset + 32) };
}

export function rangeFromAnchor(root: HTMLElement, a: Anchor): Range | null {
  const sb = root.querySelector(`[data-b="${a.block}"]`), eb = root.querySelector(`[data-b="${a.endBlock ?? a.block}"]`);
  if (sb && eb) {
    const s = pointAt(sb, a.offset), e = pointAt(eb, a.endOffset ?? a.offset + a.exact.length);
    if (s && e) { const r = document.createRange(); r.setStart(s[0], s[1]); r.setEnd(e[0], e[1]); if (norm(r.toString()) === norm(a.exact)) return r; }
  }
  return findQuote(root, a);
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// Text moved (new importer, edited book): look for prefix + exact + suffix, then exact alone.
function findQuote(root: HTMLElement, a: Anchor): Range | null {
  const ts = textNodes(root); let full = ""; const starts: number[] = [];
  for (const t of ts) { starts.push(full.length); full += t.data; }
  let i = full.indexOf(a.prefix + a.exact + a.suffix); if (i >= 0) i += a.prefix.length; else i = full.indexOf(a.exact);
  if (i < 0) return null;
  const at = (pos: number): [Text, number] => { let k = 0; while (k + 1 < starts.length && starts[k + 1] <= pos) k++; return [ts[k], pos - starts[k]]; };
  const s = at(i), e = at(i + a.exact.length);
  const r = document.createRange(); r.setStart(s[0], s[1]); r.setEnd(e[0], e[1]); return r;
}

export function wrapRange(r: Range, make: () => HTMLElement) {
  const root = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode! : r.commonAncestorContainer;
  const segs = textNodes(root).filter(t => r.intersectsNode(t)).map(t => [t, t === r.startContainer ? r.startOffset : 0, t === r.endContainer ? r.endOffset : t.data.length] as const);
  for (const [t, s, e] of segs) {
    if (e <= s) continue;
    const sub = document.createRange(); sub.setStart(t, s); sub.setEnd(t, e);
    try { sub.surroundContents(make()); } catch { /* crosses an element edge: skip that piece */ }
  }
}

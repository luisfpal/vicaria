// Finding a quote in the new text. 0.x highlights and positions were stored as chapter and block numbers of the
// 0.x importer plus the quoted text; the new importer numbers things differently, so each one is found again by
// its quote. Offsets are counted in the text the reader shows (the block's textContent), like new anchors.
import { parseDocument, DomUtils } from "htmlparser2";
import type { AnyNode, Element } from "domhandler";
import type { Anchor } from "./types";

export interface BlockText { section: number; block: number; text: string; label: Uint8Array } // label[i]: 1 note number, 2 math (0.x dropped math from its text)
export function blockTexts(section: number, html: string): BlockText[] {
  const doc = parseDocument(html);
  const out: BlockText[] = [];
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (n.type !== "tag" && n.type !== "script" && n.type !== "style") continue;
      const e = n as Element;
      if (e.attribs["data-b"] != null) {
        let text = ""; const lab: number[] = [];
        const collect = (ns: AnyNode[], mark: number) => {
          for (const c of ns) {
            if (c.type === "text") { const d = (c as unknown as { data: string }).data.replace(/\r\n?/g, "\n"); /* line ends as the browser's HTML parser reads them */ text += d; for (let i = 0; i < d.length; i++) lab.push(mark); }
            else if ("children" in c) {
              const ce = c as Element;
              const m = mark || (/\bnref\b/.test(ce.attribs?.class || "") ? 1 : ce.name === "math" || ce.name === "svg" ? 2 : 0);
              collect(ce.children, m);
            }
          }
        };
        collect(e.children, 0);
        out.push({ section, block: +e.attribs["data-b"], text, label: Uint8Array.from(lab) });
      }
      walk(e.children);
    }
  };
  walk(doc.children);
  void DomUtils;
  return out;
}

// Normalized view of a text with a map back to raw offsets: whitespace runs become one space, invisible characters
// go, optionally note numbers go.
const isInvis = (c: number) => c === 0xad || c === 0x200b || c === 0x200c || c === 0x200d || c === 0x2060 || c === 0xfeff;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0xa0 || c === 0x2009 || c === 0x202f || c === 0x3000 || (c >= 0x2000 && c <= 0x200a);
// skip: which marked characters to leave out (0 none, 1 note numbers, 3 note numbers and math)
function normView(text: string, label: Uint8Array, skip: number, out: string[], map: number[], blk: number[], bi: number, space: boolean) {
  for (let i = 0; i < text.length; i++) {
    if (label[i] & skip) continue;
    const c = text.charCodeAt(i);
    if (isInvis(c)) continue;
    if (isSpace(c)) { if (space) continue; out.push(" "); space = true; } else { out.push(text[i]); space = false; }
    map.push(i); blk.push(bi);
  }
  return space;
}
// One view per section: blocks joined by a space, so a quote may run across blocks (0.x blocks were sometimes
// larger than the new ones).
type View = { s: string; map: number[]; blk: number[]; ends: number[] };
const views = new WeakMap<BlockText[], View[]>();
function viewsOf(blocks: BlockText[]): View[] {
  let v = views.get(blocks);
  if (!v) {
    v = [0, 1, 3].map(skip => {
      const out: string[] = [], map: number[] = [], blk: number[] = [];
      let space = true;
      blocks.forEach((b, bi) => {
        // canonical order of combining marks (Arabic shadda and tanween, for one) can differ between copies; NFC
        // fixes it, and when NFC keeps the length the offsets still point at the same characters
        const nfc = b.text.normalize("NFC");
        space = normView(nfc.length === b.text.length ? nfc : b.text, b.label, skip, out, map, blk, bi, space);
        if (!space) { out.push(" "); map.push(b.text.length); blk.push(bi); space = true; }
      });
      return { s: out.join(""), map, blk, ends: [] };
    });
    views.set(blocks, v);
  }
  return v;
}
const qLabel = new Uint8Array(0);
export const normQuote = (q: string) => { const out: string[] = []; normView(q.normalize("NFC"), qLabel, 0, out, [], [], 0, true); return out.join("").trim(); };

import { fuzzyFind, FUZZY_MARGIN, FUZZY_MIN_LEN } from "./fuzzy";
export interface Hint { fraction?: number } // where in the book the 0.x numbers point, 0..1
const sections = new WeakMap<BlockText[], { bySec: Map<number, BlockText[]>; total: number }>();
export function locate(blocks: BlockText[], quote: string, hint: Hint = {}, opt: { max?: number; margin?: number } = {}): Anchor | null {
  const q = normQuote(quote);
  if (q.length < 2) return null;
  let sec = sections.get(blocks);
  if (!sec) {
    const m = new Map<number, BlockText[]>();
    for (const b of blocks) { let a = m.get(b.section); if (!a) m.set(b.section, a = []); a.push(b); }
    sec = { bySec: m, total: blocks.reduce((n, b) => n + b.text.length, 0) || 1 };
    sections.set(blocks, sec);
  }
  const { bySec, total } = sec;
  type Cand = { bs: BlockText[]; v: View; i: number; j: number; at: number };
  const cands: Cand[] = [];
  const scan = (find: (s: string, push: (i: number, j: number) => void) => void) => {
    let before = 0;
    for (const bs of bySec.values()) {
      const size = bs.reduce((n, b) => n + b.text.length, 0);
      for (const v of viewsOf(bs)) {
        const n0 = cands.length;
        find(v.s, (i, j) => cands.push({ bs, v, i, j, at: (before + size * (i / Math.max(1, v.s.length))) / total }));
        if (cands.length > n0) break;
      }
      before += size;
    }
  };
  scan((s, push) => { let i = s.indexOf(q); while (i >= 0) { push(i, i + q.length); i = s.indexOf(q, i + 1); } });
  if (!cands.length && q.length >= 24) {
    // small differences inside the quote (a note number, a ligature): head and tail close together, in order
    const head = q.slice(0, 16), tail = q.slice(-16);
    scan((s, push) => {
      let i = s.indexOf(head);
      while (i >= 0) {
        const j = s.indexOf(tail, i + head.length - 1);
        if (j >= 0 && j + tail.length - i <= q.length * 1.25 + 4) push(i, j + tail.length);
        i = s.indexOf(head, i + 1);
      }
    });
  }
  if (!cands.length && q.length >= FUZZY_MIN_LEN) {
    // the text changed (another edition, fixed typos, other quotation marks): fuzzy, per section, then the best
    // section must be clearly better than the runner-up (or the hint must pick it)
    const found: (Cand & { score: number })[] = [];
    let before = 0;
    for (const bs of bySec.values()) {
      const size = bs.reduce((n, b) => n + b.text.length, 0);
      const v = viewsOf(bs)[1];
      const h = fuzzyFind(v.s, q, { max: opt.max, margin: opt.margin });
      if (h) found.push({ bs, v, i: h.start, j: h.end, at: (before + size * (h.start / Math.max(1, v.s.length))) / total, score: h.score });
      before += size;
    }
    found.sort((a, b) => a.score - b.score);
    const [b1, b2] = found;
    if (b1 && (!b2 || b2.score - b1.score >= (opt.margin ?? FUZZY_MARGIN) || (hint.fraction != null && Math.abs(b1.at - hint.fraction) * 2 < Math.abs(b2.at - hint.fraction)))) cands.push(b1);
  }
  if (!cands.length) return null;
  const f = hint.fraction;
  const best = f == null ? cands[0] : cands.reduce((a, c) => Math.abs(c.at - f) < Math.abs(a.at - f) ? c : a);
  const { v, bs } = best;
  let i = best.i, j = best.j - 1;
  while (i < j && v.s[i] === " ") i++;
  while (j > i && v.s[j] === " ") j--;
  const sb = bs[v.blk[i]], eb = bs[v.blk[j]];
  const start = v.map[i], end = v.map[j] + 1;
  const exact = sb === eb ? sb.text.slice(start, end) : bs.slice(v.blk[i], v.blk[j] + 1).map((b, k, all) => k === 0 ? b.text.slice(start) : k === all.length - 1 ? b.text.slice(0, end) : b.text).join("\n");
  return { section: sb.section, block: sb.block, offset: start, endBlock: eb.block, endOffset: end, exact, prefix: sb.text.slice(Math.max(0, start - 32), start), suffix: eb.text.slice(end, end + 32) };
}

// ---- marks made under another parser version ----
// The text an anchor points at, or null when its blocks are missing or too short.
export function textAt(blocks: BlockText[], a: Anchor): string | null {
  const eb = a.endBlock ?? a.block, eo = a.endOffset ?? a.offset;
  const inSec = blocks.filter(b => b.section === a.section && b.block >= a.block && b.block <= eb).sort((x, y) => x.block - y.block);
  if (!inSec.length || inSec[0].block !== a.block || inSec[inSec.length - 1].block !== eb) return null;
  if (a.offset > inSec[0].text.length || eo > inSec[inSec.length - 1].text.length) return null;
  if (inSec.length === 1) return inSec[0].text.slice(a.offset, eo);
  return inSec.map((b, k) => k === 0 ? b.text.slice(a.offset) : k === inSec.length - 1 ? b.text.slice(0, eo) : b.text).join("\n");
}
// where an anchor sits in the book, 0..1, by characters (the same measure locate's hint uses)
function fractionOf(blocks: BlockText[], section: number, block: number, offset: number): number {
  let before = 0, total = 0, hit = -1;
  for (const b of blocks) {
    if (hit < 0 && (b.section > section || (b.section === section && b.block >= block))) hit = before + (b.section === section && b.block === block ? Math.min(offset, b.text.length) : 0);
    before += b.text.length; total += b.text.length;
  }
  return (hit < 0 ? total : hit) / (total || 1);
}
const near = (blocks: BlockText[], a: Anchor) => ({ fraction: fractionOf(blocks, a.section, a.block, a.offset) });
// Find an anchor again in a re-parsed text: unchanged when its quote is still where it says; otherwise by quote,
// with the surrounding words to tell repeats apart and the old place as a tie-break. Null: not in this text.
export function relocate(blocks: BlockText[], a: Anchor): Anchor | null {
  if (textAt(blocks, a) === a.exact && (a.exact || (blocks.some(b => b.section === a.section && b.block === a.block)
    && blockAt(blocks, a)!.text.slice(Math.max(0, a.offset - a.prefix.length), a.offset) === a.prefix))) return a;
  const pre = a.prefix.slice(-24), suf = a.suffix.slice(0, 24);
  if (!a.exact) {
    // a point (a bookmark): find the words around it, then the point between them
    const ctx = locate(blocks, pre + suf, near(blocks, a));
    if (!ctx) return null;
    const hint = near(blocks, ctx);
    const after = normQuote(suf).length >= 2 ? locate(blocks, suf, hint) : null;
    const p = after ? { section: after.section, block: after.block, offset: after.offset } : (() => { const b4 = locate(blocks, pre, hint); return b4 ? { section: b4.section, block: b4.endBlock ?? b4.block, offset: b4.endOffset ?? b4.offset } : null; })();
    if (!p) return null;
    const b = blockAt(blocks, p)!;
    return { ...p, endBlock: p.block, endOffset: p.offset, exact: "", prefix: b.text.slice(Math.max(0, p.offset - 32), p.offset), suffix: b.text.slice(p.offset, p.offset + 32) };
  }
  // with context first (a short or repeated quote), then the quote alone near where the context was found
  const ctx = (pre || suf) ? locate(blocks, pre + a.exact + suf, near(blocks, a)) : null;
  return locate(blocks, a.exact, ctx ? near(blocks, ctx) : near(blocks, a));
}
const blockAt = (blocks: BlockText[], p: { section: number; block: number }) => blocks.find(b => b.section === p.section && b.block === p.block);

// Reading a PDF into the same shape as an EPUB: each page keeps its look (drawn by PDF.js when it is on screen),
// and its text sits over it in invisible, selectable blocks. Blocks never cross a page, so a highlight is anchored
// by page and quote like any other, and search, listening, sync and questions work on PDFs unchanged.
import type { BookDoc, Section, TocEntry } from "./types";
import { buildPassages } from "./epub";

export const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
export const PAGES_PER_PART = 20; // a PDF with no outline is read in parts of this many pages

type Pdfjs = typeof import("pdfjs-dist");
interface Item { str: string; x: number; y: number; size: number; w: number; asc: number; rtl?: boolean }
interface Block { page: number; items: Item[]; text: string; x0: number; y0: number; x1: number; y1: number; rtl?: boolean }
export interface PdfPage { w: number; h: number; blocks: Block[] }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (n: number) => +n.toFixed(3);

// Text items in content order become lines, lines become blocks: a new block on a new page, a change of type size,
// a gap wider than a line and a half, or a jump back up the page (the next column).
// Right-to-left lines (Hebrew, Arabic) are put in reading order, right to left, whatever order the file drew them in.
const rtlShare = (xs: Item[]) => { let r = 0, n = 0; for (const i of xs) { n += i.str.length; if (i.rtl) r += i.str.length; } return n ? r / n : 0; };
function inReadingOrder(items: Item[]): Item[] {
  const out: Item[] = []; let line: Item[] = [];
  const flush = () => { if (rtlShare(line) > 0.5) line.sort((a, b) => b.x + b.w - (a.x + a.w)); out.push(...line); line = []; };
  for (const it of items) { if (line.length && Math.abs(it.y - line[line.length - 1].y) > line[line.length - 1].size * 0.5) flush(); line.push(it); }
  flush(); return out;
}
export function blocksOf(raw: Item[], page: number): Block[] {
  const items = raw.some(i => i.rtl) ? inReadingOrder(raw) : raw;
  const out: Block[] = []; let cur: Block | null = null; let prev: Item | null = null;
  for (const it of items) {
    const newLine = !prev || Math.abs(it.y - prev.y) > prev.size * 0.5;
    const brk = !cur || (newLine && prev && (Math.abs(it.size - prev.size) > prev.size * 0.15 || it.y - prev.y > prev.size * 1.75 || it.y < prev.y - prev.size));
    if (brk) { cur = { page, items: [], text: "", x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; out.push(cur); }
    cur!.items.push(it);
    cur!.x0 = Math.min(cur!.x0, it.x); cur!.x1 = Math.max(cur!.x1, it.x + it.w);
    cur!.y0 = Math.min(cur!.y0, it.y - it.size * it.asc); cur!.y1 = Math.max(cur!.y1, it.y + it.size * (1 - it.asc));
    prev = it;
  }
  for (const b of out) { b.text = b.items.map(i => i.str).join(" "); if (rtlShare(b.items) > 0.5) b.rtl = true; }
  return out;
}

// One page as html: the canvas PDF.js draws into, then each block as a box at its place holding its words.
// Positions are percentages of the page and type sizes are in container units, so the page scales as one piece.
export function pageHtml(pg: PdfPage, idx: number, first: number): string {
  const blocks = pg.blocks.length ? pg.blocks : [{ page: idx, items: [], text: "", x0: 0, y0: 0, x1: pg.w, y1: 1 } as Block];
  const inner = blocks.map((b, k) => {
    const bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.y1 - b.y0, 1);
    const spans = b.items.map(i => `<span style="left:${pct((i.x - b.x0) / bw * 100)}%;top:${pct((i.y - i.size * i.asc - b.y0) / bh * 100)}%;font-size:${pct(i.size / pg.w * 100)}cqw" data-w="${pct(i.w / pg.w * 100)}">${esc(i.str)}</span>`).join(" ");
    return `<p class="pl" data-b="${first + k}"${b.rtl ? ' dir="rtl"' : ""} style="left:${pct(b.x0 / pg.w * 100)}%;top:${pct(b.y0 / pg.h * 100)}%;width:${pct(bw / pg.w * 100)}%;height:${pct(bh / pg.h * 100)}%">${spans}</p>`;
  }).join("");
  return `<div class="pdfpage" data-page="${idx}" style="aspect-ratio:${pct(pg.w)}/${pct(pg.h)}"><canvas aria-hidden="true"></canvas>${inner}</div>`;
}

export async function loadPdfjs(): Promise<Pdfjs> {
  const [pdfjs, { default: url }] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  // PDF.js parses in its own worker, started from the books worker; the same file the reader draws pages with.
  // Where a worker cannot start another one, it runs inside this one.
  if (typeof Worker !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = url;
  else { const g = globalThis as { pdfjsWorker?: unknown }; g.pdfjsWorker ??= await import("pdfjs-dist/build/pdf.worker.min.mjs"); }
  return pdfjs;
}

export async function readPages(pdfjs: Pdfjs, bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages: PdfPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: Item[] = [];
    for (const raw of tc.items) {
      if (!("str" in raw)) continue;
      const str = raw.str.replace(/\s+/g, " ").trim(); if (!str) continue;
      const t = pdfjs.Util.transform(vp.transform, raw.transform);
      const size = Math.hypot(t[2], t[3]); if (!size) continue;
      const asc = (tc.styles[raw.fontName] as { ascent?: number } | undefined)?.ascent || 0.8;
      items.push({ str, x: t[4], y: t[5], size, w: raw.width * (vp.width / page.view[2] || 1), asc: Math.min(Math.max(asc, 0.6), 1), ...(raw.dir === "rtl" ? { rtl: true } : {}) });
    }
    pages.push({ w: vp.width, h: vp.height, blocks: blocksOf(items, i - 1) });
    page.cleanup();
  }
  return { doc, pages, task };
}

async function outline(doc: import("pdfjs-dist").PDFDocumentProxy) {
  const out: { title: string; page: number; top: number | null; depth: number }[] = [];
  const walk = async (items: Awaited<ReturnType<typeof doc.getOutline>> | null, depth: number) => {
    for (const o of items || []) {
      try {
        const dest = typeof o.dest === "string" ? await doc.getDestination(o.dest) : o.dest;
        if (Array.isArray(dest) && dest[0]) {
          const page = typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0]);
          const top = (dest[1] as { name?: string })?.name === "XYZ" && typeof dest[3] === "number" ? dest[3] : null;
          if (o.title.trim()) out.push({ title: o.title.replace(/\s+/g, " ").trim(), page, top, depth });
        }
      } catch { /* a broken entry is left out */ }
      if (depth < 2) await walk(o.items, depth + 1);
    }
  };
  await walk(await doc.getOutline().catch(() => null), 0);
  return out;
}

async function cover(doc: import("pdfjs-dist").PDFDocumentProxy): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  try {
    const page = await doc.getPage(1); const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 400 / vp1.width });
    const c = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
    return new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.82 })).arrayBuffer());
  } catch { return null; }
}

// Without an outline, contents come from the headings: short lines in type clearly larger than the body text
export function headings(pages: PdfPage[], sectionOf: Map<number, number>, firstBlock: Map<number, number>): TocEntry[] | null {
  const body = pages.flatMap(p => p.blocks.filter(b => b.text.length > 200).map(b => b.items[0].size)).sort((a, b) => a - b);
  const mid = body[body.length >> 1]; if (!mid) return null;
  const out: TocEntry[] = [];
  pages.forEach((p, i) => p.blocks.forEach((b, k) => {
    if (b.text.length >= 3 && b.text.length <= 100 && b.items[0].size > mid * 1.5 && /\p{L}/u.test(b.text)) out.push({ title: b.text, section: sectionOf.get(i) ?? 0, block: (firstBlock.get(i) ?? 0) + k, depth: 0 });
  }));
  return out.length >= 2 && out.length <= pages.length * 2 ? out : null;
}

export async function parsePdf(bytes: Uint8Array, hash: string, addedAt: number, name = "", pdfjs?: Pdfjs): Promise<{ doc: BookDoc; images: Record<string, Uint8Array> }> {
  const lib = pdfjs ?? await loadPdfjs();
  let r;
  try { r = await readPages(lib, bytes); }
  catch (e) { throw new Error((e as Error).name === "PasswordException" ? "this PDF is locked with a password" : "this PDF could not be read"); }
  const { doc, pages, task } = r;
  const info = ((await doc.getMetadata().catch(() => null))?.info || {}) as { Title?: string; Author?: string; Language?: string };
  const marks = await outline(doc);
  const top = marks.filter(m => m.depth === 0);
  // parts: one per top-level outline entry (and the pages before the first), or fixed runs of pages
  const starts = top.length ? [...new Set([0, ...top.map(m => m.page)])].sort((a, b) => a - b) : Array.from({ length: Math.ceil(pages.length / PAGES_PER_PART) }, (_, i) => i * PAGES_PER_PART);
  const sections: Section[] = []; const firstBlock = new Map<number, number>(); const sectionOf = new Map<number, number>();
  starts.forEach((p0, si) => {
    const p1 = (starts[si + 1] ?? pages.length) - 1; let b = 0; const html: string[] = []; const blocks: string[] = [];
    for (let p = p0; p <= p1; p++) {
      firstBlock.set(p, b); sectionOf.set(p, si);
      html.push(pageHtml(pages[p], p, b));
      const pb = pages[p].blocks.length ? pages[p].blocks.map(x => x.text) : [""];
      blocks.push(...pb); b += pb.length;
    }
    const named = top.find(m => m.page === p0);
    const title = named?.title ?? (top.length ? (p0 === 0 ? "Start" : `Page ${p0 + 1}`) : p0 === p1 ? `Page ${p0 + 1}` : `Pages ${p0 + 1} to ${p1 + 1}`);
    sections.push({ idx: si, href: `page-${p0 + 1}`, title, kind: "body", linear: true, html: html.join(""), blocks });
  });
  const blockAt = (page: number, topY: number | null) => {
    const f = firstBlock.get(page) ?? 0; if (topY == null) return f;
    const pg = pages[page]; const y = pg.h - topY; // outline tops count up from the bottom of the page
    const k = pg.blocks.findIndex(b => b.y1 >= y - 2); return f + Math.max(0, k);
  };
  const toc: TocEntry[] = top.length ? marks.map(m => ({ title: m.title, section: sectionOf.get(m.page) ?? 0, block: blockAt(m.page, m.top), depth: m.depth })) : headings(pages, sectionOf, firstBlock) ?? sections.map(s => ({ title: s.title, section: s.idx, block: 0, depth: 0 }));
  const allBlocks = pages.flatMap(p => p.blocks), rtlText = allBlocks.filter(b => b.rtl).reduce((n, b) => n + b.text.length, 0), anyText = allBlocks.reduce((n, b) => n + b.text.length, 0);
  const words = pages.reduce((n, p) => n + p.blocks.reduce((m, b) => m + b.text.split(" ").length, 0), 0);
  const images: Record<string, Uint8Array> = {};
  const c = await cover(doc); if (c) images["cover.jpg"] = c;
  await task.destroy();
  const title = (info.Title || "").trim() || name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled PDF";
  return {
    images,
    doc: {
      v: 0,
      meta: { id: hash.slice(0, 16), sha256: hash, title, author: (info.Author || "").trim(), language: (info.Language || "en").trim() || "en", dir: anyText && rtlText / anyText > 0.5 ? "rtl" : "ltr", vertical: false, cover: c ? "cover.jpg" : null, size: bytes.length, addedAt, start: 0, format: "pdf" },
      sections, toc, notes: {}, passages: buildPassages(sections, toc),
      images: c ? { "cover.jpg": "image/jpeg" } : {},
      stats: { sections: sections.length, blocks: sections.reduce((n, s) => n + s.blocks.length, 0), words, noterefs: 0, resolved: 0, unresolved: [], notes: 0, math: 0, images: 0, links: 0 },
    },
  };
}

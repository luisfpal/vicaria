// Talking to devices still on 0.x. They send and expect one snapshot: { v: 1, dev, sent, data: { library, books:
// { key: ops }, reader: ops, cards: { key: { "3.json": text } }, have: [{ id, title }] } }, gzip-compressed, over
// the same WebRTC room and the same relay events as before (standalone/web/sync.js, book_reader/sync.py).
// What 0.x can use goes out unchanged, byte for byte: ops in its own kinds and format (positions and highlights it
// wrote, reader settings, shelf changes for books it knows by its own key) and cards. 1.0 marks and positions name
// places in the 1.0 text, which 0.x cannot read; they stay out (see DESIGN_1.0.md, sync).
import type { Op } from "../core/types";
import { LEGACY_KINDS } from "../core/types";
import { clean, newer } from "../core/ops";

export interface LegacySnapshot { v: 1; dev: string; sent: number; data: { library: string; books: Record<string, unknown[]>; reader: unknown[]; cards: Record<string, Record<string, string>>; have: { id: string; title: string }[]; backgrounds?: unknown } }

// 0.x book key for a 1.0 book id: the newest alias naming it, else none
export function oldKeys(ops: Op[]): Map<string, string> {
  const best = new Map<string, Op>();
  for (const o of ops) if (o.k === "alias" && typeof o.v.old === "string" && typeof o.v.book === "string") { const c = best.get(o.v.book); if (!c || newer(o, c)) best.set(o.v.book, o); }
  return new Map([...best].map(([b, o]) => [b, o.v.old as string]));
}
// is this op in the 0.x format (written by 0.x, or by 1.0 in a kind and shape 0.x reads the same)?
const zeroFormat = (o: Op) => LEGACY_KINDS.has(o.k) && o.c === undefined && (o.k === "reader" || o.k === "shelf" || o.k === "listen" || (o.b !== undefined && o.v.anchor === undefined && typeof o.v.section !== "number"));

export function toLegacy(ops: Op[], lib: string, dev: string, books: { id: string; title: string }[], now = Date.now()): LegacySnapshot {
  const keys = oldKeys(ops), known = new Set(keys.values());
  const out: LegacySnapshot["data"] = { library: lib, books: {}, reader: [], cards: {}, have: books.map(b => ({ id: keys.get(b.id) ?? b.id, title: b.title })) };
  for (const b of books) out.books[keys.get(b.id) ?? b.id] ??= [];
  for (const o of ops) {
    if (o.k === "card" && typeof o.v.name === "string" && typeof o.v.text === "string" && o.b) { (out.cards[o.b] ||= {})[o.v.name] = o.v.text; continue; }
    if (!zeroFormat(o)) continue;
    const c = clean(o)!;
    if (o.k === "shelf") {
      // 0.x names a book by its own key; 1.0 writes that key too for books that came from 0.x (shelf.ts)
      if (typeof o.v.book === "string" && known.has(o.v.book)) out.reader.push(c);
      continue;
    }
    if (o.k === "reader" || (o.k === "listen" && o.b === undefined)) { out.reader.push(c); continue; }
    const { b: _b, ...rest } = c as Op & { b?: string }; void _b;
    (out.books[o.b!] ||= []).push(rest);
  }
  return { v: 1, dev, sent: now, data: out };
}

// The ops a 0.x snapshot carries, in the 1.0 shape (book key in "b"), plus its cards and its books.
export async function fromLegacy(snap: unknown, lib: string, cardOp: (key: string, name: string, text: string) => Promise<Op>): Promise<{ ops: Op[]; have: { id: string; title: string }[] } | null> {
  const s = snap as LegacySnapshot;
  if (!s || s.v !== 1 || !s.data || s.data.library !== lib) return null;
  const ops: Op[] = [];
  for (const [key, xs] of Object.entries(s.data.books || {})) if (Array.isArray(xs)) for (const o of xs) { const c = clean({ ...(o as object), b: key }); if (c) ops.push(c); }
  for (const o of Array.isArray(s.data.reader) ? s.data.reader : []) { const c = clean(o); if (c) ops.push(c); }
  for (const [key, cs] of Object.entries(s.data.cards || {})) for (const [name, text] of Object.entries(cs || {})) if (/^\d+\.json$/.test(name) && typeof text === "string") ops.push(await cardOp(key, name, text));
  const have = Array.isArray(s.data.have) ? s.data.have.filter(h => h && typeof h.id === "string").map(h => ({ id: String(h.id), title: String(h.title || h.id) })) : [];
  return { ops, have };
}

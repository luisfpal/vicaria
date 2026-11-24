// Marks: everything a reader leaves in a book (highlight, note, sticky note, bookmark, loved place, AI answer, card)
// is one anchored record with optional facets. Stored as "mark" ops that set fields; read by folding the log.
// Merge rules (DESIGN_1.0.md, sections 1 and 7):
//  - each field is a last-writer-wins register ordered by (t, c, op id);
//  - the note is a multi-value register: an edit names the note op it replaced ("base"); edits nobody replaced are
//    "heads"; the newest head shows, the others are kept as conflict copies until resolved;
//  - tags are an add/remove set: a removal names the add ops it saw, so a concurrent add survives;
//  - delete is the field "gone"; edits never bring a mark back, only setting gone to false does.
// 0.x and early 1.0 highlight ops ("hl", "hl-") and 0.x cards are read as marks too; they are never rewritten.
import type { Anchor, Op } from "./types";
import { newer, resolver as makeResolver, type Resolver } from "./ops";

export const COLORS = ["yellow", "green", "blue", "pink", "purple", "orange"] as const;
export type Color = typeof COLORS[number];
export const STYLES = ["fill", "underline", "strike"] as const;
export type Style = typeof STYLES[number];
export const NOTE_MAX = 64 * 1024; // bytes of UTF-8
export const NAME_MAX = 200;
export const TAG_MAX = 64;

export interface Ask { q: string; a: string; model: string; cites: Anchor[] }
export interface MarkFields {
  at: Anchor; color: Color; style: Style; sticky: { side: "l" | "r"; tint: Color }; bookmark: { name: string };
  loved: boolean; ask: Ask; card: { chapter: number; text: string }; gone: boolean; made: number;
}
export type MarkSet = Partial<MarkFields>;
export interface NoteVersion { op: string; text: string; dev: string; t: number }
export interface Mark {
  id: string; book: string;
  at?: Anchor;                 // missing: not placed in the text yet (see Unplaced)
  color?: Color; style?: Style; note?: string; conflicts: NoteVersion[]; noteOp?: string;
  sticky?: MarkFields["sticky"]; bookmark?: MarkFields["bookmark"]; loved?: boolean; ask?: Ask; card?: MarkFields["card"];
  tags: string[]; tagOps: Record<string, string[]>; made: number; edited: number; gone: boolean; legacy?: boolean;
  lost?: Anchor;               // where it was before the book was read again; its words are not in the new text
}
export type MarkKind = "highlight" | "note" | "sticky" | "bookmark" | "ask" | "card";
export function kindOf(m: Mark): MarkKind {
  if (m.card) return "card"; if (m.ask) return "ask"; if (m.bookmark) return "bookmark"; if (m.sticky) return "sticky";
  if (m.color) return "highlight"; return "note";
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;
const isStr = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;
const isInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 1e7;
export function validAnchor(a: unknown): a is Anchor {
  const x = a as Anchor;
  return !!x && isInt(x.section) && isInt(x.block) && isInt(x.offset) && (x.endBlock === undefined || isInt(x.endBlock)) && (x.endOffset === undefined || isInt(x.endOffset)) &&
    isStr(x.exact, 8000) && isStr(x.prefix, 200) && isStr(x.suffix, 200) &&
    ((x.endBlock ?? x.block) > x.block || ((x.endBlock ?? x.block) === x.block && (x.endOffset ?? x.offset) >= x.offset));
}
export const isPoint = (a: Anchor) => (a.endBlock ?? a.block) === a.block && (a.endOffset ?? a.offset) === a.offset;
const FIELD_OK: { [K in keyof MarkFields]: (v: unknown) => boolean } = {
  at: validAnchor,
  color: v => (COLORS as readonly unknown[]).includes(v),
  style: v => (STYLES as readonly unknown[]).includes(v),
  sticky: v => !!v && typeof v === "object" && ["l", "r"].includes((v as { side: string }).side) && (COLORS as readonly unknown[]).includes((v as { tint: string }).tint),
  bookmark: v => !!v && typeof v === "object" && isStr((v as { name: unknown }).name, NAME_MAX),
  loved: v => typeof v === "boolean",
  ask: v => { const x = v as Ask; return !!x && isStr(x.q, 4000) && isStr(x.a, 40000) && isStr(x.model, 100) && Array.isArray(x.cites) && x.cites.length <= 50 && x.cites.every(validAnchor); },
  card: v => { const x = v as { chapter: unknown; text: unknown }; return !!x && isInt(x.chapter) && isStr(x.text, 40000); },
  gone: v => typeof v === "boolean",
  made: v => typeof v === "number" && Number.isFinite(v),
};
// null fields clear a facet (except at, gone and made)
// strict (writing here): only known fields. Not strict (reading ops from any device): a field this build does not
// know is a newer build's and is skipped, not a reason to drop the whole op (docs/MIGRATIONS.md).
export function validSet(set: unknown, strict = true): set is Record<string, unknown> {
  if (!set || typeof set !== "object" || Array.isArray(set)) return false;
  for (const [k, v] of Object.entries(set)) {
    const ok = FIELD_OK[k as keyof MarkFields]; if (!ok) { if (strict) return false; continue; }
    if (v === null) { if (k === "at" || k === "gone" || k === "made") return false; continue; }
    if (!ok(v)) return false;
  }
  return true;
}
export const validNote = (s: unknown): s is string => typeof s === "string" && utf8(s) <= NOTE_MAX;

// What a mark op may carry. Anything else in an op is ignored when folding (and refused when writing).
// p: the parser version the anchor in set.at was made with (missing: 2, the version before it was recorded)
export interface MarkOpV { id: string; book: string; set?: MarkSet | Record<string, unknown>; note?: string; base?: string | null; resolves?: string[]; tag?: string; untag?: string[]; p?: number }
export function validMarkV(v: unknown, strict = true): v is MarkOpV {
  const x = v as MarkOpV;
  if (!x || !isStr(x.id, 200) || !isStr(x.book, 200)) return false;
  if (x.set !== undefined && !validSet(x.set, strict)) return false;
  if (x.note !== undefined && !validNote(x.note)) return false;
  if (x.base !== undefined && x.base !== null && !isStr(x.base, 200)) return false;
  if (x.resolves !== undefined && !(Array.isArray(x.resolves) && x.resolves.length <= 100 && x.resolves.every(r => isStr(r, 200)))) return false;
  if (x.tag !== undefined && !(isStr(x.tag, TAG_MAX) && x.tag.trim().length > 0)) return false;
  if (x.p !== undefined && !(isInt(x.p) && x.p > 0)) return false;
  if (x.untag !== undefined && !(Array.isArray(x.untag) && x.untag.length <= 1000 && x.untag.every(r => isStr(r, 200)))) return false;
  return x.set !== undefined || x.note !== undefined || x.tag !== undefined || x.untag !== undefined;
}
// Invariants of a whole mark, checked when writing (DESIGN_1.0.md 7.8): a bookmark is a point with no color or style;
// a sticky note needs a note; a card anchors at a chapter start and has no sticky.
export function invariantProblem(m: Pick<Mark, "at" | "color" | "style" | "bookmark" | "sticky" | "note" | "card">): string | null {
  if (m.bookmark && m.at && !isPoint(m.at)) return "a bookmark marks a point, not a passage";
  if (m.bookmark && (m.color || m.style)) return "a bookmark has no highlight color";
  if (m.sticky && !m.note) return "a sticky note needs text";
  if (m.card && m.sticky) return "a chapter card is not a sticky note";
  return null;
}

interface Acc {
  id: string; book: string; fields: Map<string, { op: Op; v: unknown }>;
  notes: { op: Op; text: string; base: string | null | "*"; resolves: string[] }[] | null; // null: none yet (most marks never get one)
  adds: Map<string, string> | null; removed: Set<string> | null; made: number; edited: Op; legacy: boolean;
}

// Fold ops into marks. `book` limits the result to one book; anchors re-found for 0.x ops come from the resolver.
export function foldMarks(ops: Op[], book?: string, r: Resolver = makeResolver(ops)): Mark[] {
  const acc = new Map<string, Acc>();
  const get = (id: string, bk: string, o: Op) => {
    let a = acc.get(id);
    if (!a) acc.set(id, a = { id, book: bk, fields: new Map(), notes: null, adds: null, removed: null, made: o.t, edited: o, legacy: false });
    if (newer(o, a.edited)) a.edited = o;
    if (o.t < a.made) a.made = o.t;
    return a;
  };
  const setField = (a: Acc, k: string, v: unknown, o: Op) => { const c = a.fields.get(k); if (!c || newer(o, c.op)) a.fields.set(k, { op: o, v }); };
  const seen = new Set<string>();
  for (const o of ops) {
    if (seen.has(o.id)) continue; // an op delivered twice counts once
    seen.add(o.id);
    const bk = r.bookOf(o); if (!bk || (book !== undefined && bk !== book)) continue;
    if (o.k === "mark") {
      if (!validMarkV(o.v, false)) continue;
      const v = o.v as MarkOpV, a = get(v.id, bk, o);
      if (v.set) for (const k in v.set) {
        if (!(k in FIELD_OK)) continue; // a newer build's field: it stays in the op, not in this build's mark
        let val = (v.set as Record<string, unknown>)[k];
        if (k === "at") { const m = r.moved(o); if (m !== undefined) val = m ?? { lost: val }; }
        setField(a, k, val, o);
      }
      if (v.note !== undefined) (a.notes ??= []).push({ op: o, text: v.note, base: v.base ?? null, resolves: v.resolves || [] });
      else if (v.resolves?.length) (a.notes ??= []).push({ op: o, text: "", base: "resolve-only", resolves: v.resolves });
      if (v.tag !== undefined) (a.adds ??= new Map()).set(o.id, v.tag.trim());
      if (v.untag) for (const u of v.untag) (a.removed ??= new Set()).add(u);
    } else if (o.k === "hl" || o.k === "hl-") {
      // a whole-record highlight from 0.x or early 1.0: sets everything it carries at its time
      if (typeof o.v.id !== "string") continue;
      const a = get(o.v.id, bk, o); a.legacy = a.legacy || !o.v.anchor;
      if (o.k === "hl-") { setField(a, "gone", true, o); continue; }
      setField(a, "gone", false, o);
      const at = r.anchorOf(o); if (at && validAnchor(at)) setField(a, "at", at, o);
      else if (o.v.anchor && r.moved(o) === null) setField(a, "at", { lost: o.v.anchor }, o);
      setField(a, "color", (COLORS as readonly string[]).includes(String(o.v.color)) ? o.v.color : "yellow", o);
      if (typeof o.v.note === "string") (a.notes ??= []).push({ op: o, text: o.v.note.slice(0, NOTE_MAX), base: "*", resolves: [] });
      if (typeof o.v.created === "number") a.made = Math.min(a.made, o.v.created);
    } else if (o.k === "card" && typeof o.v.name === "string" && typeof o.v.text === "string") {
      const a = get(o.id, bk, o); a.legacy = true;
      const ch = parseInt(o.v.name, 10);
      setField(a, "card", { chapter: Number.isFinite(ch) ? ch : 0, text: o.v.text.slice(0, 40000) }, o);
    }
  }
  const out: Mark[] = [];
  for (const a of acc.values()) {
    const f = (k: string) => { const x = a.fields.get(k); return x && x.v !== null ? x.v : undefined; };
    // note heads: versions no later version replaced or resolved; "*" (a whole-record write) replaces all older ones
    let heads: NonNullable<Acc["notes"]> = [];
    if (a.notes) {
      const replaced = new Set<string>();
      for (const n of a.notes) { if (n.base && n.base !== "*" && n.base !== "resolve-only") replaced.add(n.base); for (const x of n.resolves) replaced.add(x); }
      const real = a.notes.filter(n => n.base !== "resolve-only");
      const lastStar = real.filter(n => n.base === "*").reduce<NonNullable<Acc["notes"]>[number] | null>((m, n) => !m || newer(n.op, m.op) ? n : m, null);
      heads = real.filter(n => !replaced.has(n.op.id) && !(lastStar && n !== lastStar && newer(lastStar.op, n.op))).sort((x, y) => newer(x.op, y.op) ? -1 : 1);
    }
    const win = heads[0];
    let tags: string[] = [];
    const tagOps: Record<string, string[]> = {};
    if (a.adds) {
      const live = new Map<string, string[]>();
      for (const [id, t] of a.adds) if (!a.removed?.has(id)) { const l = live.get(t); if (l) l.push(id); else live.set(t, [id]); }
      tags = [...live.keys()].sort();
      for (const t of tags) tagOps[t] = live.get(t)!.sort();
    }
    const m: Mark = {
      id: a.id, book: a.book, conflicts: heads.length < 2 ? [] : heads.slice(1).filter(n => n.text !== win?.text).map(n => ({ op: n.op.id, text: n.text, dev: n.op.dev, t: n.op.t })),
      tags, tagOps, made: typeof f("made") === "number" ? f("made") as number : a.made, edited: a.edited.t, gone: f("gone") === true,
    };
    const at = f("at") as Anchor | { lost: Anchor } | undefined;
    if (at && "lost" in at) m.lost = at.lost; else if (at) m.at = at;
    if (win && win.text) { m.note = win.text; m.noteOp = win.op.id; } else if (win) m.noteOp = win.op.id;
    for (const k of ["color", "style", "sticky", "bookmark", "ask", "card"] as const) { const v = f(k); if (v !== undefined) (m as unknown as Record<string, unknown>)[k] = v; }
    if (f("loved") === true) m.loved = true;
    if (a.legacy) m.legacy = true;
    if (!m.at && !m.card && !m.legacy && !m.lost) continue; // a mark op with no place yet and nothing to wait for
    out.push(m);
  }
  return out.sort(byPlace);
}
export function byPlace(a: Mark, b: Mark) {
  const x = a.at, y = b.at;
  if (x && y) return x.section - y.section || x.block - y.block || x.offset - y.offset || a.made - b.made || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return x ? -1 : y ? 1 : a.id < b.id ? -1 : 1;
}
export const visible = (ms: Mark[]) => ms.filter(m => !m.gone);

// The append-only operation log: positions, highlights, reader settings, shelf state. A grow-only set merged by id,
// read last-writer-wins by (t, id). Union is commutative, associative and idempotent, so devices can merge in any
// order any number of times and agree. Same op shape as the 0.x log, so 0.x devices keep syncing.
import { PARSER_VERSION, LEGACY_KINDS, type Anchor, type Op, type OpKind } from "./types";
import { get, put, getAll, getAllKeys, tx, db, readTogether } from "./idb";

let devId: string | null = null;
let counter = 0;
export async function device(): Promise<string> {
  if (devId) return devId;
  let d = await get<string>("kv", "device");
  if (!d) { d = "d" + crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(36), "").slice(0, 12); await put("kv", d, "device"); }
  counter = (await get<number>("kv", "counter")) || 0;
  const h = await get<{ p: number; l: number }>("kv", "hlc"); if (h) clock = h;
  return devId = d;
}

// ---- hybrid logical clock ----
// Physical time in ms plus a logical counter. Sending: take the wall clock if it moved past the clock, else count up.
// Receiving: never fall behind a time seen from another device (clamped to 5 minutes ahead of this device's wall
// clock, so a device with a wrong clock cannot win every race forever).
export const SKEW_MAX = 5 * 60_000;
let clock = { p: 0, l: 0 };
export function hlcSend(wall = Date.now()): { p: number; l: number } {
  if (wall > clock.p) clock = { p: wall, l: 0 }; else clock = { p: clock.p, l: clock.l + 1 };
  return { ...clock };
}
export function hlcReceive(t: number, c = 0, wall = Date.now()) {
  const tt = Math.min(t, wall + SKEW_MAX);
  const p = Math.max(clock.p, tt, wall);
  const l = p === clock.p && p === tt ? Math.max(clock.l, c) + 1 : p === clock.p ? clock.l + 1 : p === tt ? c + 1 : 0;
  clock = { p, l };
}
export const hlcState = () => ({ ...clock });
export function hlcReset(c = { p: 0, l: 0 }) { clock = { ...c }; }

const bkOf = (o: Op) => typeof o.v.book === "string" ? o.v.book : o.b;
const stored = (o: Op) => { const bk = bkOf(o); return bk === undefined ? o : { ...o, bk }; };

// v may be a function of the new op's id, so a record can be named after the op that creates it. The counter is
// read and written in the same transaction as the op, so two writers (a tab and the books worker, or two tabs)
// never hand out the same id.
export async function addOp(k: OpKind, v: Record<string, unknown> | ((id: string) => Record<string, unknown>)): Promise<Op> {
  const dev = await device();
  let op: Op | null = null, err: unknown = null;
  try {
    await tx(["ops", "kv"], x => {
      const kv = x.objectStore("kv"), r = kv.get("counter");
      r.onsuccess = () => {
        try {
          const n = Math.max(Number(r.result) || 0, counter) + 1; counter = n;
          const id = `${dev}.${n}`, h = hlcSend(), val = typeof v === "function" ? v(id) : v;
          // 0.x keeps only id, dev, t, k, v: for its kinds the logical part is folded into the time instead
          const raw = LEGACY_KINDS.has(k) ? { id, dev, t: h.p + h.l, k, v: val } : { id, dev, t: h.p, c: h.l, k, v: val };
          // stored exactly as it travels (clean drops a zero logical part), so every device holds the same bytes
          op = clean(raw);
          if (!op) throw new Error("That change is too large to save.");
          if (LEGACY_KINDS.has(k) && h.l) hlcReceive(op.t, 0, op.t);
          x.objectStore("ops").put(stored(op)); kv.put(n, "counter"); kv.put(hlcState(), "hlc");
        } catch (e) { err = e; x.abort(); }
      };
    });
  } catch (e) { throw err ?? e; }
  if (err) throw err;
  const o = op!;
  listeners.forEach(f => f(o)); tell([o]);
  return o;
}
const listeners = new Set<(op: Op) => void>();
export const onOp = (f: (op: Op) => void) => { listeners.add(f); return () => listeners.delete(f); };
// ops written in another context of this device (the books worker, another tab) reach listeners here too, so the
// open book redraws and sync passes them on
const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("vicaria-ops") : null;
(bc as unknown as { unref?: () => void } | null)?.unref?.();
if (bc) bc.onmessage = e => { if (Array.isArray(e.data)) for (const o of e.data as Op[]) listeners.forEach(f => f(o)); };
// Anchors found again for a book (a 0.x quote placed, a mark moved after a re-read) are not ops, so an open book
// would not redraw when they land; this tells it, in every context of this device.
const anchorListeners = new Set<(book: string) => void>();
export const onAnchors = (f: (book: string) => void) => { anchorListeners.add(f); return () => anchorListeners.delete(f); };
const abc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("vicaria-anchors") : null;
(abc as unknown as { unref?: () => void } | null)?.unref?.();
if (abc) abc.onmessage = e => { if (typeof e.data === "string") anchorListeners.forEach(f => f(e.data)); };
export const anchorsChanged = (book: string) => { anchorListeners.forEach(f => f(book)); try { abc?.postMessage(book); } catch { /* closed */ } };
const tell = (ops: Op[]) => { if (ops.length) try { bc?.postMessage(ops); } catch { /* closed */ } };

// An op stamped more than SKEW_MAX ahead of this device's clock waits in "held" until its time comes, instead of
// being stored with a changed time: every device keeps the op exactly as it was written (byte-identical logs), and
// a device with a wrong clock still cannot win every race.
export async function mergeOps(incoming: Op[], now = Date.now()): Promise<Op[]> {
  const held = (await get<Op[]>("kv", "held")) || [];
  const cleaned = [...held, ...incoming].map(o => clean(o)).filter((o): o is Op => !!o);
  const have = await known(cleaned.map(o => o.id));
  const fresh: Op[] = [], wait = new Map<string, Op>();
  for (const o of cleaned) {
    if (have.has(o.id)) continue;
    if (o.t > now + SKEW_MAX) { wait.set(o.id, o); continue; }
    have.add(o.id); fresh.push(o);
  }
  for (const o of fresh) hlcReceive(o.t, o.c, now);
  const keep = [...wait.values()].slice(-HELD_MAX);
  if (fresh.length || keep.length !== held.length) await tx(["ops", "kv"], x => {
    for (const o of fresh) x.objectStore("ops").put(stored(o));
    x.objectStore("kv").put(hlcState(), "hlc");
    if (keep.length) x.objectStore("kv").put(keep, "held"); else x.objectStore("kv").delete("held");
  });
  fresh.forEach(o => listeners.forEach(f => f(o))); tell(fresh);
  return fresh;
}
export const HELD_MAX = 10_000;
export const heldOps = async () => (await get<Op[]>("kv", "held")) || [];

// Any well-formed kind is accepted, stored and forwarded: a newer build may add kinds this one does not know, and
// they must survive here unchanged (docs/MIGRATIONS.md). Folds ignore kinds they do not know.
const KIND = /^[a-z][a-z0-9-]{0,23}$/;
export const MAX_OP_BYTES = 80 * 1024; // a 64 KiB note plus its envelope
const DEV = /^[a-z0-9-]{4,40}$/;
export function validOp(o: unknown): o is Op {
  const x = o as Op;
  return !!x && typeof x.id === "string" && typeof x.dev === "string" && x.id.startsWith(x.dev + ".") && DEV.test(x.dev) && x.id.length < 200 &&
    typeof x.t === "number" && Number.isFinite(x.t) && typeof x.k === "string" && KIND.test(x.k) && !!x.v && typeof x.v === "object" && !Array.isArray(x.v) && (x.b === undefined || (typeof x.b === "string" && x.b.length < 200));
}
// Only the fields of an op travel and are stored, so every device keeps byte-identical copies. Times are never
// changed here; ops from a clock far ahead wait in mergeOps.
export function clean(o: unknown): Op | null {
  if (!validOp(o)) return null;
  const out: Op = { id: o.id, dev: o.dev, t: Math.trunc(o.t), k: o.k, v: o.v };
  if (!LEGACY_KINDS.has(o.k) && Number.isInteger(o.c) && o.c! > 0 && o.c! < 1e9) out.c = o.c;
  if (o.b !== undefined && o.v.book === undefined) out.b = o.b;
  if (JSON.stringify(out).length > MAX_OP_BYTES) return null;
  return out;
}

// total order of ops: hybrid clock (t, c), then op id
export const newer = (a: Op, b: Op) => a.t > b.t || (a.t === b.t && ((a.c || 0) > (b.c || 0) || ((a.c || 0) === (b.c || 0) && a.id > b.id)));

// ---- reading the log (pure, unit tested) ----
// A 0.x op names its book by a 0.x key; "alias" ops say which book that key means. Old highlights and positions
// carry 0.x chapter and block numbers, so where they sit in the new text comes from the anchors map (re-found by quote).
// moved(o): for an op whose anchor was made by another parser version, where it sits now (null: not found), or
// undefined when it was never re-checked
export interface Resolver { bookOf(o: Op): string | undefined; anchorOf(o: Op): Anchor | undefined; keysOf(book: string): Set<string>; moved(o: Op): Anchor | null | undefined }
export function resolver(ops: Op[], anchors: Map<string, Anchor | null> = new Map()): Resolver {
  const alias = new Map<string, Op>();
  for (const o of ops) if (o.k === "alias" && typeof o.v.old === "string" && typeof o.v.book === "string") { const c = alias.get(o.v.old); if (!c || newer(o, c)) alias.set(o.v.old, o); }
  const map = (k: string) => (alias.get(k)?.v.book as string | undefined) ?? k;
  const bookOf = (o: Op) => typeof o.v.book === "string" ? map(o.v.book) : o.b !== undefined ? map(o.b) : undefined;
  const keysOf = (book: string) => { const s = new Set([book]); for (const [k, o] of alias) if (o.v.book === book) s.add(k); return s; };
  const moved = (o: Op) => anchors.get(o.id);
  const anchorOf = (o: Op) => anchors.has(o.id) ? anchors.get(o.id) ?? undefined : (o.v.anchor as Anchor | undefined);
  return { bookOf, anchorOf, keysOf, moved };
}

export interface Highlight { id: string; book: string; anchor: Anchor; color: string; note: string; created: number; t: number; legacy?: boolean }
export function highlights(ops: Op[], book: string, r: Resolver = resolver(ops)): Highlight[] {
  const cur = new Map<string, Op>();
  for (const o of ops) {
    if ((o.k !== "hl" && o.k !== "hl-") || r.bookOf(o) !== book) continue;
    const id = String(o.v.id);
    const c = cur.get(id);
    if (!c || newer(o, c)) cur.set(id, o);
  }
  const out: Highlight[] = [];
  for (const o of cur.values()) {
    if (o.k !== "hl") continue;
    const anchor = r.anchorOf(o); if (!anchor) continue;
    out.push({ id: String(o.v.id), book, anchor, color: String(o.v.color || "yellow"), note: String(o.v.note || ""), created: Number(o.v.created || o.t), t: o.t, ...(o.v.anchor ? {} : { legacy: true }) });
  }
  return out.sort((a, b) => a.anchor.section - b.anchor.section || a.anchor.block - b.anchor.block || a.anchor.offset - b.anchor.offset || a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
// 0.x highlights still waiting for a place in the text (their book has not arrived, or the quote was not found)
export function unplacedHighlights(ops: Op[], book: string, r: Resolver = resolver(ops)): Op[] {
  const cur = new Map<string, Op>();
  for (const o of ops) if ((o.k === "hl" || o.k === "hl-") && r.bookOf(o) === book) { const c = cur.get(String(o.v.id)); if (!c || newer(o, c)) cur.set(String(o.v.id), o); }
  return [...cur.values()].filter(o => o.k === "hl" && !r.anchorOf(o));
}
export function latest(ops: Op[], k: OpKind, pred: (o: Op) => boolean = () => true): Op | null {
  let best: Op | null = null;
  for (const o of ops) if (o.k === k && pred(o) && (!best || newer(o, best))) best = o;
  return best;
}
export function position(ops: Op[], book: string, r: Resolver = resolver(ops)): { section: number; block: number } | undefined {
  const o = latest(ops, "pos", x => r.bookOf(x) === book && (typeof x.v.section === "number" || !!r.anchorOf(x)));
  if (!o) return undefined;
  if (typeof o.v.section === "number") return { section: o.v.section, block: Number(o.v.block || 0) };
  const a = r.anchorOf(o)!; return { section: a.section, block: a.block };
}
// The ids among `ids` already stored, loose or packed. Few ids: looked up one by one; many: all keys at once.
async function known(ids: string[]): Promise<Set<string>> {
  if (ids.length > 2000) return new Set([...(await getAllKeys("ops")), ...(await getAllKeys("opids"))] as string[]);
  const t = (await db()).transaction(["ops", "opids"]);
  const hit = await Promise.all(ids.map(id => Promise.all([t.objectStore("ops").count(id), t.objectStore("opids").count(id)].map(r => new Promise<number>(ok => { r.onsuccess = () => ok(r.result); r.onerror = () => ok(0); })))));
  return new Set(ids.filter((_, i) => hit[i][0] + hit[i][1] > 0));
}
// The newest op of a kind filed under no book (settings like the reading background). Those are never packed, so
// this reads only the small set of loose ops.
export async function latestUnfiled(k: OpKind): Promise<Op | undefined> {
  let best: Op | undefined;
  for (const o of await getAll<Op & { bk?: string }>("ops")) if (o.k === k && o.bk === undefined && (!best || newer(o, best))) best = strip(o);
  return best;
}
interface Seg { id: string; bk: string; ops: Op[] }
export async function allOps(): Promise<Op[]> {
  const [loose, segs] = await readTogether<[(Op & { bk?: string })[], Seg[]]>(["ops", "segs"], t => [t.objectStore("ops").getAll(), t.objectStore("segs").getAll()]);
  return segs.flatMap(s => s.ops).concat(loose.map(strip));
}
const strip = (o: Op & { bk?: string }): Op => { if (o.bk === undefined) return o; const { bk: _, ...rest } = o; void _; return rest; };
// Every op filed under a book: its own id plus the 0.x keys that alias to it.
export async function bookOps(book: string): Promise<Op[]> {
  const filed = async (bk: string) => {
    const [loose, segs] = await readTogether<[(Op & { bk?: string })[], Seg[]]>(["ops", "segs"], t => [t.objectStore("ops").index("bk").getAll(bk), t.objectStore("segs").index("bk").getAll(bk)]);
    return segs.flatMap(s => s.ops).concat(loose.map(strip));
  };
  const own = await filed(book);
  const olds = new Set(own.filter(o => o.k === "alias" && o.v.book === book && typeof o.v.old === "string").map(o => o.v.old as string));
  const more = await Promise.all([...olds].map(filed));
  return own.concat(...more);
}

// Pack loose ops into segments once there are at least `min` loose ops in all. Each book's ops go into its own
// segments of up to SEG_MAX; when a book has several part-full segments they are packed again together. Books are
// read and packed one at a time (one transaction each), so this never holds storage for long, and readers (which
// read loose ops and segments together) see every op exactly once, before or after. Ops filed under no book (a few
// reader settings) stay loose.
export const SEG_MAX = 2000;
export async function compact(min = 500): Promise<{ packed: number; segments: number }> {
  const d = await db();
  const count = await new Promise<number>((ok, bad) => { const r = d.transaction("ops").objectStore("ops").index("bk").count(); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  if (count < min) return { packed: 0, segments: 0 };
  const bks = await new Promise<string[]>((ok, bad) => {
    const out: string[] = []; const r = d.transaction("ops").objectStore("ops").index("bk").openKeyCursor(null, "nextunique");
    r.onsuccess = () => { const c = r.result; if (!c) return ok(out); out.push(c.key as string); c.continue(); }; r.onerror = () => bad(r.error);
  });
  let packed = 0, segments = 0;
  for (const bk of bks) {
    await new Promise<void>((ok, bad) => {
      const t = d.transaction(["ops", "segs", "opids"], "readwrite");
      const segs = t.objectStore("segs"), ops = t.objectStore("ops"), ids = t.objectStore("opids");
      ops.index("bk").getAll(bk).onsuccess = e1 => {
        const list = (e1.target as IDBRequest<(Op & { bk?: string })[]>).result; if (!list.length) return;
        segs.index("bk").getAll(bk).onsuccess = e => {
          const old = ((e.target as IDBRequest<Seg[]>).result).filter(s => s.ops.length < SEG_MAX);
          const repack = old.length >= 4 ? old : [];
          const all = repack.flatMap(s => s.ops).concat(list.map(strip)).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
          for (const s of repack) segs.delete(s.id);
          const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
          for (let i = 0; i < all.length; i += SEG_MAX) {
            const seg: Seg = { id: `${bk}~${stamp}~${i / SEG_MAX}`, bk, ops: all.slice(i, i + SEG_MAX) };
            segs.put(seg); for (const o of seg.ops) ids.put(seg.id, o.id); segments++;
          }
          for (const o of list) ops.delete(o.id);
          packed += list.length;
        };
      };
      t.oncomplete = () => ok(); t.onerror = () => bad(t.error); t.onabort = () => bad(t.error);
    });
  }
  return { packed, segments };
}
// anchors store: op id -> { p: parser version, a: anchor or null when the quote was not found }
export interface StoredAnchor { p: number; a: Anchor | null; book: string }
export async function anchorsMap(): Promise<Map<string, Anchor | null>> {
  const keys = (await getAllKeys("anchors")) as string[], vals = await getAll<StoredAnchor>("anchors");
  const m = new Map<string, Anchor | null>();
  keys.forEach((k, i) => { if (vals[i]?.p === PARSER_VERSION) m.set(k, vals[i].a); });
  return m;
}

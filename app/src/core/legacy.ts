// Moving a 0.x library (Python in the browser, files in the IndexedDB database "/data") into this one. The old
// database is only read, never changed, so the 0.x app keeps working and the move can run again safely.
import { strFromU8 } from "fflate";
import type { Anchor, Op } from "./types";
import { PARSER_VERSION } from "./types";
import { addOp, allOps, anchorsChanged, clean, mergeOps, resolver, type StoredAnchor } from "./ops";
import { getAll, getAllKeys, put, get } from "./idb";
import { blockTexts, locate, relocate, type BlockText } from "./reanchor";
import type { LibraryBook } from "./read";

export interface LegacyFile { path: string; contents: Uint8Array }

export function readLegacy(factory: IDBFactory = indexedDB): Promise<LegacyFile[] | null> {
  return new Promise(ok => {
    let created = false;
    const r = factory.open("/data");
    r.onupgradeneeded = () => { created = true; r.transaction?.abort(); }; // no 0.x library here: do not create one
    r.onerror = () => ok(null);
    r.onsuccess = () => {
      const d = r.result;
      if (created || !d.objectStoreNames.contains("FILE_DATA")) { d.close(); ok(null); return; }
      const out: LegacyFile[] = [];
      const c = d.transaction("FILE_DATA").objectStore("FILE_DATA").openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) { d.close(); ok(out); return; }
        const v = cur.value as { contents?: ArrayLike<number> & { buffer?: ArrayBuffer; byteOffset?: number; byteLength?: number } };
        if (v?.contents) {
          const x = v.contents;
          const u8 = x.buffer ? new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength ?? x.length) : Uint8Array.from(x as ArrayLike<number>);
          out.push({ path: String(cur.key), contents: new Uint8Array(u8) });
        }
        cur.continue();
      };
      c.onerror = () => { d.close(); ok(null); };
    };
  });
}

// Newest change time in the 0.x database, read from its timestamp index without loading any file. null: no 0.x
// library on this device. Used to skip the move when nothing changed since the last one.
export function legacyStamp(factory: IDBFactory = indexedDB): Promise<number | null> {
  return new Promise(ok => {
    let created = false;
    const r = factory.open("/data");
    r.onupgradeneeded = () => { created = true; r.transaction?.abort(); };
    r.onerror = () => ok(null);
    r.onsuccess = () => {
      const d = r.result;
      if (created || !d.objectStoreNames.contains("FILE_DATA")) { d.close(); ok(null); return; }
      const st = d.transaction("FILE_DATA").objectStore("FILE_DATA");
      const src: IDBObjectStore | IDBIndex = st.indexNames.contains("timestamp") ? st.index("timestamp") : st;
      const cnt = st.count();
      const c = src.openCursor(null, "prev");
      let t = -1, n = -1;
      const done = () => { if (t >= 0 && n >= 0) { d.close(); ok(t * 1000 + (n % 1000)); } };
      cnt.onsuccess = () => { n = cnt.result; done(); };
      c.onsuccess = () => {
        const v = c.result?.value as { timestamp?: Date | number } | undefined;
        t = v?.timestamp instanceof Date ? v.timestamp.getTime() : Number(v?.timestamp || 0);
        done();
      };
      c.onerror = () => { d.close(); ok(null); };
    };
  });
}

const jsonl = (u8: Uint8Array) => strFromU8(u8).split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const hash12 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).slice(0, 6), b => b.toString(16).padStart(2, "0")).join("");

// A 0.x chapter card has no op id; this one is the same on every device, so copies stay identical.
export async function cardOp(bookKey: string, name: string, text: string): Promise<Op> {
  return { id: `card.${await hash12(`${bookKey}|${name}|${text}`)}`, dev: "card", t: 0, k: "card", v: { name, text }, b: bookKey };
}
export function cardsFromOps(ops: Op[], keyOf: (o: Op) => string | undefined) {
  const out: Record<string, Record<string, string>> = {};
  for (const o of ops) if (o.k === "card" && typeof o.v.name === "string" && typeof o.v.text === "string") { const k = keyOf(o); if (k) (out[k] ||= {})[o.v.name] = o.v.text; }
  return out;
}

export interface LegacyReport {
  library: string | null; at: number;
  books: { old: string; id: string; title: string }[]; failed: { old: string; reason: string }[];
  ops: number; cards: number; pending: number;
  highlights: { total: number; placed: number; missed: { book: string; quote: string }[] };
  reader: Record<string, unknown> | null; keys: number;
}

export async function migrateLegacy(files: LegacyFile[], importBytes: (b: Uint8Array) => Promise<LibraryBook>, onProgress?: (p: { done: number; total: number }) => void): Promise<LegacyReport> {
  const at = (p: string) => files.find(f => f.path === p);
  const lib = at("/data/library/library.json");
  const report: LegacyReport = { library: lib ? JSON.parse(strFromU8(lib.contents)).id ?? null : null, at: Date.now(), books: [], failed: [], ops: 0, cards: 0, pending: 0, highlights: { total: 0, placed: 0, missed: [] }, reader: null, keys: 0 };
  const incoming: Op[] = [];
  const have = await allOps();
  const aliased = new Set(have.filter(o => o.k === "alias").map(o => `${o.v.old}>${o.v.book}`));
  const epubs = files.filter(f => /^\/data\/library\/[^/]+\/book\.epub$/.test(f.path));
  let done = 0;
  for (const f of epubs) {
    onProgress?.({ done: done++, total: epubs.length });
    const old = f.path.split("/")[3];
    try {
      const b = await importBytes(f.contents);
      report.books.push({ old, id: b.id, title: b.title });
      if (!aliased.has(`${old}>${b.id}`)) await addOp("alias", { old, book: b.id, sha256: b.sha256 });
    } catch (e) { report.failed.push({ old, reason: (e as Error).message }); }
  }
  for (const f of files) {
    let m = f.path.match(/^\/data\/library\/([^/]+)\/ops\/[^/]+\.jsonl$/);
    if (m) { for (const o of jsonl(f.contents)) incoming.push({ ...o, b: m[1] }); continue; }
    if (/^\/data\/library\/\.ops\/[^/]+\.jsonl$/.test(f.path)) { incoming.push(...jsonl(f.contents)); continue; }
    m = f.path.match(/^\/data\/library\/([^/]+)\/cards\/([^/]+\.json)$/);
    if (m) { incoming.push(await cardOp(m[1], m[2], strFromU8(f.contents))); report.cards++; continue; }
    m = f.path.match(/^\/data\/pending\/([^/]+)\.json$/);
    if (m) {
      try {
        const got = JSON.parse(strFromU8(f.contents));
        for (const o of got.ops || []) incoming.push({ ...o, b: m[1] });
        for (const [name, text] of Object.entries(got.cards || {})) { incoming.push(await cardOp(m[1], name, String(text))); report.cards++; }
        report.pending++;
      } catch { /* a broken pending file is skipped */ }
      continue;
    }
    if (f.path.startsWith("/data/keys")) report.keys++;
  }
  const fresh = await mergeOps(incoming.map(o => clean(o)).filter((o): o is Op => !!o));
  report.ops = fresh.length;
  const ops = await allOps();
  const r = resolver(ops);
  const reader = ops.filter(o => o.k === "reader" && o.b === undefined).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1)).pop();
  report.reader = reader ? reader.v : null;
  await reanchorAll();
  const anchors = await getAll<StoredAnchor>("anchors"), keys = (await getAllKeys("anchors")) as string[];
  const placed = new Map(keys.map((k, i) => [k, anchors[i]]));
  const live = new Map<string, Op>();
  for (const o of ops) if ((o.k === "hl" || o.k === "hl-") && o.b !== undefined && report.books.some(b => b.old === o.b)) { const id = `${o.b}|${o.v.id}`; const c = live.get(id); if (!c || o.t > c.t || (o.t === c.t && o.id > c.id)) live.set(id, o); }
  for (const o of live.values()) {
    if (o.k !== "hl") continue;
    report.highlights.total++;
    if (placed.get(o.id)?.a) report.highlights.placed++;
    else report.highlights.missed.push({ book: report.books.find(b => b.old === o.b)?.title || String(o.b), quote: String(o.v.quote || "").slice(0, 160) });
  }
  void r;
  await put("kv", report, "legacy");
  return report;
}

// Where 0.x highlights and positions sit in the new text. Runs after a migration, after a sync brings 0.x ops, and
// after a book is re-imported; only ops without a current anchor are looked at. Results are stored per op id.
export async function reanchorAll(sectionsOf?: (book: string) => Promise<{ idx: number; html: string }[]>): Promise<number> {
  const ops = await allOps();
  const r = resolver(ops);
  const keys = (await getAllKeys("anchors")) as string[], vals = await getAll<StoredAnchor>("anchors");
  const done = new Set(keys.filter((_, i) => vals[i]?.p === PARSER_VERSION));
  const books = new Set((await getAll<LibraryBook>("books")).map(b => b.id));
  const todo = ops.filter(o => (o.k === "hl" || o.k === "pos") && !o.v.anchor && typeof o.v.section !== "number" && typeof o.v.quote === "string" && !done.has(o.id));
  const byBook = new Map<string, Op[]>();
  for (const o of todo) { const b = r.bookOf(o); if (b && books.has(b)) (byBook.get(b) || byBook.set(b, []).get(b)!).push(o); }
  let n = 0;
  for (const [book, list] of byBook) {
    const secs = sectionsOf ? await sectionsOf(book) : await loadSections(book);
    const blocks: BlockText[] = secs.flatMap(s => blockTexts(s.idx, s.html));
    const maxCh = Math.max(1, ...ops.filter(o => r.bookOf(o) === book && typeof o.v.chapter === "number").map(o => o.v.chapter as number));
    for (const o of list) {
      const ch = typeof o.v.chapter === "number" ? o.v.chapter : null;
      const a = locate(blocks, String(o.v.quote), { fraction: ch == null ? undefined : ch / (maxCh + 1) });
      await put("anchors", { p: PARSER_VERSION, a, book } satisfies StoredAnchor, o.id);
      n++;
    }
    anchorsChanged(book);
  }
  return n;
}
// Marks whose anchor was made by another parser version (an older app, or this one before an update re-read the
// book) are found again in the current text, once per op. Same store as the 0.x results: op id -> anchor or null.
export async function relocateStale(sectionsOf?: (book: string) => Promise<{ idx: number; html: string }[]>): Promise<{ checked: number; moved: number; lost: number }> {
  const ops = await allOps();
  const r = resolver(ops);
  const keys = (await getAllKeys("anchors")) as string[], vals = await getAll<StoredAnchor>("anchors");
  const done = new Set(keys.filter((_, i) => vals[i]?.p === PARSER_VERSION));
  const books = new Set((await getAll<LibraryBook>("books")).map(b => b.id));
  const byBook = new Map<string, { o: Op; at: Anchor }[]>();
  for (const o of ops) {
    if (done.has(o.id)) continue;
    const at = o.k === "mark" ? (o.v.set as { at?: Anchor } | undefined)?.at : o.k === "hl" ? o.v.anchor as Anchor | undefined : undefined;
    if (!at || (typeof o.v.p === "number" ? o.v.p : 2) === PARSER_VERSION) continue;
    const b = r.bookOf(o); if (b && books.has(b)) (byBook.get(b) || byBook.set(b, []).get(b)!).push({ o, at });
  }
  let checked = 0, moved = 0, lost = 0;
  for (const [book, list] of byBook) {
    const secs = sectionsOf ? await sectionsOf(book) : await loadSections(book);
    const blocks: BlockText[] = secs.flatMap(s => blockTexts(s.idx, s.html));
    for (const { o, at } of list) {
      const a = relocate(blocks, at);
      checked++; if (!a) lost++; else if (a !== at) moved++;
      await put("anchors", { p: PARSER_VERSION, a, book } satisfies StoredAnchor, o.id);
    }
    anchorsChanged(book);
  }
  return { checked, moved, lost };
}
async function loadSections(book: string) {
  const h = await get<{ sectionInfo: { idx: number }[] }>("heads", book);
  const out: { idx: number; html: string }[] = [];
  for (const s of h?.sectionInfo || []) { const x = await get<{ idx: number; html: string }>("sections", [book, s.idx]); if (x) out.push(x); }
  return out;
}

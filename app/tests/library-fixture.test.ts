// Upgrade fixtures: a real library (books, highlights, notes, tags, bookmarks, a removed mark, reading positions,
// settings) saved from every database version. Each one is loaded at its own version and opened with the current
// code; every record must still be there, unchanged, and marks and positions must fold the same (docs/MIGRATIONS.md).
// WRITE_FIXTURE=1 npx vitest run tests/library-fixture.test.ts saves the fixture for the current DB_VERSION.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { db, resetDb, openState, DB_VERSION, STORES } from "../src/core/idb";
import { runMigrations } from "../src/core/migrations";
import { allOps, addOp, latest, resolver } from "../src/core/ops";
import { foldMarks } from "../src/core/marks";
import { createMark, setNote, addTag, removeMark } from "../src/core/marks-io";
import { importBytes, listBooks, head, section } from "../src/core/library";
import { makeEpub } from "./fixtures";

const DIR = new URL("./fixtures/", import.meta.url);
type Enc = unknown;
async function enc(v: unknown): Promise<Enc> {
  if (v instanceof Blob) return { $blob: Buffer.from(await v.arrayBuffer()).toString("base64"), type: v.type };
  if (v instanceof Uint8Array) return { $u8: Buffer.from(v).toString("base64") };
  if (v instanceof ArrayBuffer) return { $ab: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return Promise.all(v.map(enc));
  if (v && typeof v === "object") { const o: Record<string, Enc> = {}; for (const [k, x] of Object.entries(v)) o[k] = await enc(x); return o; }
  return v;
}
function dec(v: Enc): unknown {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.$blob === "string") return new Blob([Buffer.from(o.$blob, "base64")], { type: o.type as string });
    if (typeof o.$u8 === "string") return new Uint8Array(Buffer.from(o.$u8, "base64"));
    if (typeof o.$ab === "string") return new Uint8Array(Buffer.from(o.$ab, "base64")).buffer;
    const r: Record<string, unknown> = {}; for (const [k, x] of Object.entries(o)) r[k] = dec(x); return r;
  }
  return v;
}
// every record of every store, as [key, value]
async function dump(d: IDBDatabase) {
  const out: Record<string, [IDBValidKey, Enc][]> = {};
  for (const s of Array.from(d.objectStoreNames)) {
    const rows: [IDBValidKey, unknown][] = await new Promise((ok, bad) => {
      const acc: [IDBValidKey, unknown][] = [], r = d.transaction(s).objectStore(s).openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) return ok(acc); acc.push([c.primaryKey, c.value]); c.continue(); };
      r.onerror = () => bad(r.error);
    });
    out[s] = await Promise.all(rows.map(async ([k, v]) => [k, await enc(v)] as [IDBValidKey, Enc]));
  }
  return out;
}
async function summary() {
  const ops = await allOps(), r = resolver(ops), books = (await listBooks()).sort((a, b) => a.id.localeCompare(b.id));
  return {
    books: books.map(b => ({ id: b.id, title: b.title, sha256: b.sha256 })),
    marks: books.map(b => foldMarks(ops, b.id, r).map(m => ({ id: m.id, color: m.color, style: m.style, note: m.note, tags: m.tags, gone: m.gone, at: m.at }))),
    pos: books.map(b => latest(ops, "pos", o => o.v.book === b.id)?.v ?? null),
    reader: latest(ops, "reader")?.v ?? null,
    ops: ops.length,
  };
}
async function wipe() {
  await resetDb();
  await new Promise<void>(ok => { const r = indexedDB.deleteDatabase("vicaria"); r.onsuccess = () => ok(); r.onerror = () => ok(); r.onblocked = () => ok(); });
}

describe("upgrade fixtures", () => {
  beforeEach(wipe);
  it.runIf(process.env.WRITE_FIXTURE)("saves a real library at the current version", async () => {
    const a = await importBytes(makeEpub({ "c1.xhtml": "<h1>Uno</h1><p>El río corre hacia el mar, sin prisa.</p><p>Second paragraph with $x^2$ and words.</p>", "c2.xhtml": "<h1>Dos</h1><p>Another chapter, longer, with a quote to mark.</p>" }, { title: "Libro de prueba", lang: "es" }));
    const b = await importBytes(makeEpub({ "a.xhtml": "<h1>One</h1><p>The quick brown fox jumps over the lazy dog.</p>" }, { title: "Test Book" }));
    const at = (bk: string, block: number, s: number, e: number, exact: string, prefix = "", suffix = "") => ({ section: 0, block, offset: s, endBlock: block, endOffset: e, exact, prefix, suffix });
    const h1 = await createMark(a.id, { at: at(a.id, 1, 0, 6, "El río", "", " corre"), color: "yellow" } as never, { note: "primera nota, con tilde y emoji 📚" });
    const h2 = await createMark(a.id, { at: at(a.id, 1, 7, 12, "corre", "El río ", " hacia"), color: "blue", style: "underline" } as never, { tags: ["tema"] });
    await createMark(a.id, { at: at(a.id, 1, 0, 0, "", "", "El río") } as never); // a bookmark
    const h3 = await createMark(b.id, { at: at(b.id, 1, 4, 9, "quick", "The ", " brown"), color: "pink" } as never);
    const ops = await allOps(), m = (id: string, bk: string) => foldMarks(ops, bk).find(x => x.id === id)!;
    await setNote(m(String(h2.v.id), a.id), "a note added later");
    await addTag(m(String(h1.v.id), a.id), "favorito");
    await removeMark(m(String(h3.v.id), b.id));
    await addOp("pos", { book: a.id, section: 1, block: 0, offset: 3 });
    await addOp("pos", { book: b.id, section: 0, block: 1, offset: 0 });
    await addOp("reader", { theme: "sepia", size: 19, font: "serif" });
    const d = await db();
    mkdirSync(DIR, { recursive: true });
    writeFileSync(new URL(`db-v${DB_VERSION}.json`, DIR), JSON.stringify({ version: d.version, stores: await dump(d), expect: await summary() }));
  });

  const files = (() => { try { return readdirSync(DIR).filter(f => /^db-v\d+\.json$/.test(f)); } catch { return []; } })();
  it("there is a fixture for the current version", () => { expect(files).toContain(`db-v${DB_VERSION}.json`); });
  async function load(f: string) {
    const fx = JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as { version: number; stores: Record<string, [IDBValidKey, Enc][]>; expect: unknown };
    const seed = await new Promise<IDBDatabase>((ok, bad) => {
      const r = indexedDB.open("vicaria", fx.version);
      r.onupgradeneeded = () => runMigrations(r.result, r.transaction!, 0, fx.version);
      r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
    });
    const t = seed.transaction(Object.keys(fx.stores), "readwrite");
    for (const [s, rows] of Object.entries(fx.stores)) { const st = t.objectStore(s); for (const [k, v] of rows) st.keyPath === null ? st.put(dec(v), k) : st.put(dec(v)); }
    await new Promise((ok, bad) => { t.oncomplete = ok; t.onerror = () => bad(t.error); });
    seed.close();

    return fx;
  }
  for (const f of files) it(`${f} opens with the current code and loses nothing`, async () => {
    const fx = await load(f);
    const d = await db();
    expect(openState.failed).toBeUndefined(); expect(openState.unusable).toBeUndefined();
    expect(d.version).toBe(DB_VERSION);
    for (const s of STORES) expect(d.objectStoreNames.contains(s)).toBe(true);
    const now = await dump(d);
    for (const [s, rows] of Object.entries(fx.stores)) {
      const have = new Map(now[s].map(([k, v]) => [JSON.stringify(k), JSON.stringify(v)]));
      for (const [k, v] of rows) expect(have.get(JSON.stringify(k)), `${s} ${JSON.stringify(k)}`).toBe(JSON.stringify(v));
    }
    expect(await summary()).toEqual(fx.expect);
    for (const b of await listBooks()) { const h = await head(b.id); expect(h).toBeTruthy(); expect(await section(b.id, 0)).toBeTruthy(); }
  });
  // Saved thoughts, lessons and settings are new kinds of op (docs/MIGRATIONS.md): no database step, so a library from
  // every older version must take them in, fold them, and read exactly as before.
  for (const f of files) it(`${f} takes saved thoughts, lessons and settings without changing anything else`, async () => {
    const fx = await load(f);
    await db();
    const before = await summary();
    const { putThought, putLesson, putPrefs, foldThoughts, foldLessons, foldPrefs, DEFAULT_PREFS } = await import("../src/wiser/data");
    await putThought({ id: "ai-2026-11-22", text: "Do the call you avoid.", src: "ai", day: "2026-11-22", made: 1 });
    await putLesson({ id: "les-1", title: "The ledger", body: "body", people: ["Benjamin Franklin"], models: ["feedback loop"], summary: "s", topics: [], lang: "en", src: "ai", made: 1 });
    await putPrefs({ ...DEFAULT_PREFS, people: ["Seneca"], tone: "warm" });
    const ops = await allOps();
    expect(foldThoughts(ops).map(t => t.id)).toEqual(["ai-2026-11-22"]);
    expect(foldLessons(ops).map(l => l.title)).toEqual(["The ledger"]);
    expect(foldPrefs(ops)).toMatchObject({ people: ["Seneca"], tone: "warm" });
    const after = await summary();
    expect(after).toEqual({ ...before, ops: before.ops + 3 });
    expect(after).toMatchObject({ marks: (fx.expect as { marks: unknown }).marks, pos: (fx.expect as { pos: unknown }).pos });
  });
});

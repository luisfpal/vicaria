// Upgrades: a failing migration leaves everything as it was and the app keeps working; the next launch upgrades;
// an older database (version 1, before ops had a book index) upgrades with every record kept.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, openState, getAll, DB_VERSION, STORES } from "../src/core/idb";
import { MIGRATIONS, runMigrations } from "../src/core/migrations";

// a database at `version`, built with the first steps, holding these records
async function seed(version: number, records: Record<string, [IDBValidKey | undefined, unknown][]>) {
  await resetDb();
  await new Promise<void>(ok => { const r = indexedDB.deleteDatabase("vicaria"); r.onsuccess = () => ok(); r.onerror = () => ok(); });
  const d = await new Promise<IDBDatabase>((ok, bad) => {
    const r = indexedDB.open("vicaria", version);
    r.onupgradeneeded = () => runMigrations(r.result, r.transaction!, 0, version);
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
  const t = d.transaction(Object.keys(records), "readwrite");
  for (const [s, rows] of Object.entries(records)) for (const [k, v] of rows) k === undefined ? t.objectStore(s).put(v) : t.objectStore(s).put(v, k);
  await new Promise(ok => { t.oncomplete = ok; });
  d.close();
}
const op = (n: number, book = "b1") => ({ id: `dev1.${n}`, dev: "dev1", t: 1000 + n, k: "mark", v: { id: `m${n}`, book, set: { color: "green" }, note: `note ${n} ñ` } });

describe("upgrades", () => {
  beforeEach(() => resetDb());
  it("a migration that throws leaves the old version and every record", async () => {
    await seed(3, { ops: [[undefined, op(1)], [undefined, op(2)]], kv: [["counter", 2], ["reader", { theme: "sepia" }]], books: [[undefined, { id: "b1", title: "A" }]] });
    const real = MIGRATIONS[3];
    MIGRATIONS[3] = () => { throw new Error("broken step"); };
    try {
      const d = await db();
      expect(d.version).toBe(3);
      expect(openState.failed).toMatchObject({ from: 3, to: 4, error: "broken step" });
      expect((await getAll("ops")).length).toBe(2);
      expect(await getAll("kv")).toEqual([2, { theme: "sepia" }]);
      expect(d.objectStoreNames.contains("segs")).toBe(false); // nothing half done
      expect(openState.unusable).toEqual(["segs", "opids"]);    // so the app goes back to the previous build
    } finally { MIGRATIONS[3] = real; }
    // next launch: the upgrade runs and keeps everything
    await resetDb();
    const d2 = await db();
    expect(d2.version).toBe(DB_VERSION); expect(openState.upgraded).toEqual({ from: 3, to: DB_VERSION });
    expect((await getAll("ops")).map(o => (o as { id: string }).id).sort()).toEqual(["dev1.1", "dev1.2"]);
    for (const s of STORES) expect(d2.objectStoreNames.contains(s)).toBe(true);
  });
  it("a failed step that only adds what this code can do without leaves the library usable", async () => {
    await seed(DB_VERSION, { ops: [[undefined, op(1)]] });
    MIGRATIONS.push(() => { throw new Error("broken extra step"); });
    try {
      await resetDb();
      const { db: open2, openState: st } = await import("../src/core/idb");
      // DB_VERSION is fixed at import, so open at the next version by hand the way db() does
      const r = indexedDB.open("vicaria", DB_VERSION + 1);
      await new Promise(ok => { r.onupgradeneeded = () => { try { runMigrations(r.result, r.transaction!, DB_VERSION, DB_VERSION + 1); } catch { r.transaction!.abort(); } }; r.onerror = ok; r.onsuccess = ok; });
      expect(r.error?.name).toBe("AbortError");
      const d = await open2();
      expect(d.version).toBe(DB_VERSION); expect(st.unusable).toBeUndefined();
      expect((await getAll("ops")).length).toBe(1);
    } finally { MIGRATIONS.pop(); }
  });
  it("version 1 (no book index, no settings store) upgrades with every op kept and indexed by book", async () => {
    const ops = Array.from({ length: 50 }, (_, i) => op(i + 1, i % 2 ? "b1" : "b2"));
    await seed(1, { ops: ops.map(o => [undefined, o]), books: [[undefined, { id: "b1" }], [undefined, { id: "b2" }]] });
    const d = await db();
    expect(d.version).toBe(DB_VERSION);
    const after = await getAll<typeof ops[number] & { bk?: string }>("ops");
    expect(after.map(({ bk, ...o }) => o)).toEqual(ops.sort((a, b) => a.id < b.id ? -1 : 1));
    expect(after.every(o => o.bk === o.v.book)).toBe(true);
  });
  it("an older build opens a newer database as it is", async () => {
    // a future version with an extra store this build does not know
    await seed(DB_VERSION, { ops: [[undefined, op(1)]] });
    await new Promise<void>(ok => { const r = indexedDB.open("vicaria", DB_VERSION + 1); r.onupgradeneeded = () => r.result.createObjectStore("future"); r.onsuccess = () => { r.result.close(); ok(); }; });
    const d = await db();
    expect(d.version).toBe(DB_VERSION + 1); expect(openState.newer).toBe(DB_VERSION + 1);
    expect((await getAll("ops")).length).toBe(1);
  });
});

describe("restoring from the snapshot taken before an upgrade", () => {
  beforeEach(() => resetDb());
  it("brings back ops that went missing, from loose ops and packed segments, and adds nothing twice", async () => {
    await seed(DB_VERSION, { ops: [[undefined, op(1)]] });
    const { restoreOps } = await import("../src/core/snapshots");
    const snap = { from: 3, to: 4, at: 1, ops: [{ ...op(1), bk: "b1" }, { ...op(2), bk: "b1" }], segs: [{ id: "s1", bk: "b1", ops: [op(3), { junk: true }] }], kv: [], books: [] };
    expect(await restoreOps(snap)).toBe(2);
    expect((await getAll<{ id: string }>("ops")).map(o => o.id).sort()).toEqual(["dev1.1", "dev1.2", "dev1.3"]);
    expect(await restoreOps(snap)).toBe(0);
  });
});

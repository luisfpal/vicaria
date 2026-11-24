import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { importBytes, listBooks, head, section, passages, removeBook, image, reparseIfStale } from "../src/core/library";
import { put, get } from "../src/core/idb";
import { addOp, allOps } from "../src/core/ops";
import { PARSER_VERSION } from "../src/core/types";
import { migrate } from "../src/core/migrate";
import { highlights, newer, validOp } from "../src/core/ops";
import type { Op } from "../src/core/types";

const CORPUS = new URL("../../tests/corpus/", import.meta.url).pathname;

describe("library storage", () => {
  it("imports, reads one section at a time, and is idempotent by content hash", async () => {
    const bytes = new Uint8Array(readFileSync(CORPUS + "meditations-se.epub"));
    const a = await importBytes(bytes);
    const b = await importBytes(bytes);
    expect(a.id).toBe(b.id);
    expect((await listBooks()).length).toBe(1);
    const h = await head(a.id);
    expect(h!.sectionInfo.length).toBe(17);
    expect(Object.keys(h!.notes).length).toBe(122);
    const s = await section(a.id, h!.meta.start);
    expect(s!.html).toContain('class="nref"');
    expect((await passages(a.id))!.length).toBeGreaterThan(100);
    if (h!.meta.cover) expect(await image(a.id, h!.meta.cover)).toBeTruthy();
    await removeBook(a);
    expect((await listBooks()).length).toBe(0);
  });
  it("re-derives a book from its original when the parser version goes up, keeping highlights and the added date", async () => {
    const bytes = new Uint8Array(readFileSync(CORPUS + "meditations-se.epub"));
    const a = await importBytes(bytes, { addedAt: 1234 });
    await addOp("hl", { id: "h1", book: a.id, anchor: { section: 2, block: 3, offset: 0, exact: "x", prefix: "", suffix: "" }, color: "yellow", created: 1 });
    // pretend this copy was made by an older parser that lost the notes
    const h = (await head(a.id))!;
    await put("heads", { ...h, notes: {} });
    await put("books", { ...a, v: 0 });
    const stale = (await listBooks())[0];
    expect(stale.v).toBe(0);
    const fresh = await reparseIfStale(stale);
    expect(fresh.v).toBe(PARSER_VERSION);
    expect(fresh.addedAt).toBe(1234);
    expect(Object.keys((await head(a.id))!.notes).length).toBe(122);
    expect((await allOps()).some(o => o.k === "hl" && (o.v as { id: string }).id === "h1")).toBe(true);
    expect(await reparseIfStale(fresh)).toBe(fresh); // current books are left alone
    await removeBook(fresh);
    expect(await get("heads", a.id)).toBeUndefined();
  });
  it("migrations run once, in order, and refuse newer data", async () => {
    const ran: number[] = [];
    const list = [{ to: 1, run: async () => { ran.push(1); } }, { to: 2, run: async () => { ran.push(2); } }];
    const { put } = await import("../src/core/idb");
    await put("kv", 0, "schema");
    expect(await migrate(list, 2)).toBe(2);
    expect(await migrate(list, 2)).toBe(2);
    expect(ran).toEqual([1, 2]);
    await expect(migrate(list, 1)).rejects.toThrow(/newer Vicaria/);
    await put("kv", 1, "schema");
  });
});

describe("op log merge", () => {
  // an op id always names the same op (device + counter), so content is derived from the id
  const op = fc.record({ dev: fc.constantFrom("dev-a", "dev-b", "dev-c"), n: fc.nat(60) }).map(({ dev, n }) => ({ id: `${dev}.${n}`, dev, t: (n * 7) % 13, k: n % 3 ? "hl" : "hl-",
    v: { book: "b", id: n % 2 ? "h1" : "h2", color: n % 5 ? "yellow" : "blue", anchor: { section: 0, block: 0, offset: 0, exact: "x", prefix: "", suffix: "" } } }) as Op);
  const union = (a: Op[], b: Op[]) => { const m = new Map<string, Op>(); for (const o of [...a, ...b]) if (!m.has(o.id)) m.set(o.id, o); return [...m.values()]; };
  it("is commutative, associative and idempotent", () => {
    fc.assert(fc.property(fc.array(op), fc.array(op), fc.array(op), (a, b, c) => {
      // ids are unique per device counter in practice: dedupe the generated logs the same way
      const norm = (x: Op[]) => union(x, []);
      [a, b, c] = [norm(a), norm(b), norm(c)];
      const read = (x: Op[]) => JSON.stringify(highlights(x, "b"));
      expect(read(union(a, b))).toBe(read(union(b, a)));
      expect(read(union(union(a, b), c))).toBe(read(union(a, union(b, c))));
      expect(read(union(a, a))).toBe(read(a));
    }), { numRuns: 300 });
  });
  it("newest operation wins, ties broken by id", () => {
    const a = { id: "da.1", dev: "da", t: 5, k: "hl", v: {} } as Op, b = { id: "db.1", dev: "db", t: 5, k: "hl", v: {} } as Op;
    expect(newer(b, a)).toBe(true);
  });
  it("rejects malformed operations", () => {
    expect(validOp({ id: "dxxxx.1", dev: "dyyyy", t: 1, k: "hl", v: {} })).toBe(false);
    expect(validOp({ id: "dyyyy.1", dev: "dyyyy", t: 1, k: "Not A Kind", v: {} })).toBe(false);
    expect(validOp({ id: "dyyyy.1", dev: "dyyyy", t: 1, k: "hl", v: {} })).toBe(true);
    expect(validOp({ id: "y.1", dev: "y", t: 1, k: "hl", v: {} })).toBe(false); // 0.x needs device ids of 4 to 40 characters
  });
});

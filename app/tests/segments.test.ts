import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { allOps, bookOps, mergeOps, compact, SEG_MAX } from "../src/core/ops";
import { foldMarks } from "../src/core/marks";
import { tx, getAll, getAllKeys } from "../src/core/idb";
import type { Op } from "../src/core/types";

const clear = () => tx(["ops", "segs", "opids"], t => { for (const s of ["ops", "segs", "opids"]) t.objectStore(s).clear(); });
const mk = (dev: string, n: number, book: string, color = "yellow"): Op => ({ id: `${dev}.${n}`, dev, t: 1_700_000_000_000 + n, c: 0, k: "mark", v: { id: `m${n % 37}`, book, set: { at: { section: 0, block: n % 9, offset: 0, exact: "x", prefix: "", suffix: "" }, color } } });
const ids = (ops: Op[]) => ops.map(o => o.id).sort();

describe("op log segments", () => {
  it("packs a book's ops and every read still sees each op once", async () => {
    await clear();
    const a = Array.from({ length: 2500 }, (_, i) => mk("deva", i, "A")), b = Array.from({ length: 50 }, (_, i) => mk("devb", i, "B"));
    await mergeOps([...a, ...b]);
    const before = await allOps();
    expect((await compact(5000)).packed).toBe(0); // fewer loose ops than the threshold: nothing to do
    const r = await compact(200);
    expect(r.packed).toBe(2550); expect(r.segments).toBe(Math.ceil(2500 / SEG_MAX) + 1);
    expect((await getAll("ops")).length).toBe(0);
    expect(ids(await allOps())).toEqual(ids(before));
    expect(ids(await bookOps("A"))).toEqual(ids(a)); expect(ids(await bookOps("B"))).toEqual(ids(b));
    expect((await allOps()).every(o => !("bk" in o))).toBe(true);
    // ops already packed are not added again
    expect(await mergeOps(a.slice(0, 10))).toEqual([]);
    expect(await mergeOps(a)).toEqual([]); // the bulk path (all keys at once)
    expect((await getAll("ops")).length).toBe(0);
  });
  it("repacks part-full segments instead of letting them pile up", async () => {
    await clear();
    for (let round = 0; round < 6; round++) { await mergeOps(Array.from({ length: 250 }, (_, i) => mk("devc", round * 250 + i, "C"))); await compact(200); }
    const segs = await getAll<{ ops: Op[] }>("segs");
    expect(segs.length).toBeLessThanOrEqual(4);
    expect(segs.reduce((n, s) => n + s.ops.length, 0)).toBe(1500);
    expect((await getAllKeys("opids")).length).toBe(1500);
    expect((await bookOps("C")).length).toBe(1500);
  });
  it("any mix of merges and compactions gives the same marks as never compacting (property)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(
        fc.record({ kind: fc.constant("merge" as const), from: fc.nat(600), n: fc.integer({ min: 1, max: 300 }), book: fc.constantFrom("A", "B", "C") }),
        fc.record({ kind: fc.constant("compact" as const), min: fc.integer({ min: 1, max: 300 }) }),
      ), { maxLength: 8 }),
      async steps => {
        await clear();
        const all = new Map<string, Op>();
        for (const s of steps) {
          if (s.kind === "merge") { const ops = Array.from({ length: s.n }, (_, i) => mk("devp", s.from + i, s.book, ["yellow", "green"][(s.from + i) % 2])); for (const o of ops) if (!all.has(o.id)) all.set(o.id, o); await mergeOps(ops); }
          else await compact(s.min);
        }
        const got = await allOps();
        expect(ids(got)).toEqual([...all.keys()].sort()); // nothing lost, nothing twice
        for (const bk of ["A", "B", "C"]) {
          const want = [...all.values()].filter(o => o.v.book === bk);
          expect(ids(await bookOps(bk))).toEqual(ids(want));
          expect(JSON.stringify(foldMarks(await bookOps(bk), bk))).toEqual(JSON.stringify(foldMarks(want, bk)));
        }
      }), { numRuns: 60 });
  }, 120_000);
});

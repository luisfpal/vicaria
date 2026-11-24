import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync, readdirSync } from "node:fs";
import { importBytes, listBooks } from "../src/core/library";
import { allOps, bookOps, mergeOps } from "../src/core/ops";
import { createMark } from "../src/core/marks-io";
import { foldMarks } from "../src/core/marks";
import { shelfStates, shelfPlan, trashBook, restoreBook, trashList, purgeTrash, deleteForever, KEEP_DAYS } from "../src/core/shelf";
import { readOriginal } from "../src/core/originals";
import type { Op } from "../src/core/types";

const CORPUS = new URL("../../tests/corpus/", import.meta.url).pathname;
const epub = readdirSync(CORPUS).find(f => f.endsWith(".epub"))!;

describe("shelf", () => {
  it("remove keeps the file and the marks; restore brings both back; purge deletes after 30 days", async () => {
    const b = await importBytes(new Uint8Array(readFileSync(CORPUS + epub)));
    await createMark(b.id, { at: { section: 1, block: 1, offset: 0, exact: "x", prefix: "", suffix: "" }, color: "green" });
    await trashBook(b);
    expect((await listBooks()).some(x => x.id === b.id)).toBe(false);
    expect((await trashList()).map(t => t.id)).toEqual([b.id]);
    expect(await readOriginal(b.sha256)).not.toBeNull();
    expect(shelfStates(await allOps()).get(b.id)?.state).toBe("trash");
    const back = await restoreBook(b.id, importBytes);
    expect(back?.id).toBe(b.id);
    expect(foldMarks(await bookOps(b.id), b.id).length).toBe(1);
    expect(shelfStates(await allOps()).get(b.id)?.state).toBe("shelf");
    expect(await trashList()).toEqual([]);
    await trashBook(b, false);
    await purgeTrash(Date.now() + (KEEP_DAYS - 1) * 86400_000); expect((await trashList()).length).toBe(1);
    await purgeTrash(Date.now() + (KEEP_DAYS + 1) * 86400_000); expect((await trashList()).length).toBe(0);
    expect(await readOriginal(b.sha256)).toBeNull();
    await deleteForever("nothing"); // no throw
  });
  it("0.x shelf ops count through their alias", async () => {
    const ops: Op[] = [
      { id: "old1.1", dev: "old1", t: 100, k: "alias", v: { old: "meditations", book: "abcd" } },
      { id: "old1.2", dev: "old1", t: 200, k: "shelf", v: { book: "meditations", state: "trash" } },
    ];
    expect(shelfStates(ops).get("abcd")?.state).toBe("trash");
  });
  it("the newest state wins in any order, and the plan only touches what it can (property)", () => {
    const arb = fc.array(fc.record({ dev: fc.constantFrom("a", "b", "c"), n: fc.nat(50), t: fc.nat(30), book: fc.constantFrom("x", "y", "z"), state: fc.constantFrom("trash", "shelf") }), { maxLength: 25 });
    fc.assert(fc.property(arb, fc.subarray(["x", "y", "z"]), fc.subarray(["x", "y", "z"]), (xs, here, trashed) => {
      const ops: Op[] = xs.map(x => ({ id: `dev${x.dev}.${x.n}`, dev: `dev${x.dev}`, t: x.t, k: "shelf", v: { book: x.book, state: x.state } }));
      const uniq = [...new Map(ops.map(o => [o.id, o])).values()];
      const s1 = shelfStates(uniq), s2 = shelfStates([...uniq].reverse());
      expect([...s1].map(([k, v]) => [k, v.state]).sort()).toEqual([...s2].map(([k, v]) => [k, v.state]).sort());
      const h = new Set(here), tr = new Set(trashed.filter(t => !h.has(t)));
      const plan = shelfPlan(s1, h, tr);
      for (const b of plan.remove) { expect(h.has(b)).toBe(true); expect(s1.get(b)!.state).toBe("trash"); }
      for (const b of plan.restore) { expect(tr.has(b)).toBe(true); expect(s1.get(b)!.state).toBe("shelf"); }
      // applying the plan reaches a fixed point
      const h2 = new Set([...h].filter(b => !plan.remove.includes(b)).concat(plan.restore));
      const tr2 = new Set([...tr].filter(b => !plan.restore.includes(b)).concat(plan.remove));
      expect(shelfPlan(s1, h2, tr2)).toEqual({ remove: [], restore: [] });
    }), { numRuns: 500 });
  });
  it("merging a remove from another device is applied by the plan", async () => {
    const b = await importBytes(new Uint8Array(readFileSync(CORPUS + epub)));
    await mergeOps([{ id: "devz.1", dev: "devz", t: Date.now() + 1000, k: "shelf", v: { book: b.id, state: "trash" } }]);
    const plan = shelfPlan(shelfStates(await allOps()), new Set((await listBooks()).map(x => x.id)), new Set());
    expect(plan.remove).toEqual([b.id]);
  });
});

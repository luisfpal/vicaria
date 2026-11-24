// Writers and receivers of the op log: ids stay unique across contexts that share one database (a tab and the books
// worker, two tabs), and ops from a clock far ahead are kept exactly as written, waiting until their time comes.
import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { addOp, allOps, mergeOps, heldOps, clean, SKEW_MAX } from "../src/core/ops";
import type { Op } from "../src/core/types";

describe("op log writers", () => {
  it("two contexts writing at once never reuse an op id", async () => {
    await addOp("reader", { size: 1 }); // this context has read the counter
    vi.resetModules();
    const other = await import("../src/core/ops"); // a second context: its own memory, same database
    await other.addOp("reader", { size: 2 });
    const ops = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? addOp : other.addOp)("reader", { size: i })));
    const ids = (await allOps()).map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(42);
    expect(new Set(ops.map(o => o.id)).size).toBe(40);
  });
  it("a value that cannot be written leaves nothing behind and reports its own error", async () => {
    const before = (await allOps()).length;
    await expect(addOp("mark", () => { throw new Error("bad value"); })).rejects.toThrow("bad value");
    expect((await allOps()).length).toBe(before);
  });
});

describe("op log receivers", () => {
  it("keeps an op from a clock far ahead unchanged and stores it once its time comes", async () => {
    const now = 1_800_000_000_000;
    const far: Op = { id: "dfast1.1", dev: "dfast1", t: now + SKEW_MAX + 60_000, c: 2, k: "mark", v: { id: "x", book: "B", set: { color: "blue" } } };
    const ok: Op = { id: "dfast1.2", dev: "dfast1", t: now, k: "reader", v: { size: 3 } };
    expect((await mergeOps([far, ok], now)).map(o => o.id)).toEqual(["dfast1.2"]);
    expect((await heldOps()).map(o => o.id)).toEqual(["dfast1.1"]);
    expect((await mergeOps([far], now)).length).toBe(0); // delivered again: still one held copy
    expect((await heldOps()).length).toBe(1);
    const got = await mergeOps([], now + 61_000);
    expect(got.map(o => JSON.stringify(o))).toEqual([JSON.stringify(clean(far))]); // byte-identical to what the sender sends, time not changed
    expect(await heldOps()).toEqual([]);
    expect((await allOps()).find(o => o.id === far.id)!.t).toBe(far.t);
  });
});

describe("ops from newer builds", () => {
  it("an unknown kind and unknown fields are stored and handed on unchanged, and folds ignore them", async () => {
    const { foldMarks } = await import("../src/core/marks");
    const { resolver } = await import("../src/core/ops");
    const future = { id: "dnew1.1", dev: "dnew1", t: Date.now() - 1000, k: "review", v: { book: "bX", due: 123, deck: { ease: 2.5 } } } as unknown as Op;
    const markPlus = { id: "dnew1.2", dev: "dnew1", t: Date.now() - 900, k: "mark", v: { id: "mz", book: "bX", set: { color: "blue", glow: "soft", at: { section: 1, block: 2, offset: 0, endBlock: 2, endOffset: 4, exact: "word", prefix: "", suffix: "" } } } } as unknown as Op;
    expect(clean(future)).toEqual(future);
    const fresh = await mergeOps([future, markPlus]);
    expect(fresh.map(o => o.id).sort()).toEqual(["dnew1.1", "dnew1.2"]);
    const stored = (await allOps()).filter(o => o.dev === "dnew1");
    expect(stored.map(o => JSON.stringify(clean(o))).sort()).toEqual([future, markPlus].map(o => JSON.stringify(o)).sort());
    const ops = (await allOps()).filter(o => o.dev === "dnew1");
    const marks = foldMarks(ops, "bX", resolver(ops));
    expect(marks.map(m => [m.id, m.color])).toEqual([["mz", "blue"]]); // the known fields work, the unknown are left in the op
  });
});

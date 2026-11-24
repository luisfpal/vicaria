import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import { foldMarks, invariantProblem, validAnchor, COLORS, NOTE_MAX, type Mark } from "../src/core/marks";
import { createMark, updateMark, setNote, addTag, removeTag, removeMark, restoreMark, MarkError } from "../src/core/marks-io";
import { clean, hlcSend, hlcReceive, hlcReset, hlcState, newer, allOps, bookOps, mergeOps } from "../src/core/ops";
import type { Anchor, Op } from "../src/core/types";

const A = (block: number, offset = 0, len = 5): Anchor => ({ section: 1, block, offset, endBlock: block, endOffset: offset + len, exact: "x".repeat(len), prefix: "", suffix: "" });
const P = (block: number): Anchor => ({ section: 1, block, offset: 3, endBlock: block, endOffset: 3, exact: "", prefix: "", suffix: "" });
const op = (dev: string, n: number, t: number, v: Record<string, unknown>, k: Op["k"] = "mark", c?: number): Op => ({ id: `${dev}.${n}`, dev, t, ...(c ? { c } : {}), k, v });
const shuffle = <T,>(xs: T[], seed: number) => { const a = xs.slice(); let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = (ms: Mark[]) => JSON.stringify(ms);

describe("marks: merge rules", () => {
  it("a highlight with a note is one mark; color and note change independently on two devices", () => {
    const ops = [
      op("dev1", 1, 100, { id: "m", book: "b", set: { at: A(2), color: "yellow", made: 100 } }),
      op("dev1", 2, 200, { id: "m", book: "b", set: { color: "blue" } }),                // phone changes color
      op("dev2", 1, 150, { id: "m", book: "b", note: "laptop note", base: null }),        // laptop writes a note, offline
    ];
    const [m] = foldMarks(ops, "b");
    expect(m.color).toBe("blue"); expect(m.note).toBe("laptop note"); expect(m.conflicts).toEqual([]);
  });
  it("two offline edits of the same note keep both: newest shows, the other is a conflict copy until resolved", () => {
    const base = op("dev1", 1, 100, { id: "m", book: "b", set: { at: A(2), color: "yellow" }, note: "v1", base: null });
    const e1 = op("dev1", 2, 200, { id: "m", book: "b", note: "phone edit", base: "dev1.1" });
    const e2 = op("dev2", 1, 300, { id: "m", book: "b", note: "laptop edit", base: "dev1.1" });
    let [m] = foldMarks([base, e1, e2], "b");
    expect(m.note).toBe("laptop edit"); expect(m.conflicts.map(c => c.text)).toEqual(["phone edit"]);
    const fix = op("dev2", 2, 400, { id: "m", book: "b", note: "merged", base: "dev2.1", resolves: ["dev1.2"] });
    [m] = foldMarks([base, e1, e2, fix], "b");
    expect(m.note).toBe("merged"); expect(m.conflicts).toEqual([]);
  });
  it("editing a deleted mark does not bring it back; restore does", () => {
    const ops = [op("dev1", 1, 100, { id: "m", book: "b", set: { at: A(2), color: "pink" } }), op("dev1", 2, 200, { id: "m", book: "b", set: { gone: true } }), op("dev2", 1, 300, { id: "m", book: "b", set: { color: "green" } })];
    expect(foldMarks(ops, "b")[0].gone).toBe(true);
    expect(foldMarks([...ops, op("dev2", 2, 400, { id: "m", book: "b", set: { gone: false } })], "b")[0].gone).toBe(false);
  });
  it("a tag added on one device survives its concurrent removal on another (add/remove set)", () => {
    const ops = [
      op("dev1", 1, 100, { id: "m", book: "b", set: { at: A(2), color: "pink" } }),
      op("dev1", 2, 110, { id: "m", book: "b", tag: "stoic" }),
      op("dev2", 1, 120, { id: "m", book: "b", untag: ["dev1.2"] }),   // removal saw only the first add
      op("dev1", 3, 115, { id: "m", book: "b", tag: "stoic" }),         // concurrent re-add
    ];
    expect(foldMarks(ops, "b")[0].tags).toEqual(["stoic"]);
    expect(foldMarks(ops.slice(0, 3), "b")[0].tags).toEqual([]);
  });
  it("0.x and early highlights read as marks, and later mark ops change them", () => {
    const hl = op("dfixture1", 1, 100, { id: "h1", book: "b", anchor: A(3), color: "green", note: "old note", created: 90 }, "hl");
    const later = op("dev1", 1, 200, { id: "h1", book: "b", set: { loved: true } });
    const [m] = foldMarks([hl, later], "b");
    expect(m).toMatchObject({ id: "h1", color: "green", note: "old note", loved: true, made: 90, gone: false });
    const rm = op("dfixture1", 2, 300, { id: "h1", book: "b" }, "hl-");
    expect(foldMarks([hl, later, rm], "b")[0].gone).toBe(true);
  });
  it("invariants: a bookmark is a point without color; a sticky note needs text", () => {
    expect(invariantProblem({ at: A(1), bookmark: { name: "x" } })).toMatch(/point/);
    expect(invariantProblem({ at: P(1), bookmark: { name: "x" }, color: "yellow" })).toMatch(/color/);
    expect(invariantProblem({ at: A(1), sticky: { side: "r", tint: "yellow" } })).toMatch(/text/);
    expect(invariantProblem({ at: P(1), bookmark: { name: "Chapter I, the plan" } })).toBeNull();
  });
  it("ordering uses the hybrid clock, then op id", () => {
    expect(newer(op("aaaa", 1, 5, {}, "mark", 2), op("zzzz", 1, 5, {}, "mark", 1))).toBe(true);
    expect(newer(op("zzzz", 1, 5, {}), op("aaaa", 1, 5, {}))).toBe(true);
  });
});

// ---- property tests: any order, any duplication, any split between replicas gives the same marks ----
const DEVS = ["dev1", "dev2", "dev3"];
const arbOps = fc.array(fc.record({
  dev: fc.constantFrom(...DEVS), t: fc.integer({ min: 1, max: 50 }), c: fc.integer({ min: 0, max: 3 }), id: fc.constantFrom("m1", "m2", "m3"),
  what: fc.oneof(
    fc.record({ kind: fc.constant("set"), color: fc.constantFrom(...COLORS), block: fc.integer({ min: 0, max: 4 }) }),
    fc.record({ kind: fc.constant("note"), text: fc.string({ maxLength: 8 }), baseIdx: fc.integer({ min: -1, max: 30 }) }),
    fc.record({ kind: fc.constant("tag"), tag: fc.constantFrom("a", "b") }),
    fc.record({ kind: fc.constant("untag"), idx: fc.integer({ min: 0, max: 30 }) }),
    fc.record({ kind: fc.constant("gone"), gone: fc.boolean() }),
    fc.record({ kind: fc.constant("hl"), color: fc.constantFrom(...COLORS) }),
    fc.record({ kind: fc.constant("hl-") }),
  ),
}), { maxLength: 30 }).map(list => {
  const n: Record<string, number> = {}; const out: Op[] = [];
  for (const x of list) {
    n[x.dev] = (n[x.dev] || 0) + 1;
    const w = x.what as Record<string, unknown>; const id = `${x.dev}.${n[x.dev]}`;
    const prev = (i: number) => out[i % Math.max(1, out.length)]?.id;
    let o: Op;
    if (w.kind === "set") o = { id, dev: x.dev, t: x.t, c: x.c || undefined, k: "mark", v: { id: x.id, book: "b", set: { at: A(w.block as number), color: w.color } } };
    else if (w.kind === "note") o = { id, dev: x.dev, t: x.t, k: "mark", v: { id: x.id, book: "b", note: w.text, base: (w.baseIdx as number) < 0 || !out.length ? null : prev(w.baseIdx as number) } };
    else if (w.kind === "tag") o = { id, dev: x.dev, t: x.t, k: "mark", v: { id: x.id, book: "b", tag: w.tag } };
    else if (w.kind === "untag") o = { id, dev: x.dev, t: x.t, k: "mark", v: { id: x.id, book: "b", untag: out.length ? [prev(w.idx as number)!] : [] } };
    else if (w.kind === "gone") o = { id, dev: x.dev, t: x.t, k: "mark", v: { id: x.id, book: "b", set: { gone: w.gone } } };
    else if (w.kind === "hl") o = { id, dev: x.dev, t: x.t, k: "hl", v: { id: x.id, book: "b", anchor: A(1), color: w.color } };
    else o = { id, dev: x.dev, t: x.t, k: "hl-", v: { id: x.id, book: "b" } };
    if (o.c === undefined) delete o.c;
    out.push(o);
  }
  return out;
});

describe("marks: properties", () => {
  it("folding does not depend on order or duplicates (commutative, associative, idempotent)", () => {
    fc.assert(fc.property(arbOps, fc.integer(), (ops, seed) => {
      const a = norm(foldMarks(ops, "b"));
      const b = norm(foldMarks(shuffle([...ops, ...ops.slice(0, seed % (ops.length + 1))], seed), "b"));
      expect(b).toBe(a);
    }), { numRuns: 400 });
  });
  it("two replicas that saw different subsets agree once they exchange everything", () => {
    fc.assert(fc.property(arbOps, fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }), (ops, mask) => {
      const r1 = ops.filter((_, i) => mask[i]), r2 = ops.filter((_, i) => !mask[i] || i % 3 === 0);
      const merged1 = [...r1, ...r2], merged2 = [...r2, ...r1];
      expect(norm(foldMarks(merged1, "b"))).toBe(norm(foldMarks(merged2, "b")));
    }), { numRuns: 300 });
  });
  it("junk in ops never throws and never yields an invalid mark (fuzz)", () => {
    fc.assert(fc.property(fc.array(fc.record({ id: fc.string(), dev: fc.string(), t: fc.double(), k: fc.constantFrom("mark", "hl", "hl-", "card", "pos"), v: fc.anything() })), raw => {
      const ops = raw.map(r => clean({ ...r, id: `abcd.${r.id}`, dev: "abcd" })).filter((o): o is Op => !!o);
      for (const m of foldMarks(ops)) {
        if (m.at) expect(validAnchor(m.at)).toBe(true);
        if (m.color) expect(COLORS).toContain(m.color);
        expect(Array.isArray(m.tags)).toBe(true);
      }
    }), { numRuns: 400 });
  });
});

describe("hybrid logical clock", () => {
  beforeEach(() => hlcReset());
  it("never goes backwards, even when the wall clock does", () => {
    const a = hlcSend(1000), b = hlcSend(900), c = hlcSend(900);
    expect([a, b, c].map(x => [x.p, x.l])).toEqual([[1000, 0], [1000, 1], [1000, 2]]);
  });
  it("moves past times seen from other devices, but not more than 5 minutes into the future", () => {
    hlcReceive(5000, 3, 1000); expect(hlcState()).toEqual({ p: 5000, l: 4 });
    hlcReset(); hlcReceive(1e13, 0, 1000); expect(hlcState().p).toBe(1000 + 5 * 60_000);
  });
});

describe("marks: writing", () => {
  it("creates, edits, tags, deletes and restores, all through the log, and opens per book through the index", async () => {
    const op1 = await createMark("bookA", { at: A(4), color: "yellow" }, { note: "first" });
    let [m] = foldMarks(await bookOps("bookA"), "bookA");
    expect(m).toMatchObject({ id: op1.id, color: "yellow", note: "first" });
    await updateMark(m, { color: "purple", loved: true });
    await setNote(m, "second");
    [m] = foldMarks(await bookOps("bookA"), "bookA");
    await addTag(m, "idea"); await addTag(m, "idea");
    [m] = foldMarks(await bookOps("bookA"), "bookA");
    expect(m.tags).toEqual(["idea"]);
    await removeTag(m, "idea");
    await removeMark(m);
    [m] = foldMarks(await bookOps("bookA"), "bookA");
    expect(m).toMatchObject({ color: "purple", loved: true, note: "second", tags: [], gone: true });
    await restoreMark(m);
    expect(foldMarks(await bookOps("bookA"), "bookA")[0].gone).toBe(false);
    expect(foldMarks(await bookOps("bookB"), "bookB")).toEqual([]);
    expect((await allOps()).every(o => !("bk" in o))).toBe(true);
  });
  it("refuses a note over 64 KiB, a bookmark on a passage, and a sticky without text", async () => {
    await expect(createMark("b", { at: A(1), color: "yellow" }, { note: "é".repeat(NOTE_MAX / 2 + 1) })).rejects.toThrow(MarkError);
    await expect(createMark("b", { at: A(1), bookmark: { name: "x" } })).rejects.toThrow(/point/);
    await expect(createMark("b", { at: A(1), sticky: { side: "r", tint: "yellow" } })).rejects.toThrow(/text/);
    const ok = await createMark("b", { at: A(1), color: "green" }, { note: "é".repeat(NOTE_MAX / 2) });
    expect(ok.id).toBeTruthy();
  });
  it("a 0.x book's ops are found under its new id through the alias", async () => {
    await mergeOps([
      { id: "dold1.1", dev: "dold1", t: 10, k: "alias", v: { old: "meditations", book: "newid", sha256: "x" } },
      { id: "dold1.2", dev: "dold1", t: 11, k: "hl", v: { id: "h9", anchor: A(2), color: "blue" }, b: "meditations" },
    ]);
    expect(foldMarks(await bookOps("newid"), "newid").map(m => m.id)).toEqual(["h9"]);
  });
});

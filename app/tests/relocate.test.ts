// Marks made against one reading of a book, found again after the book is read differently (a new parser version
// renumbers blocks, splits them, or changes a few characters). Real book text, random marks, random re-readings.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { parseEpub } from "../src/core/epub";
import { blockTexts, relocate, textAt, type BlockText } from "../src/core/reanchor";
import { foldMarks } from "../src/core/marks";
import { resolver } from "../src/core/ops";
import { markdownFor } from "../src/core/export";
import type { Anchor, Op } from "../src/core/types";

const CORPUS = new URL("../../tests/corpus/", import.meta.url).pathname;
const blocksOf = async (f: string) => (await parseEpub(new Uint8Array(readFileSync(CORPUS + f)))).doc.sections.slice(0, 30).flatMap(s => blockTexts(s.idx, s.html));
const lab = (t: string) => new Uint8Array(t.length);
const anchorIn = (b: BlockText, s: number, e: number): Anchor => ({ section: b.section, block: b.block, offset: s, endBlock: b.block, endOffset: e, exact: b.text.slice(s, e), prefix: b.text.slice(Math.max(0, s - 32), s), suffix: b.text.slice(e, e + 32) });

// re-readings: 0 renumber (a new block at the start of each section), 1 split long blocks in two, 2 curly quotes
// become straight ones, 3 all three
function reread(blocks: BlockText[], how: number): BlockText[] {
  let out = blocks.map(b => ({ ...b }));
  if (how === 1 || how === 3) out = out.flatMap(b => {
    const cut = b.text.indexOf(". ", Math.floor(b.text.length / 2));
    return cut > 0 && b.text.length > 300 ? [{ ...b, text: b.text.slice(0, cut + 1), label: lab(b.text.slice(0, cut + 1)) }, { ...b, block: b.block + 0.5, text: b.text.slice(cut + 2), label: lab(b.text.slice(cut + 2)) }] : [b];
  });
  if (how === 2 || how === 3) out = out.map(b => { const t = b.text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"'); return { ...b, text: t, label: lab(t) }; });
  // renumber blocks 0..n per section (the split above used halves), adding a heading block when asked
  const bySec = new Map<number, BlockText[]>(); for (const b of out) (bySec.get(b.section) || bySec.set(b.section, []).get(b.section)!).push(b);
  const res: BlockText[] = [];
  for (const [sec, bs] of bySec) {
    const head = how === 0 || how === 3 ? [{ section: sec, block: 0, text: "Chapter heading", label: lab("Chapter heading") }] : [];
    [...head, ...bs.sort((x, y) => x.block - y.block)].forEach((b, i) => res.push({ ...b, block: i }));
  }
  return res;
}
const norm = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();

describe("relocate", () => {
  it("keeps an anchor that still points at its words (same object)", async () => {
    const bs = await blocksOf("meditations-se.epub");
    const b = bs.find(x => x.text.length > 200)!;
    const a = anchorIn(b, 10, 60);
    expect(relocate(bs, a)).toBe(a);
    const point = anchorIn(b, 40, 40);
    expect(relocate(bs, point)).toBe(point);
  });

  for (const file of ["meditations-se.epub", "pg2000.epub"]) it(`finds marks again after the book is read differently (${file})`, async () => {
    const orig = await blocksOf(file);
    const long = orig.filter(b => b.text.length > 80);
    const views = [0, 1, 2, 3].map(h => reread(orig, h));
    fc.assert(fc.property(fc.nat(long.length - 1), fc.nat(10_000), fc.nat(200), fc.integer({ min: 0, max: 3 }), fc.boolean(), (bi, s0, len, how, point) => {
      const b = long[bi], s = s0 % (b.text.length - 5), e = point ? s : Math.min(b.text.length, s + 5 + len);
      const a = anchorIn(b, s, e);
      if (!point && norm(a.exact).length < 4) return;
      const r = relocate(views[how], a);
      expect(r, JSON.stringify(a)).not.toBeNull();
      if (point) {
        // a point lands where the words after it begin (or right after the words before it)
        const nb = views[how].find(x => x.section === r!.section && x.block === r!.block)!;
        const after = norm(nb.text.slice(r!.offset, r!.offset + 12)), before = norm(nb.text.slice(Math.max(0, r!.offset - 12), r!.offset));
        expect(norm(a.suffix).startsWith(after) || norm(a.prefix).endsWith(before), JSON.stringify({ a, after, before })).toBe(true);
      } else {
        expect(norm(textAt(views[how], r!)!)).toBe(norm(a.exact));
        expect(r!.section).toBe(a.section);
      }
    }), { numRuns: 250, seed: 11 });
  }, 120_000);

  it("tells repeated words apart by their surroundings", () => {
    const t1 = "First part. The refrain goes here. More words that differ in the first stanza.";
    const t2 = "Second part. The refrain goes here. Other words follow in the second stanza.";
    const bs: BlockText[] = [t1, t2].map((text, i) => ({ section: 0, block: i, text, label: lab(text) }));
    const a = anchorIn(bs[1], t2.indexOf("The refrain"), t2.indexOf("The refrain") + "The refrain goes here.".length);
    const moved = [{ section: 0, block: 0, text: "Preface.", label: lab("Preface.") }, ...bs.map(b => ({ ...b, block: b.block + 1 }))];
    const r = relocate(moved, a)!;
    expect(r.block).toBe(2);
    expect(textAt(moved, r)).toBe("The refrain goes here.");
  });

  it("returns null when the words are gone", async () => {
    const bs = await blocksOf("meditations-se.epub");
    const all = norm(bs.map(x => x.text).join("\n"));
    // words found once, in the body (the front matter repeats its licence text nearly word for word, and a near
    // copy is a fair place to attach to)
    const b = bs.slice(bs.length >> 1).find(x => x.text.length > 200 && all.split(norm(x.text.slice(10, 90))).length === 2)!;
    const a = anchorIn(b, 10, 90);
    const without = bs.map(x => x === b ? { ...x, text: "Entirely new words replace this whole paragraph in the revised text.", label: lab("Entirely new words replace this whole paragraph in the revised text.") } : x);
    expect(relocate(without, a)).toBeNull();
  });

  it("the fold uses the re-found place, and keeps a lost mark with its old words", () => {
    const at: Anchor = { section: 1, block: 4, offset: 0, endBlock: 4, endOffset: 5, exact: "hello", prefix: "", suffix: " world" };
    const op = (id: string, set: object, t = 1): Op => ({ id, dev: "d", t, k: "mark", v: { id: "m" + id, book: "B", set: { at, color: "yellow", ...set }, p: 1 } });
    const ops = [op("1", {}), op("2", {})];
    const moved = { ...at, block: 7 };
    const ms = foldMarks(ops, "B", resolver(ops, new Map<string, Anchor | null>([["1", moved], ["2", null]])));
    expect(ms.find(m => m.id === "m1")!.at).toEqual(moved);
    const lost = ms.find(m => m.id === "m2")!;
    expect(lost.at).toBeUndefined(); expect(lost.lost).toEqual(at);
    expect(markdownFor({ id: "B", title: "T", author: "", sha256: "", toc: [] }, [lost])).toContain("## Not found in this edition\n\n> hello");
    // never re-checked: the op's own anchor
    expect(foldMarks(ops, "B").find(m => m.id === "m2")!.at).toEqual(at);
  });
});

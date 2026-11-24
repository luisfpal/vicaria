import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { align, fold, fuzzyFind } from "../src/core/fuzzy";

describe("fuzzy", () => {
  it("align finds an exact substring at distance 0", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (p, a, b) => {
      const r = align(p, a + p + b); expect(r.dist).toBe(0); expect((a + p + b).slice(r.start, r.end)).toBe(p);
    }), { numRuns: 300 });
  });
  it("align distance is at most the number of edits made", () => {
    fc.assert(fc.property(fc.string({ minLength: 5, maxLength: 60 }), fc.array(fc.nat(200), { maxLength: 4 }), (p, cuts) => {
      let q = p; for (const c of cuts) { const i = c % q.length; q = q.slice(0, i) + "#" + q.slice(i + 1); }
      expect(align(p, "xx " + q + " yy").dist).toBeLessThanOrEqual(cuts.length);
    }), { numRuns: 300 });
  });
  it("fold keeps length and evens out quotes, dashes and case", () => {
    expect(fold("\u201cHe\u2019s\u201d \u2014 Ok")).toBe("\"he's\" - ok");
    fc.assert(fc.property(fc.string({ maxLength: 50 }), s => { expect(fold(s).length).toBe(s.length); }));
  });
  it("finds a quote after small edits, and refuses ambiguous or missing ones", () => {
    const text = "It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith slipped quickly through the glass doors.";
    const h = fuzzyFind(text, "the clocks were strikng thirteen")!;
    expect(text.slice(h.start, h.end)).toMatch(/the clocks were striking thirteen/);
    expect(fuzzyFind(text, "a completely different sentence here")).toBeNull();
    const twice = "the same words appear here. and the same words appear here.";
    expect(fuzzyFind(twice, "the same words appear here")).toBeNull();
    expect(fuzzyFind(twice, "the same words appear here", { expected: 30 })!.start).toBeGreaterThan(20);
  });
});

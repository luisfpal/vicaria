import { describe, expect, it } from "vitest";
import { fraction, shown } from "../src/core/progress";

describe("reading progress", () => {
  const blocks = [10, 30, 60]; // 100 blocks in three sections
  it("counts the blocks before the place over all blocks", () => {
    expect(fraction(blocks, 0, 0)).toBe(0);
    expect(fraction(blocks, 1, 15)).toBeCloseTo(0.25);
    expect(fraction(blocks, 2, 60)).toBe(1);
  });
  it("clamps a block past the end of its section and a section past the end", () => {
    expect(fraction(blocks, 0, 999)).toBeCloseTo(0.1);
    expect(fraction(blocks, 7, 0)).toBe(1);
    expect(fraction(blocks, -1, -5)).toBe(0);
  });
  it("falls back to sections for a book with no blocks", () => {
    expect(fraction([0, 0, 0, 0, 0], 2, 0)).toBeCloseTo(0.5);
    expect(fraction([], 3, 3)).toBe(0);
  });
  it("shows nothing for a glance and full near the end", () => {
    expect(shown(undefined)).toBe(0);
    expect(shown(0.01)).toBe(0);
    expect(shown(0.4)).toBe(0.4);
    expect(shown(0.97)).toBe(1);
  });
});

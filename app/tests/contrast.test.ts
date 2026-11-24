import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { ratio, hex, worstContrast, dimFor, spread, AA, MAX_SPREAD, type RGB } from "../src/core/contrast";

describe("contrast", () => {
  it("matches WCAG reference values", () => {
    expect(ratio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(ratio(hex("#777"), hex("#fff"))).toBeCloseTo(4.48, 2);
    expect(ratio(hex("#1f1d1a"), hex("#f7f4ee"))).toBeGreaterThan(14);
  });
  it("calms a checkerboard but leaves a flat color alone", () => {
    const ink = hex("#1f1d1a"), paper = hex("#f7f4ee");
    const checker: RGB[] = Array.from({ length: 64 }, (_, i) => (i + (i >> 3)) % 2 ? [0, 0, 0] : [255, 255, 255]);
    expect(spread(checker, paper, 0)).toBeGreaterThan(0.3);
    expect(dimFor(checker, ink, paper)).toBeGreaterThan(0.8);
    expect(dimFor([[240, 238, 230]], ink, paper)).toBe(0);
  });
  it("finds the least dim that reaches AA, for any picture and theme (property)", () => {
    const rgb = fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)) as fc.Arbitrary<RGB>;
    const themes: [RGB, RGB][] = [[hex("#1f1d1a"), hex("#f7f4ee")], [hex("#e9e4da"), hex("#161513")], [hex("#3b2f22"), hex("#f1e6cf")]];
    fc.assert(fc.property(fc.array(rgb, { minLength: 1, maxLength: 64 }), fc.nat(2), (cells, t) => {
      const [ink, paper] = themes[t];
      const d = dimFor(cells, ink, paper);
      expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(1);
      expect(worstContrast(cells, ink, paper, d)).toBeGreaterThanOrEqual(AA - 1e-9);
      expect(spread(cells, paper, d)).toBeLessThanOrEqual(MAX_SPREAD + 1e-9);
      if (d >= 0.02) { const less = d - 0.02; expect(worstContrast(cells, ink, paper, less) < AA + 0.5 || spread(cells, paper, less) > MAX_SPREAD - 0.01).toBe(true); } // not much more dimming than needed
    }), { numRuns: 500 });
  });
});

// WCAG 2.x contrast for reading over a background picture. The picture is reduced to a small grid of colors (the
// same smoothing the blur gives); each is mixed with the page color at the dim level, and the darkest-for-the-text
// cell sets the contrast. AA for body text is 4.5:1.
export type RGB = [number, number, number];
export const AA = 4.5, AAA = 7;
const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function ratio(a: RGB, b: RGB) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
export const mix = (c: RGB, paper: RGB, dim: number): RGB => [0, 1, 2].map(i => c[i] * (1 - dim) + paper[i] * dim) as RGB;
export function hex(s: string): RGB {
  const h = s.trim().replace("#", "");
  const f = h.length === 3 ? h.split("").map(x => x + x).join("") : h.slice(0, 6);
  return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) || 0) as RGB;
}
// worst contrast of the text over the cells (5th percentile, so one stray pixel does not decide)
export function worstContrast(cells: RGB[], ink: RGB, paper: RGB, dim: number): number {
  if (!cells.length) return ratio(ink, paper);
  const rs = cells.map(c => ratio(ink, mix(c, paper, dim))).sort((a, b) => a - b);
  return rs[Math.floor(rs.length * 0.05)];
}
// how busy the picture still looks behind the text: standard deviation of perceived lightness (CIE L*, 0 to 1)
// after dimming; 0 is flat. Perceived, not linear, so dark themes are judged as fairly as light ones.
const lstar = (y: number) => (y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : y * 24389 / 27) / 100;
export function spread(cells: RGB[], paper: RGB, dim: number): number {
  if (!cells.length) return 0;
  const ls = cells.map(c => lstar(luminance(mix(c, paper, dim)))), m = ls.reduce((a, b) => a + b, 0) / ls.length;
  return Math.sqrt(ls.reduce((a, b) => a + (b - m) ** 2, 0) / ls.length);
}
export const MAX_SPREAD = 0.06; // a busy pattern (a checkerboard is about 0.4) must calm down to this to read comfortably
// the least dimming that reaches `target` and calms the picture to MAX_SPREAD (dim 1 is the plain page, which always
// passes for our themes)
export function dimFor(cells: RGB[], ink: RGB, paper: RGB, target = AA, maxSpread = MAX_SPREAD): number {
  const ok = (d: number) => worstContrast(cells, ink, paper, d) >= target && spread(cells, paper, d) <= maxSpread;
  if (ok(0)) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return Math.ceil(hi * 100) / 100;
}

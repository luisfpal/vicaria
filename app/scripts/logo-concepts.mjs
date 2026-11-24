// The three V-graph concepts of docs/logo-concepts (viewBox 0 0 100 100, symmetric about x = 50) and a contact sheet
// that shows each at app-icon sizes. Run: node scripts/logo-concepts.mjs [sheet.png]
import { writeFileSync } from "node:fs";
export const INK = "#1c1a17", IVORY = "#f7f4ee", ACCENT = "#b4532a";
// A concept: nodes [x, y, r, kind], edges by node index, stroke width. kind "a" is the accent node.
export const CONCEPTS = {
  // a: the reference mark, made exact. Arms run straight through the joints (collinear), the bar closes a triangle of
  // negative space, the vertex node is a little larger because a point at the end of two lines looks lighter.
  "a-bar": { stroke: 6.4, nodes: [[22, 18, 7.4], [78, 18, 7.4], [33.2, 44, 6.8], [66.8, 44, 6.8], [50, 82, 8.6, "a"]], edges: [[0, 2], [1, 3], [2, 3], [2, 4], [3, 4]] },
  // b: the bar sits low, close to the vertex: a small closed triangle (convergence) and long open arms (a passage in).
  "b-low": { stroke: 6.4, nodes: [[20, 16, 7.4], [80, 16, 7.4], [36.5, 56, 6.8], [63.5, 56, 6.8], [50, 86, 8.6, "a"]], edges: [[0, 2], [1, 3], [2, 3], [2, 4], [3, 4]] },
  // c: no bar. A pure V of five nodes with one more node floating in its mouth, joined to the two joints (emergence).
  "c-hub": { stroke: 6.4, nodes: [[22, 16, 7.4], [78, 16, 7.4], [33.5, 42, 6.4], [66.5, 42, 6.4], [50, 84, 8.6], [50, 30, 6.2, "a"]], edges: [[0, 2], [1, 3], [2, 4], [3, 4], [2, 5], [3, 5]] },
};
// the mark as SVG elements; ink, accent colours and an optional scale about the centre
export function mark(c, { ink = INK, accent = ACCENT } = {}) {
  const ns = c.nodes;
  const lines = c.edges.map(([a, b]) => `<line x1="${ns[a][0]}" y1="${ns[a][1]}" x2="${ns[b][0]}" y2="${ns[b][1]}"/>`).join("");
  const dots = ns.map(([x, y, r, k]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${k === "a" ? accent : ink}" stroke="none"/>`).join("");
  return `<g stroke="${ink}" stroke-width="${c.stroke}" stroke-linecap="round">${lines}</g>${dots}`;
}
export const tile = (c, { bg = IVORY, rx = 22, s = 1, ...o } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="${rx}" fill="${bg}"/><g transform="translate(${50 - 50 * s} ${50 - 50 * s}) scale(${s})">${mark(c, o)}</g></svg>`;
if (process.argv[1].endsWith("logo-concepts.mjs")) {
  const dir = new URL("../../docs/logo-concepts/", import.meta.url).pathname;
  for (const [n, c] of Object.entries(CONCEPTS)) writeFileSync(`${dir}${n}.svg`, tile(c, { s: 1 }));
  const { chromium } = await import("playwright");
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 760, height: 480 }, deviceScaleFactor: 1 });
  const row = (c) => [128, 64, 32, 16].map(z => `<div style="width:${z}px;height:${z}px">${tile(c, { s: 1 }).replace("<svg ", `<svg width="${z}" height="${z}" `)}</div>`).join("");
  p.setContent(`<body style="margin:0;background:#fff;font:12px sans-serif">${Object.entries(CONCEPTS).map(([n, c]) => `<div style="display:flex;align-items:center;gap:24px;padding:8px 16px"><span style="width:70px">${n}</span>${row(c)}</div>`).join("")}</body>`);
  await p.screenshot({ path: process.argv[2] || "/tmp/p13/sheet.png" }); await b.close();
}

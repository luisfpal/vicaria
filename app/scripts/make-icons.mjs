// Every icon from the one mark in logo-concepts.mjs (concept a-bar): the V of graph nodes, ink on warm ivory, the
// vertex node in the brand terracotta (where the lines converge: the reader). Writes the Tauri sources, the web icons
// and the two PNG copies used by the README and the Get page. The desktop and Android sizes come from the sources:
//   node scripts/make-icons.mjs && npx tauri icon src-tauri/icon-src/icon.json
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { CONCEPTS, mark, tile, INK, IVORY } from "./logo-concepts.mjs";
const C = CONCEPTS["a-bar"], root = new URL("../", import.meta.url).pathname, repo = root + "../";
const wrap = (size, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${inner}</svg>`;
// 1024 canvas. The mark is 100 units wide: scale k, centred. Android keeps the glyph inside the 66% safe circle.
const place = (k, o) => `<g transform="translate(${512 - 50 * k} ${512 - 50.6 * k}) scale(${k})">${mark(C, o)}</g>`;
const src = root + "src-tauri/icon-src/";
writeFileSync(src + "app-icon.svg", wrap(1024, `<rect x="100" y="100" width="824" height="824" rx="185" fill="${IVORY}"/>${place(6.2)}`));
writeFileSync(src + "bg.svg", wrap(1024, `<rect width="1024" height="1024" fill="${IVORY}"/>`));
writeFileSync(src + "fg.svg", wrap(1024, place(6.4)));
writeFileSync(src + "mono.svg", wrap(1024, place(6.4, { ink: "#000", accent: "#000" })));
writeFileSync(src + "icon.json", JSON.stringify({ default: "app-icon.svg", bg_color: IVORY, android_bg: "bg.svg", android_fg: "fg.svg", android_fg_scale: 100, android_monochrome: "mono.svg" }) + "\n");
const out = root + "public/icons/";
writeFileSync(out + "favicon.svg", tile(C, { rx: 22 }));
const b = await chromium.launch();
const png = async (path, size, markup) => {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<body style="margin:0;background:transparent">${markup.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
  await p.screenshot({ path, omitBackground: true }); await p.close();
};
await png(out + "favicon-32.png", 32, tile(C, { rx: 22 }));
await png(out + "apple-touch-icon.png", 180, tile(C, { rx: 0, s: 0.84 }));
await png(out + "icon-192.png", 192, tile(C, { rx: 22 }));
await png(out + "icon-512.png", 512, tile(C, { rx: 22 }));
await png(out + "maskable-512.png", 512, tile(C, { rx: 0, s: 0.78 }));
await png(repo + "docs/media/icon.png", 512, tile(C, { rx: 22 }));
await png(repo + "get/media/icon.png", 128, tile(C, { rx: 22 }));
await b.close();
void INK;

// Shrinks the screenshots from e2e/demo-shots.mjs for the README, the Get page and the store listings: desktop to 1600 px
// wide, phone to 780 px, JPEG. Usage: node scripts/media.mjs <pngDir> <outDir>
import { chromium } from "playwright";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const [IN, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch(), p = await b.newPage();
for (const f of readdirSync(IN).filter(f => f.endsWith(".png"))) {
  const w = /phone/.test(f) ? 780 : 1600;
  const url = await p.evaluate(async ({ src, w }) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement("canvas"); c.width = w; c.height = Math.round(img.height * w / img.width);
    const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.86);
  }, { src: "data:image/png;base64," + readFileSync(`${IN}/${f}`).toString("base64"), w });
  writeFileSync(`${OUT}/${f.replace(/\.png$/, ".jpg")}`, Buffer.from(url.split(",")[1], "base64"));
}
await b.close();

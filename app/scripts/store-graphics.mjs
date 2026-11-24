// Store listing images (fastlane/metadata/android/<locale>/images): the 512 px icon, the 1024 x 500 feature graphic
// (the mark, the promise, two phone screens) and eight phone screenshots, from docs/media.
// Usage: node scripts/store-graphics.mjs   (run after e2e/demo-shots.mjs and scripts/media.mjs)
import { chromium } from "playwright";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
const root = new URL("../../", import.meta.url).pathname;
const media = root + "docs/media/";
const TEXT = { "en-US": ["Read a book,", "ask it anything,", "keep what it taught you."], "es-ES": ["Lee un libro,", "pregúntale lo que quieras", "y conserva lo que te enseñó."] };
const uri = f => "data:image/jpeg;base64," + readFileSync(media + f).toString("base64");
const icon = "data:image/png;base64," + readFileSync(media + "icon.png").toString("base64");
const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1024, height: 500 } });
for (const [loc, lines] of Object.entries(TEXT)) {
  const dir = `${root}fastlane/metadata/android/${loc}/images/`;
  rmSync(dir + "phoneScreenshots", { recursive: true, force: true }); // the old set had other names
  mkdirSync(dir + "phoneScreenshots", { recursive: true });
  copyFileSync(media + "icon.png", dir + "icon.png");
  ["library", "reader", "marks", "ask", "card", "ideas", "places", "listen"].forEach((n, i) => copyFileSync(`${media}${n}-phone-light.jpg`, `${dir}phoneScreenshots/${i + 1}-${n}.jpg`));
  await p.setContent(`<body style="margin:0;width:1024px;height:500px;background:#b4532a;overflow:hidden;position:relative;font-family:Georgia,serif;color:#f7f4ee">
    <img src="${icon}" style="position:absolute;left:56px;top:56px;width:84px;height:84px;border-radius:19px">
    <div style="position:absolute;left:56px;top:176px;font-size:40px;line-height:1.2;font-weight:700;width:520px">${lines.join("<br>")}</div>
    <div style="position:absolute;left:56px;top:420px;font:600 20px system-ui,sans-serif;opacity:.85">Vicaria</div>
    <img src="${uri("ask-phone-light.jpg")}" style="position:absolute;left:620px;top:44px;width:190px;border-radius:18px;box-shadow:0 8px 30px rgba(0,0,0,.35)">
    <img src="${uri("ideas-phone-light.jpg")}" style="position:absolute;left:830px;top:96px;width:190px;border-radius:18px;box-shadow:0 8px 30px rgba(0,0,0,.35)"></body>`);
  await p.screenshot({ path: dir + "featureGraphic.png" });
}
await b.close();

// Reading backgrounds: presets and a photo, dimmed until the text meets AA, drawn after the text, kept per device.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
const b = await chromium.launch();
let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: label === "phone" ? 3 : 1, hasTouch: label === "phone" });
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  await p.goto(BASE + "/");
  await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  await p.goto(`${BASE}/book/${id}`); await p.locator(".prose [data-b]").first().waitFor();
  await p.locator('[aria-label="Text settings"]').click();
  // a dark preset on the light theme: the text must still reach AA
  await p.locator('.swb[aria-label="Dusk"]').click();
  await p.locator(".readbg .img").waitFor({ timeout: 3000 }).catch(() => fail(`${label}: preset not drawn`));
  const st = await p.locator(".bgpick .contrast").innerText();
  const c = parseFloat(st.match(/([\d.]+):1/)?.[1] || "0"); if (c < 4.5) fail(`${label}: contrast ${st}`);
  // turning off "keep readable" and dimming to 0 must warn
  await p.locator(".bgpick input[type=checkbox]").first().uncheck();
  await p.locator(".bgpick input[type=range]").first().fill("0");
  const warn = await p.locator(".bgpick .contrast").innerText(); if (!/below AA/.test(warn)) fail(`${label}: no warning at dim 0 (${warn})`);
  await p.locator(".bgpick input[type=checkbox]").first().check();
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/bg_${label}_panel.png` }); }
  await p.locator(".panel .ptop .icon").click();
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/bg_${label}_dusk.png` });
  // a photo: a busy black and white pattern, the hardest case
  const png = await p.evaluate(() => { const c = document.createElement("canvas"); c.width = 400; c.height = 600; const g = c.getContext("2d"); for (let y = 0; y < 600; y += 20) for (let x = 0; x < 400; x += 20) { g.fillStyle = (x + y) % 40 ? "#000" : "#fff"; g.fillRect(x, y, 20, 20); } g.fillStyle = "#c33"; g.beginPath(); g.arc(200, 300, 120, 0, 7); g.fill(); return c.toDataURL("image/png").split(",")[1]; });
  await p.locator('[aria-label="Text settings"]').click();
  await p.locator(".swb.photo input").setInputFiles({ name: "pattern.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await p.waitForFunction(() => document.querySelector(".readbg .img")?.style.backgroundImage.startsWith('url("blob:'), null, { timeout: 5000 }).catch(() => fail(`${label}: photo not drawn`));
  const st2 = await p.locator(".bgpick .contrast").innerText(); const c2 = parseFloat(st2.match(/([\d.]+):1/)?.[1] || "0"); if (c2 < 4.5) fail(`${label}: photo contrast ${st2}`);
  await p.locator(".panel .ptop .icon").click();
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/bg_${label}_photo.png` });
  // after a reload: the text comes first, then the photo layer
  await p.reload();
  const order = await p.evaluate(() => new Promise(ok => { const t0 = performance.now(); const tick = () => { const text = !!document.querySelector(".prose [data-b]"), layer = !!document.querySelector(".readbg"); if (layer) return ok(text ? "text first" : "layer first"); if (performance.now() - t0 > 5000) return ok("no layer"); requestAnimationFrame(tick); }; tick(); }));
  if (order !== "text first") fail(`${label}: ${order}`);
  // dark theme: the veil follows the page color and contrast still passes
  await p.locator('[aria-label="Text settings"]').click();
  await p.locator(".type .chip", { hasText: "Dark" }).click();
  const st3 = await p.locator(".bgpick .contrast").innerText(); const c3 = parseFloat(st3.match(/([\d.]+):1/)?.[1] || "0"); if (c3 < 4.5) fail(`${label}: dark theme contrast ${st3}`);
  await p.locator(".panel .ptop .icon").click();
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/bg_${label}_photo_dark.png` });
  // following another device: its newer choice (a preset) applies here, but never replaces this device's photo
  const putBg = (n) => p.evaluate(n => new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => { const t = r.result.transaction("ops", "readwrite"); t.objectStore("ops").put({ id: `otherdev.${n}`, dev: "otherdev", t: Date.now(), c: 0, k: "bg", v: { kind: "preset", preset: "sea", dim: 0.4, blur: 10, auto: true } }); t.oncomplete = () => { r.result.close(); ok(); }; }; }), n);
  // this device shows its own photo: a newer preset from another device leaves it alone
  await p.evaluate(() => { const b = JSON.parse(localStorage.getItem("vic:bg")); b.sync = true; b.t = Date.now() - 1000; localStorage.setItem("vic:bg", JSON.stringify(b)); });
  await putBg(1);
  await p.reload(); await p.locator(".prose [data-b]").first().waitFor(); await p.waitForTimeout(3500);
  if (JSON.parse(await p.evaluate(() => localStorage.getItem("vic:bg"))).kind !== "photo") fail(`${label}: another device's preset replaced this device's photo`);
  // without a photo here, the newer preset applies
  await p.evaluate(() => { const b = JSON.parse(localStorage.getItem("vic:bg")); b.kind = "none"; b.t = Date.now() - 1000; localStorage.setItem("vic:bg", JSON.stringify(b)); });
  await putBg(2);
  await p.reload(); await p.locator(".prose [data-b]").first().waitFor();
  await p.waitForFunction(() => JSON.parse(localStorage.getItem("vic:bg")).preset === "sea", null, { timeout: 5000 }).catch(() => fail(`${label}: synced background not applied`));
  if (errors.length) fail(`${label}: page errors ${errors.join(" | ")}`);
  console.log(`${label}: dusk ${c}:1, photo ${c2}:1, dark ${c3}:1, ${order}`);
  await ctx.close();
}
await b.close();
if (failed) { console.error("background e2e FAILED"); process.exit(1); }
console.log("background e2e passed");

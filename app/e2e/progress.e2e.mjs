// Reading progress on the library card: none before reading, a bar that matches where the reader stopped after.
import { chromium } from "playwright";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const b = await chromium.launch();
let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport, hasTouch: label === "phone" });
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  await p.goto(BASE + "/");
  await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  await p.locator(".book-card").first().waitFor();
  if (await p.locator(".book-card .prog").count()) fail(`${label}: a bar before any reading`);
  await p.goto(`${BASE}/book/${id}?s=4&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  await p.waitForFunction(() => !!localStorage.getItem("vic:progress"), null, { timeout: 5000 }).catch(() => fail(`${label}: progress not stored`));
  await p.goto(BASE + "/"); await p.locator(".book-card").first().waitFor();
  const bar = p.locator(".book-card .prog").first();
  if (!await bar.count()) fail(`${label}: no bar after reading`);
  else {
    const w = await bar.locator("i").evaluate(e => e.getBoundingClientRect().width / e.parentElement.getBoundingClientRect().width), stored = await p.evaluate(i => JSON.parse(localStorage.getItem("vic:progress"))[i], id);
    if (Math.abs(w - stored) > 0.02) fail(`${label}: bar ${w} but stored ${stored}`);
    if (!/^\d+% read$/.test(await bar.getAttribute("aria-label"))) fail(`${label}: label ${await bar.getAttribute("aria-label")}`);
    console.log(`${label}: bar at ${Math.round(w * 100)}%`);
  }
  if (errors.length) fail(`${label}: page errors ${errors.join("; ")}`);
  await ctx.close();
}
await b.close();
if (failed) { console.error(`failures (${failed})`); process.exit(1); }
console.log("progress e2e passed");

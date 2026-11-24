// Import time per corpus book in real Chromium (parse in the worker, store, then the reader shows text).
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { serve } from "./serve.mjs";
const C = new URL("../../tests/corpus/", import.meta.url).pathname;
const files = ["meditations-se.epub", "pg132.epub", "pg2000.epub", "idpf-linear-algebra.epub", "idpf-regime-anticancer-arabic.epub", "idpf-sous-le-vent.epub", "idpf-internallinks.epub", "idpf-kusamakura-japanese-vertical-writing.epub"];
const PORT = 47900 + Math.floor(Math.random() * 90), BASE = "/vicaria/next";
const server = await serve(new URL("../dist/", import.meta.url).pathname, PORT, BASE);
const browser = await chromium.launch();
const out = {};
for (const rate of [1]) { // CDP CPU throttling does not reach workers, so only real speed is reported here
  for (const f of files) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await page.goto(`http://127.0.0.1:${PORT}${BASE}/`); await page.waitForSelector(".shelf, a.book-card", { timeout: 30000 });
      await page.evaluate(() => localStorage.setItem("vic:classic", "done"));
      await page.waitForTimeout(300);
      await page.evaluate(() => document.querySelector("input[type=file]").addEventListener("change", () => { window.__t0 = performance.now(); }, { capture: true }));
      await page.setInputFiles("input[type=file]", C + f);
      const ms = await page.waitForFunction(() => { const m = performance.getEntriesByName("vic:book").pop(); return window.__t0 && m && m.startTime > window.__t0 && m.startTime - window.__t0; }, null, { timeout: 60000, polling: 50 }).then(h => h.jsonValue());
      runs.push(Math.round(ms));
      await ctx.close();
    }
    runs.sort((a, b) => a - b);
    const mb = (readFileSync(C + f).length / 1e6).toFixed(1);
    out[`${f}@cpu${rate}x`] = { median_ms: runs[1], runs, mb };
    console.log(`cpu ${rate}x  ${f.padEnd(48)} ${mb.padStart(5)} MB  ${String(runs[1]).padStart(5)} ms  ${JSON.stringify(runs)}`);
  }
}
await browser.close(); server.close();
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");

import { chromium } from "playwright";
const BASE = process.argv[2];
const b = await chromium.launch(); const out = [];
for (let i = 0; i < 3; i++) {
  const ctx = await b.newContext(); const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await p.goto(BASE); await p.waitForSelector(".book-card", { timeout: 120000 }); await p.waitForTimeout(3000);
  let t0 = Date.now(); await p.goto(BASE + "book/meditations/3?tab=read"); await p.waitForFunction(() => (document.querySelector("article.prose")?.textContent?.length ?? 0) > 500, null, { timeout: 120000 });
  const firstOpen = Date.now() - t0;
  t0 = Date.now(); await p.goto(BASE + "book/meditations/4?tab=read"); await p.waitForFunction(() => (document.querySelector("article.prose")?.textContent?.length ?? 0) > 500, null, { timeout: 120000 });
  const nextChapter = Date.now() - t0;
  t0 = Date.now(); await p.goto(BASE + "book/meditations/3?tab=read"); await p.waitForFunction(() => (document.querySelector("article.prose")?.textContent?.length ?? 0) > 500, null, { timeout: 120000 });
  out.push({ firstOpen, nextChapter, reopenCached: Date.now() - t0 }); await ctx.close();
}
await b.close(); console.log(JSON.stringify(out));

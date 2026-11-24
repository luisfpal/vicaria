import { chromium } from "playwright";
const URL = process.argv[2] || "http://127.0.0.1:8790/vicaria/";
const runs = +process.argv[3] || 3;
const b = await chromium.launch();
const res = [];
for (let i = 0; i < runs; i++) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const row = {};
  for (const kind of ["cold", "warm"]) {
    const t0 = Date.now();
    await p.goto(URL, { waitUntil: "commit" });
    await p.waitForSelector(".book-card, .empty", { timeout: 120000 });
    const lib = Date.now() - t0;
    const fcp = await p.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null);
    row[kind] = { fcp: Math.round(fcp), libraryVisible: lib };
    await p.waitForTimeout(1500);
  }
  res.push(row); await ctx.close();
}
await b.close();
console.log(JSON.stringify(res));

// Measurement, not a CI test: how often a change reaches a device that is never online at the same time, through the
// public relays the app ships with (no local relay, no direct connection). Two browser profiles pair, then N rounds:
// A opens, makes a highlight, waits for the mailbox write, closes; B opens and must show the change.
// Prints the success rate and the delivery times. Usage: [QUICK=1] node e2e/relay-measure.mjs [rounds] [baseUrl]
import { chromium } from "playwright";
const N = +(process.argv[2] || 10), BASE = process.argv[3] || "http://127.0.0.1:47812/vicaria/next";
const b = await chromium.launch({ args: ["--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks"] });
const mk = async () => { const ctx = await b.newContext({ viewport: { width: 1100, height: 860 } }); return { ctx, p: await ctx.newPage() }; };
const ids = p => p.evaluate(() => new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => { const t = r.result.transaction(["ops", "segs"]); const out = []; t.objectStore("ops").getAll().onsuccess = e => out.push(...e.target.result.map(o => o.id)); t.objectStore("segs").getAll().onsuccess = e => { for (const s of e.target.result) out.push(...s.ops.map(o => o.id)); }; t.oncomplete = () => { r.result.close(); ok(out); }; }; }));
const logText = p => p.locator(".devices").innerText().catch(() => "");
const A = await mk(), B = await mk();
await A.p.goto(BASE + "/"); await A.p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
const classic = await A.p.evaluate(() => localStorage.getItem("vic:classic-id"));
await A.p.goto(BASE + "/settings"); await A.p.locator(".devices .btn", { hasText: "Pair a device" }).click();
const link = await A.p.locator('.devices input[aria-label="Pairing link"]').inputValue();
await B.p.goto(link); await B.p.locator(".devices .btn", { hasText: "Join" }).click();
await B.p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
await B.p.close(); await A.p.close();
const results = [];
for (let i = 0; i < N; i++) {
  A.p = await A.ctx.newPage();
  await A.p.goto(`${BASE}/book/${classic}`); await A.p.locator(".prose [data-b]").first().waitFor();
  if (process.env.QUICK) await A.p.waitForTimeout(8000); // sync is running before the change
  const before = new Set(await ids(A.p));
  const blk = await A.p.evaluate(i => { const els = [...document.querySelectorAll(".prose [data-b]")].filter(e => (e.textContent || "").length > 80); const el = els[i % els.length]; el.scrollIntoView({ block: "center" }); return +el.dataset.b; }, i);
  await A.p.evaluate(b => {
    const el = document.querySelector(`.prose [data-b="${b}"]`), w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), n = w.nextNode();
    const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, Math.min(20, n.data.length)); getSelection().removeAllRanges(); getSelection().addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, blk);
  await A.p.locator(".seltools .sw.blue").click();
  await A.p.waitForTimeout(500);
  const fresh = (await ids(A.p)).filter(x => !before.has(x));
  let savedOk = null; // QUICK=1: A is open 8 s, makes the change and closes 2.5 s later (the mailbox is written 1.5 s after a change)
  if (!process.env.QUICK) {
    await A.p.goto(BASE + "/settings");
    const saved = await A.p.locator(".devices", { hasText: /Saved on the relays|did not take/ }).waitFor({ timeout: 30000 }).then(() => true, () => false);
    await A.p.locator(".devices details summary").first().click().catch(() => {});
    const aText = await logText(A.p);
    savedOk = saved && /Saved on the relays/.test(aText);
  } else await A.p.waitForTimeout(2500);
  await A.p.close();
  B.p = await B.ctx.newPage(); const t0 = Date.now();

  await B.p.goto(BASE + "/settings");
  let ms = null;
  while (Date.now() - t0 < 60000 && !B.p.isClosed()) { const have = new Set(await ids(B.p)); if (fresh.length && fresh.every(x => have.has(x))) { ms = Date.now() - t0; break; } await B.p.waitForTimeout(500); }
  await B.p.close();
  results.push({ round: i + 1, saved: savedOk, ms });
  console.log(JSON.stringify(results.at(-1)));
}
const ok = results.filter(r => r.ms !== null), t = ok.map(r => r.ms).sort((a, b) => a - b);
console.log(JSON.stringify({ rounds: N, delivered: ok.length, rate: ok.length / N, medianMs: t[Math.floor(t.length / 2)] ?? null, maxMs: t.at(-1) ?? null, relays: "shipped list" }));
await b.close();

// Remove, undo, Recently removed, restore: the book comes back with its highlights.
import { chromium } from "./engine.mjs";
import { drawn, waitDrawn } from "./drawn.mjs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
const b = await chromium.launch(); let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport }); const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  // a highlight to carry through
  await p.goto(`${BASE}/book/${id}`); await p.locator(".prose [data-b]").first().waitFor();
  await p.evaluate(() => { const el = [...document.querySelectorAll(".prose [data-b]")].find(e => e.textContent.length > 80); const t = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode(); const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, Math.min(20, t.data.length)); getSelection().removeAllRanges(); getSelection().addRange(r); el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
  await p.locator(".seltools .sw.blue").click();
  if (!await waitDrawn(p, x => x.c === "blue")) fail(`${label}: highlight not made`);
  await p.goto(`${BASE}/settings`);
  const row = p.locator(".manage li").first();
  await row.getByRole("button", { name: "Remove" }).click(); await row.getByRole("button", { name: "Remove" }).click();
  await p.locator(".toast", { hasText: "Removed" }).waitFor();
  await p.locator(".toast button", { hasText: "Undo" }).click();
  await p.waitForFunction(() => document.querySelectorAll(".manage li").length >= 1 && !document.body.innerText.includes("Recently removed"), null, { timeout: 8000 }).catch(() => fail(`${label}: Undo did not bring the book back`));
  await p.locator(".manage li").first().getByRole("button", { name: "Remove" }).click(); await p.locator(".manage li").first().getByRole("button", { name: "Remove" }).click();
  await p.getByText("Recently removed").waitFor({ timeout: 5000 }).catch(() => fail(`${label}: Recently removed not shown`));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/shelf_${label}_removed.png`, fullPage: true });
  await p.goto(BASE + "/"); await p.waitForTimeout(400);
  if (await p.locator(`a.book-card[href$="${id}"]`).count()) fail(`${label}: removed book still on the shelf`);
  await p.goto(`${BASE}/settings`); await p.getByRole("button", { name: "Restore" }).click();
  await p.locator(".toast", { hasText: "is back" }).waitFor({ timeout: 8000 }).catch(() => fail(`${label}: restore failed`));
  await p.goto(`${BASE}/book/${id}`); await p.locator(".prose [data-b]").first().waitFor();
  if (!await waitDrawn(p, x => x.c === "blue", 5000)) fail(`${label}: highlight lost after restore`);
  if (errors.length) fail(`${label}: page errors ${errors.join(" | ")}`);
  console.log(`${label}: ok`); await ctx.close();
}
await b.close();
if (failed) { console.error("shelf e2e FAILED"); process.exit(1); }
console.log("shelf e2e passed");

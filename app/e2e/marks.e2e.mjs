// End to end: highlight in every color and style, note, sticky note, bookmarks (selection and ribbon), loved, tags,
// the marks panel with filters, remove and undo, reload keeps everything. Desktop and phone sizes, with screenshots.
// Usage: node e2e/marks.e2e.mjs [baseUrl] [shotsDir]
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { chromium } from "./engine.mjs";
import { drawn, waitDrawn, clickMark } from "./drawn.mjs";
import { mkdirSync } from "node:fs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
// the last line names every failure, so a log cut to its tail still says what went wrong
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
const b = await chromium.launch();
async function select(p, block, from, len) {
  await p.evaluate(b => { document.querySelector(`.prose [data-b="${b}"]`).scrollIntoView({ block: "center" }); }, block);
  await p.waitForTimeout(100);
  await p.evaluate(({ block, from, len }) => {
    const el = document.querySelector(`.prose [data-b="${block}"]`);
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, off = 0, s, e;
    while ((n = w.nextNode())) { const L = n.data.length; if (!s && from < off + L) s = [n, from - off]; if (!e && from + len <= off + L) { e = [n, from + len - off]; break; } off += L; }
    const r = document.createRange(); r.setStart(...s); r.setEnd(...e);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { block, from, len });
  await p.locator(".seltools").waitFor({ timeout: 3000 });
}
// "contrast" runs with prefers-contrast: more, where marks are drawn as elements instead of CSS highlights
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }], ["contrast", { width: 1280, height: 860 }]]) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: label === "phone" ? 3 : 1, hasTouch: label === "phone", contrast: label === "contrast" ? "more" : "no-preference" });
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  await p.goto(BASE + "/");
  await p.locator("a.book-card").first().waitFor();
  // wait for the starter classic to be imported, then open it
  await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  await p.goto(`${BASE}/book/${id}`);
  await p.locator(".prose [data-b]").first().waitFor();
  const blocks = await p.evaluate(() => [...document.querySelectorAll(".prose [data-b]")].filter(e => (e.textContent || "").length > 120).slice(0, 8).map(e => +e.dataset.b));
  if (blocks.length < 6) { fail(`${label}: not enough long paragraphs`); continue; }
  const colors = ["yellow", "green", "blue", "pink", "purple", "orange"];
  for (let i = 0; i < 6; i++) { await select(p, blocks[i % 3], 10 + (i % 2) * 50, 30); await p.locator(`.seltools .sw.${colors[i]}`).click(); if (!await waitDrawn(p, x => x.c === colors[i])) fail(`${label}: ${colors[i]} highlight not drawn`); }
  // style: underline on the first mark
  if (!await clickMark(p, { c: "yellow" })) fail(`${label}: no yellow mark to tap`);
  await p.locator(".popover.sheet").waitFor({ timeout: 3000 }).catch(() => fail(`${label}: tapping a highlight did not open it`));
  await p.locator('.popover.sheet .st.underline').click();
  if (!await waitDrawn(p, x => x.s === "underline")) fail(`${label}: underline style not drawn`);
  // note + tag + loved on it
  await p.locator(".popover.sheet textarea").fill("A long note.\n".repeat(40));
  await p.locator(".popover.sheet .tagin").fill("stoic"); await p.locator(".popover.sheet .tagin").press("Enter");
  await p.locator(".popover.sheet .chip", { hasText: "Loved" }).click();
  await p.locator(".popover.sheet .btn", { hasText: "Done" }).click();
  // typing a note and going straight to Done (which also blurs the box) writes it once
  const noteOps = () => p.evaluate(() => new Promise((ok, no) => { const r = indexedDB.open("vicaria"); r.onerror = no; r.onsuccess = () => { const q = r.result.transaction("ops").objectStore("ops").getAll(); q.onsuccess = () => { ok(q.result.filter(o => typeof o.v?.note === "string").length); r.result.close(); }; }; }));
  const before = await noteOps();
  if (!await clickMark(p, { c: "green" })) fail(`${label}: no green mark to tap`);
  await p.locator(".popover.sheet textarea").fill("Once.");
  await p.locator(".popover.sheet .btn", { hasText: "Done" }).click();
  await p.waitForTimeout(400);
  if (await noteOps() !== before + 1) fail(`${label}: one note was written ${await noteOps() - before} times`);
  // sticky note from a selection
  await select(p, blocks[4], 5, 20); await p.locator(".seltools button", { hasText: "Sticky" }).click();
  await p.locator(".popover.sheet textarea").fill("Remember this when rereading book two.");
  await p.locator(".popover.sheet .btn", { hasText: "Save" }).click();
  await p.locator(".stickycard").first().waitFor({ timeout: 3000 }).catch(async () => fail(`${label}: sticky note not in the margin ${await p.evaluate(() => JSON.stringify([...document.querySelectorAll(".stickycard")].map(e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height, getComputedStyle(e).display]; })))}`));
  // bookmark from a selection and from the ribbon
  await select(p, blocks[5], 0, 12); await p.locator(".seltools button", { hasText: "Bookmark" }).click();
  await p.locator(".toast", { hasText: "Bookmarked" }).waitFor({ timeout: 3000 }).catch(() => fail(`${label}: no bookmark toast`));
  await p.evaluate(() => scrollBy(0, 900)); await p.waitForTimeout(300);
  await p.locator('button[aria-label="Bookmark this page"]').click();
  await p.waitForTimeout(400);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await p.evaluate(b => document.querySelector(`.prose [data-b="${b}"]`).scrollIntoView({ block: "start" }), blocks[0]); await p.evaluate(() => scrollBy(0, -80)); await p.waitForTimeout(200); await p.screenshot({ path: `${SHOTS}/marks_${label}_page.png` }); }
  // panel: counts and filters
  await p.locator('button[aria-label="Marks"]').click();
  await p.locator(".marks .fchips").waitFor();
  const chipText = await p.locator(".marks .fchips").innerText();
  for (const want of ["All", "Highlight", "Idea", "Quote", "Question", "Word", "Important", "Notes", "Sticky", "Bookmarks", "Loved"]) if (!chipText.includes(want)) fail(`${label}: filter "${want}" missing in "${chipText.replace(/\n/g, " ")}"`);
  await p.locator(".marks .fchips .chip", { hasText: "Bookmarks" }).click();
  const bms = await p.locator(".marks .hits li").count();
  if (bms !== 2) fail(`${label}: ${bms} bookmarks listed, want 2`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/marks_${label}_panel.png` });
  await p.locator(".panel .ptop .icon").click();
  // remove the green highlight, undo
  await clickMark(p, { c: "green" });
  await p.locator(".popover.sheet .danger", { hasText: "Remove" }).click();
  await p.waitForTimeout(300);
  if ((await drawn(p)).some(x => x.c === "green")) fail(`${label}: green highlight still drawn after Remove`);
  await p.locator(".toast button", { hasText: "Undo" }).click();
  if (!await waitDrawn(p, x => x.c === "green")) fail(`${label}: Undo did not bring the highlight back`);
  // reload keeps all of it
  await p.reload(); await p.locator(".prose [data-b]").first().waitFor(); await p.waitForTimeout(500);
  await p.evaluate(b => document.querySelector(`.prose [data-b="${b}"]`).scrollIntoView(), blocks[0]);
  const d = await drawn(p);
  const after = { marks: d.length, sticky: await p.locator(".stickycard").count(), notes: d.filter(x => x.n).length, mode: await p.evaluate(() => (window.__vicPainted?.() ?? []).length ? "highlight" : "elements") };
  if (after.mode !== (label === "contrast" ? "elements" : "highlight")) fail(`${label}: marks drawn as ${after.mode}`);
  if (after.marks < 7 || after.sticky < 1 || after.notes < 2) fail(`${label}: after reload ${JSON.stringify(after)}`);
  // Places: bookmarks from every book, and one tap goes back to the spot
  await p.goto(`${BASE}/places`); await p.locator(".places").waitFor();
  await p.locator(".plist li").first().waitFor({ timeout: 4000 }).catch(() => fail(`${label}: Places is empty`));
  const nb = await p.locator(".plist li").count(); if (nb < 2) fail(`${label}: Places shows ${nb} bookmarks`);
  const navOk = await p.evaluate(() => { const n = document.querySelector(".bar"); return n.scrollWidth <= n.clientWidth + 1; }); if (!navOk) fail(`${label}: top bar overflows`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/marks_${label}_places.png` });
  await p.locator(".plist li button").first().click(); await p.locator(".prose [data-b]").first().waitFor();
  if (!/\/book\/[0-9a-f]{16}\?s=\d+&b=\d+/.test(p.url())) fail(`${label}: place did not open its spot (${p.url()})`);
  // export: the zip holds a Markdown file with the color names and notes, and the Web Annotation file
  await p.goto(`${BASE}/settings`);
  const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Export marks" }).click()]);
  const zip = unzipSync(new Uint8Array(readFileSync(await dl.path())));
  const md = Object.keys(zip).find(k => k.endsWith(".md")), anno = zip["annotations.jsonld"];
  if (!md || !anno) fail(`${label}: export is missing files (${Object.keys(zip)})`);
  else { const t = strFromU8(zip[md]); if (!/## Bookmarks/.test(t) || !/\*Idea|\*Question|\*Highlight/.test(t)) fail(`${label}: export Markdown lacks bookmarks or color names`); if (JSON.parse(strFromU8(anno)).total < 7) fail(`${label}: export has too few annotations`); }
  if (errors.length) fail(`${label}: page errors ${errors.join(" | ")}`);
  console.log(`${label}: ${JSON.stringify(after)}`);
  await ctx.close();
}
await b.close();
console.log(process.exitCode ? "marks e2e FAILED" : "marks e2e passed");

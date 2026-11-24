// End to end: add a PDF from the library, read it as printed pages, the invisible words line up with the ink,
// highlight on a page and find it again after a reload, jump by the outline, keep the place, search it, dark pages,
// and a scanned PDF (pictures only). PDF.js is not downloaded before a PDF is added. Desktop and phone, screenshots.
// Usage: node e2e/pdf.e2e.mjs [baseUrl] [shotsDir]
import { chromium } from "./engine.mjs";
import { mkdirSync } from "node:fs";
import { waitDrawn } from "./drawn.mjs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || ""; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const FX = new URL("../tests/fixtures/", import.meta.url).pathname;
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
// the last line names every failure, so a log cut to its tail still says what went wrong
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
const b = await chromium.launch();

async function add(p, file) {
  await p.goto(BASE + "/"); await p.locator("a.book-card").first().waitFor();
  await p.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(FX + file);
  await p.waitForURL(/\/book\//, { timeout: 30000 });
  await p.locator(".pdfpage").first().waitFor({ timeout: 15000 });
  return p.url().match(/\/book\/([^/?]+)/)[1];
}
// share of dark pixels of the drawn page under a word's box: the word's invisible copy sits on its ink
const inkUnder = (p, sel) => p.evaluate(sel => {
  const s = document.querySelector(sel); const pg = s.closest(".pdfpage"); const c = pg.querySelector("canvas");
  const pr = pg.getBoundingClientRect(), r = s.getBoundingClientRect(), k = c.width / pr.width;
  const x = Math.max(0, Math.round((r.left - pr.left) * k)), y = Math.max(0, Math.round((r.top - pr.top) * k));
  const w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k));
  const d = c.getContext("2d").getImageData(x, y, w, h).data; let dark = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 384) dark++;
  return dark / (d.length / 4);
}, sel);

for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: label === "phone" ? 3 : 1, hasTouch: label === "phone" });
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  const fetched = []; p.on("request", r => fetched.push(r.url()));
  await p.goto(BASE + "/"); await p.locator("a.book-card").first().waitFor(); await p.waitForTimeout(1500);
  if (fetched.some(u => /assets\/pdf/.test(u))) fail(`${label}: PDF code was downloaded before any PDF was added`);

  const t0 = Date.now();
  const id = await add(p, "ledger.pdf");
  await p.locator(".pdfpage.drawn").first().waitFor({ timeout: 15000 }).catch(() => fail(`${label}: the first page was not drawn`));
  const opened = Date.now() - t0;
  const title = await p.locator("header, .rtop").first().innerText().catch(() => "");
  if (!/Steward's Ledger/.test(title)) fail(`${label}: title not shown (${title.slice(0, 80)})`);
  // the words line up with the ink: under a word there is ink, under the same box moved into the margin there is none
  const ink = await inkUnder(p, '.pdfpage[data-page="0"] .pl span');
  if (!(ink > 0.06)) fail(`${label}: the invisible words do not sit on the printed ones (ink ${ink.toFixed(3)})`);
  const widths = await p.evaluate(() => [...document.querySelectorAll('.pdfpage[data-page="0"] .pl span')].slice(0, 30).map(s => { const pw = s.closest(".pdfpage").clientWidth; return s.getBoundingClientRect().width / (+s.dataset.w / 100 * pw); }));
  if (widths.some(r => Math.abs(r - 1) > 0.03)) fail(`${label}: words stretched to the wrong width (${widths.map(r => r.toFixed(2)).join(",")})`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/pdf_${label}_page.png` });

  // highlight a phrase on the page
  const blk = await p.evaluate(() => +[...document.querySelectorAll(".prose [data-b]")].find(e => /paragraph 2\./.test(e.textContent)).dataset.b);
  await p.evaluate(b => {
    const el = document.querySelector(`.prose [data-b="${b}"]`); el.scrollIntoView({ block: "center" });
    const text = el.textContent, from = text.indexOf("keeps a ledger"), to = from + "keeps a ledger".length;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, off = 0, s, e;
    while ((n = w.nextNode())) { const L = n.data.length; if (!s && from < off + L) s = [n, from - off]; if (!e && to <= off + L) { e = [n, to - off]; break; } off += L; }
    const r = document.createRange(); r.setStart(...s); r.setEnd(...e); getSelection().removeAllRanges(); getSelection().addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, blk);
  await p.locator(".seltools").waitFor({ timeout: 3000 }).catch(() => fail(`${label}: no selection tools on a PDF page`));
  await p.locator(".seltools .sw.yellow").click();
  if (!await waitDrawn(p, x => x.c === "yellow" && /keeps a ledger/.test(x.text))) fail(`${label}: highlight not drawn on the PDF page`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/pdf_${label}_highlight.png` });
  // the printed words stay dark under a highlight (the color goes under the ink, not over it)
  {
    const box = await p.evaluate(b => { const r = window.__vicPaintedRanges?.().find(r => /keeps a ledger/.test(r.toString())); const q = (r || document.querySelector(`.prose [data-b="${b}"] mark`))?.getClientRects?.()[0] ?? r?.getBoundingClientRect(); return q && { x: q.left, y: q.top, width: q.width, height: q.height }; }, blk);
    if (!box) fail(`${label}: highlight box not found`);
    else {
      const png = await p.screenshot({ clip: box });
      {
        const min = await p.evaluate(async b64 => { const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode(); const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext("2d"); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, img.width, img.height).data; let m = 765; for (let i = 0; i < d.length; i += 4) m = Math.min(m, d[i] + d[i + 1] + d[i + 2]); return m; }, png.toString("base64"));
        if (min > 270) fail(`${label}: ink washed out under the highlight (darkest ${min}/765)`);
      }
    }
  }
  if (!/Chapter One/.test(await p.locator(".rtitle span").innerText())) fail(`${label}: header names "${await p.locator(".rtitle span").innerText()}" instead of the chapter`);
  await p.reload(); await p.locator(".pdfpage").first().waitFor();
  if (!await waitDrawn(p, x => x.c === "yellow" && /keeps a ledger/.test(x.text), 6000)) fail(`${label}: highlight not found again after a reload`);

  // a larger text size zooms the pages, which then scroll sideways, drawn sharp at the new size
  {
    const w0 = await p.locator(".pdfpage").first().evaluate(e => e.clientWidth);
    await p.evaluate(() => { const k = "vic:prefs"; const v = JSON.parse(localStorage.getItem(k) || "{}"); localStorage.setItem(k, JSON.stringify({ ...v, size: 30 })); });
    await p.reload(); await p.locator(".pdfpage.drawn").first().waitFor({ timeout: 10000 });
    const z = await p.locator(".pdfpage.drawn").first().evaluate(e => ({ w: e.clientWidth, c: e.querySelector("canvas").width, sw: e.closest(".prose").scrollWidth, cw: e.closest(".prose").clientWidth }));
    if (!(z.w > w0 * 1.4)) fail(`${label}: text size did not zoom the page (${w0} -> ${z.w})`);
    if (z.c < z.w) fail(`${label}: zoomed page drawn blurry (${z.c} pixels for ${z.w})`);
    if (label === "phone" && !(z.sw > z.cw)) fail("phone: zoomed page does not scroll sideways");
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pdf_${label}_zoom.png` });
    await p.evaluate(() => { const k = "vic:prefs"; const v = JSON.parse(localStorage.getItem(k) || "{}"); localStorage.setItem(k, JSON.stringify({ ...v, size: 19 })); });
    await p.reload(); await p.locator(".pdfpage").first().waitFor();
  }
  // as text that fits the screen: same blocks, the highlight stays, headings found, the place holds, and back
  {
    await p.locator(`.prose [data-b="${blk}"]`).evaluate(e => e.scrollIntoView({ block: "start" })); await p.evaluate(() => scrollBy(0, -70)); await p.waitForTimeout(300);
    await p.getByRole("button", { name: "Text settings" }).click();
    await p.getByRole("radio", { name: "Text that fits the screen" }).click();
    await p.locator(".prose.pdftext p[data-b]").first().waitFor({ timeout: 3000 }).catch(() => fail(`${label}: text view not shown`));
    if (!await p.locator(".prose.pdftext h2", { hasText: "Chapter One: The Ledger" }).count()) fail(`${label}: chapter heading not found in the text view`);
    if (!await waitDrawn(p, x => x.c === "yellow" && /keeps a ledger/.test(x.text))) fail(`${label}: highlight missing in the text view`);
    const top = await p.evaluate(() => { for (const x of document.querySelectorAll(".prose [data-b]")) if (x.getBoundingClientRect().bottom > 80) return +x.dataset.b; });
    if (Math.abs(top - blk) > 1) fail(`${label}: switching to text moved from block ${blk} to ${top}`);
    await p.getByRole("button", { name: "Close" }).click();
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pdf_${label}_text.png` });
    await p.getByRole("button", { name: "Text settings" }).click();
    await p.getByRole("radio", { name: "Pages as printed" }).click();
    await p.locator(".pdfpage.drawn").first().waitFor({ timeout: 10000 }).catch(() => fail(`${label}: pages not back`));
    await p.getByRole("button", { name: "Close" }).click();
  }
  // the outline jumps to its chapter; the place is kept
  await p.getByRole("button", { name: "Contents" }).click();
  await p.locator(".panel").getByText("Chapter Three: The Reckoning").click();
  await p.waitForURL(/s=2/, { timeout: 5000 }).catch(() => fail(`${label}: the outline did not open chapter three`));
  await p.locator(".pdfpage.drawn").first().waitFor({ timeout: 10000 }).catch(() => fail(`${label}: chapter three not drawn`));
  await p.evaluate(() => scrollBy(0, 500)); await p.waitForTimeout(2600);
  const before = new URL(p.url()).search;
  await p.reload(); await p.locator(".pdfpage").first().waitFor(); await p.waitForTimeout(500);
  if (new URL(p.url()).searchParams.get("s") !== "2") fail(`${label}: place not kept (${before} -> ${new URL(p.url()).search})`);

  // search finds words on a page
  await p.getByRole("button", { name: "Search in this book" }).click();
  await p.locator(".panel input[type=search]").fill("frost");
  await p.locator(".panel").getByText(/before the frost/).first().waitFor({ timeout: 5000 }).catch(() => fail(`${label}: search did not find words in the PDF`));
  await p.getByRole("button", { name: "Close" }).click();

  if (label === "desktop") {
    // dark pages
    await p.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await p.waitForTimeout(200);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pdf_desktop_dark.png` });
    await p.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    // a scan: pages drawn, nothing to select, a plain word about it in the library
    await add(p, "scan.pdf");
    await p.locator(".pdfpage.drawn").first().waitFor({ timeout: 15000 }).catch(() => fail("scan: page not drawn"));
    if (await p.locator(".pdfpage").count() !== 2) fail("scan: expected 2 pages");
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pdf_desktop_scan.png` });
    // right to left: the words sit on their ink and the book reads right to left
    await add(p, "hebrew.pdf");
    await p.locator(".pdfpage.drawn").first().waitFor({ timeout: 15000 }).catch(() => fail("hebrew: page not drawn"));
    const inkHe = await inkUnder(p, '.pdfpage[data-page="0"] .pl[dir="rtl"] span');
    if (!(inkHe > 0.06)) fail(`hebrew: words do not sit on the printed ones (ink ${inkHe.toFixed(3)})`);
    if (await p.locator(".reader").getAttribute("dir") !== "rtl") fail("hebrew: the reader is not right to left");
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pdf_desktop_hebrew.png` });
    // the library shows the PDF with its first page as the cover
    await p.goto(BASE + "/"); await p.locator("a.book-card").first().waitFor();
    const card = p.locator("a.book-card", { hasText: "Steward" });
    if (!await card.count()) fail("library: the PDF is not on the shelf");
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pdf_desktop_library.png` });
  }
  if (errors.length) fail(`${label}: page errors: ${errors.join(" | ")}`);
  console.log(`${label}: opened and drew the first page in ${opened} ms; ink under words ${ink.toFixed(2)}`);
  await ctx.close();
}
await b.close();
console.log(process.exitCode ? "pdf e2e FAILED" : "pdf e2e passed");

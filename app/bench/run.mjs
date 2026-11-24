// Performance budgets, measured in real Chromium with the CPU slowed 4x. Median of 5 runs per metric.
// Usage: node bench/run.mjs [--json out.json] [--budget-scale 0.01 (to prove a failure is caught)] [--profile (CPU profile of opening the book with 2,000 marks)]
import { chromium } from "playwright";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { serve } from "./serve.mjs";
import { seedLibrary } from "../e2e/synth-library.mjs";

const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const cfg = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url)));
const scale = Number(opt("--budget-scale") || 1);
const PORT = 47900 + Math.floor(Math.random() * 90), BASE = "/vicaria/next";
const URL0 = `http://127.0.0.1:${PORT}${BASE}/`;
const dist = new URL("../dist/", import.meta.url).pathname;
const server = await serve(dist, PORT, BASE);
const browser = await chromium.launch();
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const results = {};
const add = (k, v) => (results[k] ||= []).push(Math.round(v * 10) / 10);

async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cfg.cpu_throttle });
  page.on("pageerror", e => console.error("pageerror:", e.message));
  return { ctx, page };
}
const markTime = (page, name, timeout = 20000) => page.waitForFunction(n => performance.getEntriesByName(n)[0]?.startTime, name, { timeout, polling: 16 }).then(h => h.jsonValue());
const paintAfter = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))));

for (let i = 0; i < cfg.runs; i++) {
  const { ctx, page } = await context();
  // first visit: nothing cached
  await page.goto(URL0);
  const fcp = await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint")[0]?.startTime, null, { polling: 16 }).then(h => h.jsonValue());
  add("shell_first_paint_cold", fcp);
  add("library_interactive_cold", await markTime(page, "vic:library"));
  await page.waitForSelector("a.book-card", { timeout: 30000 }); // the classic imports in the background
  await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready.then(() => true), null, { timeout: 15000 }).catch(() => {});
  // warm visit: app from the service worker, library from storage
  await page.reload();
  add("library_interactive_warm", await markTime(page, "vic:library"));
  await page.waitForSelector("a.book-card");
  // open a book from the library (head and first section from IndexedDB), a second after the library shows
  await page.waitForTimeout(1000);
  const t0 = await page.evaluate(() => { const t = performance.now(); document.querySelector("a.book-card").click(); return t; });
  await page.waitForSelector(".prose [data-b]");
  await paintAfter(page);
  add("open_book_from_library", (await page.evaluate(() => performance.now())) - t0);
  const parts = await page.evaluate(t0 => Object.fromEntries(["vic:head", "vic:ops", "vic:sec", "vic:book"].map(n => [n, Math.round((performance.getEntriesByName(n).pop()?.startTime ?? NaN) - t0)])), t0);
  for (const [k, v] of Object.entries(parts)) add("open_breakdown " + k, v);
  // full page load straight into the book, warm
  const bookUrl = page.url();
  await page.goto(bookUrl);
  await page.waitForSelector(".prose [data-b]");
  await paintAfter(page);
  add("open_book_page_load_warm", await page.evaluate(() => performance.now()));
  // next chapter
  const t1 = await page.evaluate(() => { const b = [...document.querySelectorAll(".chapnav .btn")].pop(); const old = document.querySelector(".prose").innerHTML.length; window.__old = old; const t = performance.now(); b.click(); return t; });
  await page.waitForFunction(() => document.querySelector(".prose")?.innerHTML.length !== window.__old && document.querySelector(".prose [data-b]"), null, { polling: 4 });
  await paintAfter(page);
  add("next_chapter", (await page.evaluate(() => performance.now())) - t1);
  // footnote popover: tap to visible
  await page.waitForSelector("a.nref");
  const t2 = await page.evaluate(() => { const a = document.querySelector("a.nref"); a.scrollIntoView({ block: "center" }); const t = performance.now(); a.click(); return t; });
  await page.waitForSelector(".popover.note");
  await paintAfter(page);
  add("footnote_popover", (await page.evaluate(() => performance.now())) - t2);
  await ctx.close();
}

// library search across 1,000 books (synthetic records written straight to storage)
{
  const { ctx, page } = await context();
  await page.goto(URL0);
  await page.waitForSelector("a.book-card", { timeout: 30000 });
  await page.evaluate(() => new Promise((ok, bad) => {
    const r = indexedDB.open("vicaria");
    r.onsuccess = () => {
      const t = r.result.transaction("books", "readwrite"), s = t.objectStore("books");
      const words = "river night garden letters winter stone empire silent house glass ocean memory light iron road".split(" ");
      const names = "Austen Tolstoy Woolf Borges Seneca Homer Dickens Eliot Melville Cervantes Kafka Rilke".split(" ");
      for (let i = 0; i < 1000; i++) s.put({ id: "syn" + i, sha256: "syn" + i, title: `The ${words[i % 15]} of ${words[(i * 7) % 15]} ${i}`, author: `${names[i % 12]} ${i}`, lang: "en", cover: null, addedAt: Date.now() - i * 1000, start: 0, dir: "ltr", vertical: false, fixedLayout: false, v: 1, words: 1000, sections: 1, storage: "idb", size: 1000 });
      t.oncomplete = ok; t.onerror = () => bad(t.error);
    };
    r.onerror = () => bad(r.error);
  }));
  await page.evaluate(() => localStorage.removeItem("vic:lib1"));
  await page.reload();
  await page.waitForSelector('input[type=search]', { timeout: 20000 });
  for (let i = 0; i < cfg.runs; i++) {
    const q = ["silent", "borges", "glass ocean", "river 12", "tolstoy 4"][i];
    const ms = await page.evaluate(async q => {
      const inp = document.querySelector('input[type=search]');
      inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
      const t = performance.now();
      inp.value = q; inp.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t;
    }, q);
    add("library_search_1000_books", ms);
  }
  results.library_search_1000_books_cards = [await page.locator("a.book-card").count()];
  await ctx.close();
}

// Ideas page at 1,000 books (synthetic library with marks and tags): list ready, search, scrolling, graph ready
{
  const { ctx, page } = await context();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(URL0); await page.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 60000 });
  await seedLibrary(page, 1000);
  await page.evaluate(() => localStorage.removeItem("vic:lib1"));
  for (let i = 0; i < cfg.runs; i++) {
    await page.goto(URL0 + "ideas");
    add("ideas_list_1000_books", await markTime(page, "vic:ideas", 60000));
    await page.waitForSelector(".vrow");
    // search: from typing to the narrowed list on screen
    const ms = await page.evaluate(async q => {
      const inp = document.querySelector(".ideas input[type=search]");
      inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
      const t = performance.now();
      inp.value = q; inp.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t;
    }, ["silent", "stoicism", "glass grief", "river 12", "austen 4"][i % 5]);
    add("ideas_search_1000_books", ms);
    await page.evaluate(() => { const inp = document.querySelector(".ideas input[type=search]"); inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForTimeout(100);
    // scroll the whole list in 150 steps, one per frame: the slowest frames decide whether it feels smooth
    const frames = await page.evaluate(() => new Promise(done => {
      const dts = []; let last = performance.now(), n = 0; const step = (document.body.scrollHeight - innerHeight) / 150;
      const f = now => { dts.push(now - last); last = now; scrollBy(0, step); if (++n < 150) requestAnimationFrame(f); else done(dts.slice(2)); };
      requestAnimationFrame(f);
    }));
    frames.sort((a, b) => a - b);
    add("ideas_scroll_frame_p95", frames[Math.floor(frames.length * 0.95)]);
    results.ideas_rows_in_page = [await page.locator(".vrow").count()];
  }
  for (let i = 0; i < 3; i++) {
    await page.goto(URL0 + "ideas");
    await page.waitForSelector(".vrow", { timeout: 30000 }).catch(async e => { console.error("ideas list missing, run " + i, await page.evaluate(() => ({ ss: sessionStorage.getItem("vic:ideas"), body: document.body.innerText.slice(0, 300), lib: localStorage.getItem("vic:lib1")?.length }))); throw e; });
    const t = await page.evaluate(() => performance.now());
    await page.getByRole("tab", { name: "Graph" }).click();
    await page.waitForFunction(() => document.querySelector(".graphbox canvas") && !document.querySelector(".graphbox .wait"), null, { timeout: 90000, polling: 50 });
    add("ideas_graph_ready_1000_books", (await page.evaluate(() => performance.now())) - t);
    await page.getByRole("tab", { name: "List" }).click();
    await page.waitForSelector(".vrow"); // the view is kept in sessionStorage after the click; the next load reads it
    await page.waitForTimeout(100);
  }
  await ctx.close();
}

// heavy marks: 100,000 marks in the log (2,000 in the open book, 500 of them in the open chapter), written straight to storage
{
  const { ctx, page } = await context();
  await page.goto(URL0);
  await page.waitForSelector("a.book-card", { timeout: 30000 });
  await page.locator("a.book-card").first().click();
  await page.waitForSelector(".prose [data-b]");
  const info = await page.evaluate(() => {
    const id = location.pathname.match(/book\/([0-9a-f]{16})/)[1];
    const sec = +(new URLSearchParams(location.search).get("s") ?? 0);
    const blocks = [...document.querySelectorAll(".prose [data-b]")].map(e => ({ b: +e.dataset.b, t: e.textContent })).filter(x => x.t.length > 40);
    return { id, sec, blocks };
  });
  await page.evaluate(async ({ id, sec, blocks }) => {
    const colors = ["yellow", "green", "blue", "pink", "purple", "orange"];
    const r = indexedDB.open("vicaria");
    const db = await new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    const now = Date.now(); let n = 0;
    const put = (s, book, set, note) => { n++; s.put({ id: "bench." + n, dev: "bench", t: now - n, c: 0, k: "mark", v: { id: "bm" + n, book, set: { ...set, made: now - n }, ...(note ? { note, base: null } : {}) }, bk: book }); };
    for (let chunk = 0; chunk < 10; chunk++) await new Promise((ok, bad) => {
      const t = db.transaction("ops", "readwrite"), s = t.objectStore("ops");
      if (chunk === 0) {
        for (let i = 0; i < 500; i++) { const x = blocks[i % blocks.length], len = Math.min(24, x.t.length - 10), off = (i * 7) % Math.max(1, x.t.length - len - 1); put(s, id, { at: { section: sec, block: x.b, offset: off, exact: x.t.slice(off, off + len), prefix: "", suffix: "" }, color: colors[i % 6] }, i % 5 === 0 ? "A note about this passage, " + i : undefined); }
        for (let i = 0; i < 1500; i++) put(s, id, { at: { section: sec + 1 + (i % 20), block: 1 + (i % 200), offset: 0, exact: "elsewhere in the book " + i, prefix: "", suffix: "" }, color: colors[i % 6] });
      }
      for (let i = 0; i < 9800; i++) put(s, "0000synth" + String((chunk * 9800 + i) % 999).padStart(7, "0"), { at: { section: i % 30, block: i % 300, offset: 3, exact: "some quoted text of a typical highlight length here", prefix: "", suffix: "" }, color: colors[i % 6] });
      t.oncomplete = ok; t.onerror = () => bad(t.error);
    });
  }, info);
  // the app packs the log when it starts; wait until it has
  await page.goto(URL0);
  await page.evaluate(async () => { for (let i = 0; i < 240; i++) { const n = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => { const q = r.result.transaction("ops").objectStore("ops").count(); q.onsuccess = () => { r.result.close(); ok(q.result); }; }; }); if (n < 1000) return; await new Promise(r => setTimeout(r, 500)); } throw new Error("log not packed"); });
  for (let i = 0; i < cfg.runs; i++) {
    await page.goto(URL0); await page.waitForSelector("a.book-card");
    await page.waitForTimeout(500);
    const prof = args.includes("--profile") && i === cfg.runs - 1 ? await ctx.newCDPSession(page) : null;
    if (prof) { await prof.send("Profiler.enable"); await prof.send("Profiler.setSamplingInterval", { interval: 100 }); await prof.send("Profiler.start"); }
    const t0 = await page.evaluate(() => { performance.clearMarks(); const t = performance.now(); document.querySelector("a.book-card").click(); return t; });
    await page.waitForSelector(".prose [data-b]", { polling: 4 }); await paintAfter(page);
    add("open_book_2000_marks", (await page.evaluate(() => performance.now())) - t0);
    await page.waitForFunction(() => window.__vicPainted?.().length || document.querySelector(".prose mark.hl"), null, { polling: 4 }); await paintAfter(page);
    add("marks_shown_2000", (await page.evaluate(() => performance.now())) - t0);
    if (prof) {
      const { profile } = await prof.send("Profiler.stop"); const self = new Map(), dt = profile.timeDeltas; const byId = new Map(profile.nodes.map(n => [n.id, n]));
      profile.samples.forEach((id, k) => { const n = byId.get(id).callFrame; const key = `${n.functionName || "(anon)"} ${n.url.split("/").pop()}:${n.lineNumber}`; self.set(key, (self.get(key) || 0) + (dt[k] || 0) / 1000); });
      console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `  ${v.toFixed(1).padStart(7)} ms ${k}`).join("\n"));
    }
    for (const [k, v] of Object.entries(await page.evaluate(t0 => Object.fromEntries(["vic:head", "vic:ops", "vic:sec", "vic:fold", "vic:book", "vic:marks"].map(n => [n, Math.round((performance.getEntriesByName(n).pop()?.startTime ?? NaN) - t0)])), t0))) add("open_breakdown marks " + k, v);
    add("paint_500_marks", await page.evaluate(() => performance.getEntriesByName("vic:marks").pop().startTime - performance.getEntriesByName("vic:paint0").pop().startTime));
    const t1 = await page.evaluate(() => { const t = performance.now(); document.querySelector('[aria-label="Marks"]').click(); return t; });
    await page.waitForSelector(".marks li"); await paintAfter(page);
    add("marks_panel_2000", (await page.evaluate(() => performance.now())) - t1);
  }
  results.painted_marks = [await page.evaluate(() => new Set(window.__vicPainted().map(m => m.id)).size)];
  // export all 100,000 marks (fold, Markdown per book, Web Annotations, zip) in the worker
  await page.goto(URL0 + "settings"); await page.waitForSelector("text=Export marks");
  for (let i = 0; i < 3; i++) {
    const t = await page.evaluate(() => performance.now());
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: "Export marks" }).click()]);
    await dl.path();
    add("export_100k_marks", (await page.evaluate(() => performance.now())) - t);
  }
  await ctx.close();
}
await browser.close(); server.close();

// bundle size
const html = readFileSync(dist + "index.html", "utf8");
// every script the first page loads: the entry and the chunks it imports (modulepreload links)
const initial = [...new Set([...html.matchAll(/(?:src|href)="[^"]*\/(assets\/[^"]+\.js)"/g)].map(m => m[1]))];
const initialKb = initial.reduce((n, f) => n + gzipSync(readFileSync(dist + f), { level: 9 }).length, 0) / 1024;

for (const [k, v] of Object.entries(results)) if (k.startsWith("open_breakdown")) console.log(`     ${k.padEnd(28)} ${median(v)} ms  ${JSON.stringify(v)}`);
let fail = 0;
const report = { when: new Date().toISOString(), cpu_throttle: cfg.cpu_throttle, metrics: {} };
for (const [k, b0] of Object.entries(cfg.budgets_ms)) {
  const b = b0 * scale, m = median(results[k] || [Infinity]), ok = m <= b;
  if (!ok) fail++;
  report.metrics[k] = { median_ms: m, runs: results[k], budget_ms: b, ok };
  console.log(`${ok ? "ok  " : "FAIL"} ${k.padEnd(28)} ${String(m).padStart(7)} ms  (budget ${b})  runs ${JSON.stringify(results[k])}`);
}
const kb = cfg.budgets_kb_gzip.initial_js * scale, okKb = initialKb <= kb; if (!okKb) fail++;
report.metrics.initial_js_kb_gzip = { value: Math.round(initialKb * 10) / 10, budget: kb, ok: okKb };
console.log(`${okKb ? "ok  " : "FAIL"} initial_js_kb_gzip           ${initialKb.toFixed(1)} KB (budget ${kb})`);
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(report, null, 2) + "\n");
if (fail) { console.error(`${fail} budget(s) failed`); process.exit(1); }

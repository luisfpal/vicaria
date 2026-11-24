// End to end: a device that has the 0.x app's library opens the new app for the first time.
// The 0.x IndexedDB database is planted from the fixture, then the new app must bring every book and highlight over
// on its own, show them in the reader, take the old theme, and report the move in Settings.
// Usage: node e2e/legacy.e2e.mjs [baseUrl] [shotsDir]
import { chromium } from "./engine.mjs";
import { drawn, waitDrawn } from "./drawn.mjs";
import { readFileSync, mkdirSync } from "node:fs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
const root = new URL("../../", import.meta.url).pathname;
const dump = JSON.parse(readFileSync(root + "tests/fixtures/legacy-0.x/idbfs.json", "utf8"));
const expected = JSON.parse(readFileSync(root + "tests/fixtures/legacy-0.x/expected.json", "utf8"));
const rows = dump.stores[0].rows.map(r => ({ ...r, b64: r.corpus ? readFileSync(root + "tests/corpus/" + r.corpus).toString("base64") : r.b64 }));
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
// the last line names every failure, so a log cut to its tail still says what went wrong
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
const b = await chromium.launch();
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: label === "phone" ? 3 : 1 });
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e))); p.on("console", m => { if (m.type() === "warning" || m.type() === "error") console.log(`${label} console: ${m.text().slice(0, 300)}`); });
  await p.goto(BASE + "/version.txt"); // same origin, app not started yet
  await p.evaluate(async ({ rows, version }) => {
    await new Promise((ok, bad) => {
      const r = indexedDB.open("/data", version);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore("FILE_DATA"); s.createIndex("timestamp", "timestamp"); };
      r.onsuccess = () => {
        const t = r.result.transaction("FILE_DATA", "readwrite"), s = t.objectStore("FILE_DATA");
        for (const row of rows) {
          const v = { timestamp: new Date(row.timestamp), mode: row.mode };
          if (row.b64) { const bin = atob(row.b64); const u = new Int8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); v.contents = u; }
          s.put(v, row.key);
        }
        t.oncomplete = () => { r.result.close(); ok(); }; t.onerror = () => bad(t.error);
      };
    });
  }, { rows, version: dump.version });
  const t0 = Date.now();
  await p.goto(BASE + "/");
  await p.locator(".toast", { hasText: "previous version" }).waitFor({ timeout: 60000 });
  const secs = (Date.now() - t0) / 1000;
  const toastText = await p.locator(".toast", { hasText: "previous version" }).innerText();
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/legacy_${label}_library.png` }); }
  const cards = await p.locator("a.book-card").count();
  if (cards !== 5) fail(`${label}: ${cards} books on the shelf, want 5`);
  const theme = await p.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== "sepia") fail(`${label}: theme ${theme}, want sepia from the 0.x reader settings`);
  // one highlight per book: open its place by URL and look for the mark with the quoted text
  const picks = await p.evaluate(async () => {
    const db = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); });
    const all = (st) => new Promise(ok => { const q = db.transaction(st).objectStore(st).getAll(); q.onsuccess = () => ok(q.result); });
    const keys = (st) => new Promise(ok => { const q = db.transaction(st).objectStore(st).getAllKeys(); q.onsuccess = () => ok(q.result); });
    const ops = await all("ops"), anchors = await all("anchors"), ak = await keys("anchors");
    const at = new Map(ak.map((k, i) => [k, anchors[i]]));
    const gone = new Set(ops.filter(o => o.k === "hl-").map(o => o.b + "|" + o.v.id));
    const out = {};
    for (const o of ops) if (o.k === "hl" && o.b && !out[o.b] && !gone.has(o.b + "|" + o.v.id) && at.get(o.id)?.a) out[o.b] = { id: o.v.id, book: at.get(o.id).book, a: at.get(o.id).a };
    return out;
  });
  // nothing lost: every 0.x highlight is in the new log, placed on its exact words, and every reading position is kept
  const kept = await p.evaluate(async () => {
    const db = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); });
    const all = (st) => new Promise(ok => { const q = db.transaction(st).objectStore(st).getAll(); q.onsuccess = () => ok(q.result); });
    const keys = (st) => new Promise(ok => { const q = db.transaction(st).objectStore(st).getAllKeys(); q.onsuccess = () => ok(q.result); });
    const ops = await all("ops"), anchors = await all("anchors"), ak = await keys("anchors");
    const at = new Map(ak.map((k, i) => [k, anchors[i]]));
    const hl = {}, pos = {};
    for (const o of ops) {
      if (o.k === "hl" && o.b) hl[o.b + "|" + o.v.id] = { exact: at.get(o.id)?.a?.exact ?? null, quote: o.v.quote };
      if (o.k === "pos" && o.b) pos[o.b] = { quote: o.v.quote, chapter: o.v.chapter, placed: !!at.get(o.id)?.a };
    }
    return { hl, pos };
  });
  const norm = s => (s || "").replace(/\s+/g, " ").trim();
  // 0.x quotes leave out the text of math (MathML); the new anchor has it. Same words, in order, same first and last.
  const sameWords = (got, want) => {
    const g = norm(got), w = norm(want).split(" ").filter(Boolean); let at = 0;
    for (const x of w) { const i = g.indexOf(x, at); if (i < 0) return false; at = i + x.length; }
    return g.startsWith(w[0]) && g.endsWith(w[w.length - 1]);
  };
  let placed = 0;
  for (const [old, bk] of Object.entries(expected.books)) {
    for (const h of bk.highlights) {
      const k = kept.hl[old + "|" + h.id];
      if (!k) { fail(`${label}: highlight ${h.id} of ${old} is missing`); continue; }
      if (norm(k.quote) !== norm(h.quote)) fail(`${label}: highlight ${h.id} of ${old} changed its quote`);
      if (k.exact !== null && sameWords(k.exact, h.quote)) placed++;
      else if (process.env.DEBUG) console.log(old, h.id, JSON.stringify(h.quote).slice(0, 90), '=>', JSON.stringify(k.exact).slice(0, 90));
    }
    const ps = kept.pos[old];
    if (!ps || ps.chapter !== bk.position.chapter || !norm(bk.position.quote).startsWith(norm(ps.quote).slice(0, 20))) fail(`${label}: reading position of ${old} not kept (${JSON.stringify(ps)})`);
    else if (!ps.placed) fail(`${label}: reading position of ${old} not placed in the new book`);
  }
  const total = Object.values(expected.books).reduce((n, b) => n + b.highlights.length, 0);
  if (placed !== total) fail(`${label}: ${placed} of ${total} highlights placed on their exact words`);
  for (const old of Object.keys(expected.books)) {
    const x = picks[old]; if (!x) { fail(`${label}: no placed highlight for ${old}`); continue; }
    await p.goto(`${BASE}/book/${x.book}?s=${x.a.section}&b=${x.a.block}`);
    if (!await waitDrawn(p, d => d.id === x.id, 15000)) { fail(`${label}: highlight ${x.id} of ${old} not shown`); continue; }
    const got = (await drawn(p)).find(d => d.id === x.id).text.replace(/\s+/g, " ").trim();
    const want = expected.books[old].highlights.find(h => h.id === x.id).quote.replace(/\s+/g, " ").trim();
    const words = want.split(" "); let at = 0, ok = true;
    for (const w of words) { const i = got.indexOf(w, at); if (i < 0) { ok = false; break; } at = i + w.length; }
    if (!ok) fail(`${label}: ${old} highlight shows "${got.slice(0, 80)}", want "${want.slice(0, 80)}"`);
    if (SHOTS && old === "don-quijote") { await m.scrollIntoViewIfNeeded(); await p.screenshot({ path: `${SHOTS}/legacy_${label}_highlight.png` }); }
  }
  await p.goto(BASE + "/settings");
  const prev = p.locator("h2", { hasText: "From the previous version" });
  try { await prev.waitFor({ timeout: 10000 }); } catch { fail(`${label}: no report in Settings`); }
  const reportText = await p.locator("h2:has-text('From the previous version') + p").innerText().catch(() => "");
  if (!/235 of 235 highlights/.test(reportText)) fail(`${label}: Settings says "${reportText}"`);
  if (SHOTS) { await prev.scrollIntoViewIfNeeded().catch(() => {}); await p.screenshot({ path: `${SHOTS}/legacy_${label}_settings.png` }); }
  // a second start must not move anything again or toast again
  await p.goto(BASE + "/"); await p.waitForTimeout(2500);
  const again = await p.locator(".toast", { hasText: "previous version" }).count();
  if (again) fail(`${label}: the move toasted again on the second start`);
  if (errors.length) fail(`${label}: page errors ${errors.join(" | ")}`);
  console.log(`${label}: moved in ${secs.toFixed(1)} s; ${placed} of ${total} highlights on their exact words; toast "${toastText.split("\n")[0]}"; settings "${reportText.slice(0, 90)}"`);
  await ctx.close();
}
await b.close();
console.log(process.exitCode ? "legacy e2e FAILED" : "legacy e2e passed");

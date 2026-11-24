// How reading and folding the annotation log scales: 100,000 ops in IndexedDB, all at once vs one book via an index.
// Usage: node bench/opsbench.mjs [url]   (any page on the app's origin; the app server must be running)
import { chromium } from "playwright";
const url = process.argv[2] || "http://127.0.0.1:47812/vicaria/next/";
const b = await chromium.launch(); const p = await b.newPage();
await p.goto(url);
const r = await p.evaluate(async () => {
  const open = () => new Promise(ok => { const q = indexedDB.open("bench", 1); q.onupgradeneeded = () => { const s = q.result.createObjectStore("ops", { keyPath: "id" }); s.createIndex("b", "b"); }; q.onsuccess = () => ok(q.result); });
  const db = await open(); const N = 100000, books = 200;
  await new Promise(ok => { const t = db.transaction("ops", "readwrite"); const s = t.objectStore("ops");
    for (let i = 0; i < N; i++) s.put({ id: "dev1." + i, dev: "dev1", t: 1.7e12 + i, k: i % 5 ? "hl" : "pos", b: "book" + (i % books), v: { id: "h" + i, anchor: { section: i % 40, block: i % 300, offset: 3, endBlock: i % 300, endOffset: 40, exact: "some quoted text of a typical highlight length here", prefix: "", suffix: "" }, color: "yellow" } }); t.oncomplete = ok; });
  const time = async (f, n = 5) => { const xs = []; for (let i = 0; i < n; i++) { const a = performance.now(); await f(); xs.push(performance.now() - a); } xs.sort((a, b) => a - b); return +xs[n >> 1].toFixed(1); };
  const getAll = () => new Promise(ok => { const q = db.transaction("ops").objectStore("ops").getAll(); q.onsuccess = () => ok(q.result); });
  const byBook = () => new Promise(ok => { const q = db.transaction("ops").objectStore("ops").index("b").getAll("book7"); q.onsuccess = () => ok(q.result); });
  const all = await getAll();
  const fold = () => { const m = new Map(); for (const o of all) { const k = o.k + "|" + o.v.id; const c = m.get(k); if (!c || c.t < o.t) m.set(k, o); } return m.size; };
  return { allOps100kMs: await time(getAll), oneBook500Ms: await time(byBook), fold100kMs: await time(fold) };
});
console.log(JSON.stringify(r)); await b.close();

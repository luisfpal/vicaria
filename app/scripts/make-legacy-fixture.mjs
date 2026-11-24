// Builds the 0.x migration fixture with the real 0.x app (Python in the browser): adds corpus books, makes
// highlights, removals, positions, reader settings and chapter cards through its own API, then dumps its storage
// (the IDBFS database "/data") to tests/fixtures/legacy-0.x/. Book files are stored as references to tests/corpus.
// Usage: serve the 0.x build at http://127.0.0.1:PORT/vicaria/ then: node scripts/make-legacy-fixture.mjs PORT
import { chromium } from "playwright";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const PORT = process.argv[2] || "47813", R = `http://127.0.0.1:${PORT}/vicaria`;
const CORPUS = new URL("../../tests/corpus/", import.meta.url).pathname;
const OUT = new URL("../../tests/fixtures/legacy-0.x/", import.meta.url).pathname;
const BOOKS = ["meditations-se.epub", "pg132.epub", "pg2000.epub", "idpf-linear-algebra.epub", "idpf-regime-anticancer-arabic.epub"];
const PER_BOOK = 50;
let seed = 20261121;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

const br = await chromium.launch(); const pg = await br.newPage();
await pg.goto(R + "/"); await pg.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 60000 });
const api = (path, opts) => pg.evaluate(async ([p, o]) => { const r = await fetch("/vicaria" + p, o); const t = await r.text(); if (!r.ok) throw new Error(r.status + " " + t.slice(0, 200)); return JSON.parse(t); }, [path, opts]);
const lib = await api("/api/library");
const dev = "dfixture001"; let n = 0, t = Date.parse("2026-10-01T12:00:00Z");
const op = (k, v) => ({ id: `${dev}.${++n}`, dev, t: (t += 60000), k, v: { ...v, device: "Linux" } });
const ids = {};
for (const f of BOOKS) {
  const b64 = readFileSync(CORPUS + f).toString("base64");
  const r = await pg.evaluate(async ([b64, f]) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); return (await fetch("/vicaria/api/books", { method: "POST", headers: { "X-Filename": f }, body: bytes })).json(); }, [b64, f]);
  ids[f] = r.id;
  const info = await api(`/api/books/${r.id}`);
  const chapters = [];
  for (const c of info.chapters) { const x = await api(`/api/books/${r.id}/chapters/${c.index}`); chapters.push({ index: c.index, blocks: x.blocks.map(b => b.text || "") }); }
  const ops = [];
  for (let i = 0; i < PER_BOOK; i++) {
    const cands = chapters.flatMap(c => c.blocks.map((txt, bi) => ({ c: c.index, bi, txt }))).filter(x => x.txt.split(/\s+/).length > 12);
    const x = cands[Math.floor(rnd() * cands.length)];
    const words = [...x.txt.matchAll(/\S+/g)];
    const a = Math.floor(rnd() * (words.length - 4)), len = 3 + Math.floor(rnd() * Math.min(30, words.length - a - 1));
    const start = words[a].index, last = words[Math.min(words.length - 1, a + len)], end = last.index + last[0].length;
    ops.push(op("hl", { id: `${dev}-${n}${x.bi}`, chapter: x.c, block: x.bi, start, end, quote: x.txt.slice(start, end).slice(0, 400) }));
  }
  // remove three, so migration must honor removals
  for (const h of ops.slice(0, 3)) ops.push(op("hl-", { id: h.v.id }));
  const c = chapters[Math.min(2, chapters.length - 1)], blk = c.blocks.findIndex(s => s.length > 60);
  ops.push(op("pos", { chapter: c.index, block: Math.max(0, blk), offset: 0, quote: (c.blocks[Math.max(0, blk)] || "").slice(0, 48), y: 200, percent: 12 }));
  await api("/api/ops", { method: "POST", body: JSON.stringify({ book: r.id, ops }) });
  console.log(f, "->", r.id, chapters.length, "chapters,", ops.length, "ops");
}
await api("/api/ops", { method: "POST", body: JSON.stringify({ book: null, ops: [op("reader", { theme: "sepia", font: "serif", size: 20 })] }) });
// chapter cards and operations for a book this device does not have (they wait in "pending")
const card = JSON.stringify({ core: "Character is formed by the people we learn from.", terms: [], points: [], model: "fixture" });
await api("/api/x/sync/import", { method: "POST", body: JSON.stringify({ library: lib.id, books: { "not-on-this-device": [op("hl", { id: "pending-1", chapter: 1, block: 2, start: 0, end: 10, quote: "elsewhere." })] }, reader: [], cards: { [ids["meditations-se.epub"]]: { "02.json": card }, "not-on-this-device": { "01.json": card } } }) });
await pg.waitForTimeout(2500); // the worker writes IDBFS after each request

const expected = { library: lib.id, books: {} };
for (const [f, id] of Object.entries(ids)) expected.books[id] = { file: f, highlights: (await api(`/api/books/${id}/highlights`)).highlights, position: (await api(`/api/books/${id}/position`)).position };
const sums = Object.fromEntries(readdirSync(CORPUS).filter(f => f.endsWith(".epub")).map(f => [createHash("sha256").update(readFileSync(CORPUS + f)).digest("hex"), f]));
const dump = await pg.evaluate(() => new Promise((ok, bad) => {
  const r = indexedDB.open("/data");
  r.onsuccess = () => {
    const d = r.result, out = { name: d.name, version: d.version, stores: [] };
    for (const s of d.objectStoreNames) {
      const st = d.transaction(s).objectStore(s), info = { name: s, keyPath: st.keyPath, autoIncrement: st.autoIncrement, indexes: [...st.indexNames].map(i => ({ name: i, keyPath: st.index(i).keyPath, unique: st.index(i).unique })), rows: [] };
      out.stores.push(info);
      const c = st.openCursor();
      c.onsuccess = async () => {
        const cur = c.result; if (!cur) return;
        const v = cur.value, row = { key: cur.key, timestamp: v.timestamp instanceof Date ? v.timestamp.getTime() : v.timestamp, mode: v.mode };
        if (v.contents) { const u8 = new Uint8Array(v.contents.buffer || v.contents, v.contents.byteOffset || 0, v.contents.byteLength ?? v.contents.length); row.sha256 = Array.from(new Uint8Array(0)).join(""); row.b64 = btoa(Array.from(u8, x => String.fromCharCode(x)).join("")); row.kind = v.contents.constructor.name; }
        info.rows.push(row); cur.continue();
      };
    }
    setTimeout(() => ok(out), 3000);
  };
  r.onerror = () => bad(r.error);
}));
for (const s of dump.stores) for (const row of s.rows) if (row.b64) {
  const buf = Buffer.from(row.b64, "base64"), h = createHash("sha256").update(buf).digest("hex");
  if (sums[h]) { row.corpus = sums[h]; delete row.b64; }
  row.sha256 = h;
}
writeFileSync(OUT + "idbfs.json", JSON.stringify(dump));
writeFileSync(OUT + "expected.json", JSON.stringify(expected, null, 1));
console.log("rows", dump.stores.map(s => `${s.name}:${s.rows.length}`).join(" "), "highlights", Object.values(expected.books).reduce((n, b) => n + b.highlights.length, 0));
await br.close();

// End to end: two devices (browser contexts with their own storage) pair with a link and sync over real WebRTC,
// signalling through a local Nostr relay. Checks, byte for byte: the op logs and the book files match.
//  1. pair, a highlight made on A shows on B, a note edited on B shows on A
//  2. a 50 MB book added on A reaches B; B closes halfway and resumes without starting over
//  3. relay only: B is closed while A changes things; B opens later with A gone and picks them up from the relay
//  4. a device on 0.x (its real sync.js and p2p.js in the page, its real Python sync behind the API routes): its ops
//     reach 1.0 unchanged, 1.0 fetches and links its book and draws its highlight; 1.0's shelf ops reach 0.x unchanged
// Usage: node e2e/sync.e2e.mjs [baseUrl]
import { chromium } from "playwright";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { startRelay } from "./relay.mjs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
// the last line names every failure, so a log cut to its tail still says what went wrong
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
const relay = await startRelay(47830);
const b = await chromium.launch({ args: ["--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks"] });
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function device(label) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 860 } });
  await ctx.addInitScript(url => localStorage.setItem("vic:relaysOnly", JSON.stringify([url])), relay.url);
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", e => errors.push(String(e)));
  return { label, ctx, p, errors };
}
// every op as it travels (clean shape), sorted, and the SHA-256 of every book file
const state = p => p.evaluate(() => new Promise(ok => {
  const r = indexedDB.open("vicaria");
  r.onsuccess = () => {
    const t = r.result.transaction(["ops", "segs", "books"]); const out = { ops: [], books: [] };
    t.objectStore("ops").getAll().onsuccess = e => { for (const o of e.target.result) out.ops.push(o); };
    t.objectStore("segs").getAll().onsuccess = e => { for (const s of e.target.result) out.ops.push(...s.ops); };
    t.objectStore("books").getAll().onsuccess = e => { out.books = e.target.result.map(b => b.sha256).sort(); };
    t.oncomplete = () => {
      const clean = o => { const x = { id: o.id, dev: o.dev, t: o.t, k: o.k, v: o.v }; if (o.c !== undefined) x.c = o.c; if (o.b !== undefined && o.v.book === undefined) x.b = o.b; return JSON.stringify(x); };
      r.result.close(); ok({ ops: [...new Set(out.ops.map(clean))].sort(), books: out.books });
    };
  };
}));
const same = async (A, B, what) => {
  const [a, bb] = [await state(A.p), await state(B.p)];
  const onlyA = a.ops.filter(x => !bb.ops.includes(x)), onlyB = bb.ops.filter(x => !a.ops.includes(x));
  return { ok: !onlyA.length && !onlyB.length && a.books.join() === bb.books.join(), a, b: bb, onlyA, onlyB, what };
};
async function until(f, ms, what) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await f(); if (last?.ok ?? last) return last; await new Promise(r => setTimeout(r, 500)); } fail(`${what} (timed out)`); return last; }
async function openBook(p, id) { await p.goto(`${BASE}/book/${id}`); await p.locator(".prose [data-b]").first().waitFor(); }
async function select(p, block, from, len) {
  await p.evaluate(b => document.querySelector(`.prose [data-b="${b}"]`).scrollIntoView({ block: "center" }), block);
  await p.evaluate(({ block, from, len }) => {
    const el = document.querySelector(`.prose [data-b="${block}"]`);
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, off = 0, s, e;
    while ((n = w.nextNode())) { const L = n.data.length; if (!s && from < off + L) s = [n, from - off]; if (!e && from + len <= off + L) { e = [n, from + len - off]; break; } off += L; }
    const r = document.createRange(); r.setStart(...s); r.setEnd(...e); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { block, from, len });
  await p.locator(".seltools").waitFor({ timeout: 3000 });
}
// a valid EPUB of about `mb` megabytes (one chapter and a large stored image)
function bigEpub(mb) {
  const img = new Uint8Array(mb * 1e6); let x = 7; for (let i = 0; i < img.length; i++) { x = (x * 1103515245 + 12345) >>> 0; img[i] = x >>> 24; }
  img.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const files = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    "OEBPS/content.opf": strToU8('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">big-sync-test</dc:identifier><dc:title>A Large Atlas</dc:title><dc:creator>Test Maker</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="map.png" media-type="image/png"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c1"/></spine></package>'),
    "OEBPS/nav.xhtml": strToU8('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Maps</a></li></ol></nav></body></html>'),
    "OEBPS/c1.xhtml": strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Maps</title></head><body><h1>Maps</h1>${"<p>The coast runs north for many days, past the river mouths and the long white dunes where nobody lives.</p>".repeat(40)}<img src="map.png" alt="map"/></body></html>`),
    "OEBPS/map.png": [img, { level: 0 }],
  };
  return zipSync(files);
}

const A = await device("A"), B = await device("B");
// ---- 1. pair and swap marks ----
await A.p.goto(BASE + "/"); await A.p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
const classic = await A.p.evaluate(() => localStorage.getItem("vic:classic-id"));
await A.p.goto(BASE + "/settings"); await A.p.locator(".devices .btn", { hasText: "Pair a device" }).click();
const link = await A.p.locator('.devices input[aria-label="Pairing link"]').inputValue();
if (!/#pair=EXC1\.cp-[a-z0-9]+\.[A-Za-z0-9_-]{43}$/.test(link)) fail("pairing link looks wrong: " + link);
await B.p.goto(link); await B.p.locator(".devices .btn", { hasText: "Join" }).click();
await B.p.locator(".devices", { hasText: "Connected to 1 device" }).waitFor({ timeout: 30000 }).catch(() => fail("B did not connect to A"));
log("paired and connected");
await openBook(A.p, classic);
const blk = await A.p.evaluate(() => +[...document.querySelectorAll(".prose [data-b]")].find(e => (e.textContent || "").length > 120).dataset.b);
await select(A.p, blk, 5, 30); await A.p.locator(".seltools .sw.green").click();
await B.p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
let r = await until(() => same(A, B), 20000, "the highlight made on A did not reach B");
log("highlight synced", r?.a.ops.length, "ops");
await openBook(B.p, classic);
await B.p.waitForFunction(() => (window.__vicPainted?.() || []).some(m => m.c === "green"), null, { timeout: 10000 }).catch(() => fail("B does not draw A's highlight"));
// B adds a note to it; A gets it
await B.p.evaluate(() => { const m = window.__vicPainted().find(x => x.c === "green"); return m.id; });
const { clickMark } = await import("./drawn.mjs");
await clickMark(B.p, { c: "green" }); await B.p.locator(".popover.sheet textarea").fill("Noted on B. ñ “quotes”"); await B.p.locator(".popover.sheet .btn", { hasText: "Done" }).click();
r = await until(() => same(A, B), 20000, "the note written on B did not reach A");
if (!r?.ok) { console.log("only A:", r?.onlyA.slice(0, 3), "only B:", r?.onlyB.slice(0, 3)); for (const d of [A, B]) { await d.p.goto(BASE + "/settings"); await d.p.locator(".devices details summary").click().catch(() => {}); console.log(d.label, await d.p.locator(".devices").innerText().catch(() => "")); } }
await A.p.waitForFunction(() => (window.__vicPainted?.() || []).some(m => m.n), null, { timeout: 10000 }).catch(() => fail("A does not show B's note"));
log("note synced back; logs identical:", r?.ok);

// ---- 2. a 50 MB book, interrupted on B, resumed ----
const big = bigEpub(50), bigSha = createHash("sha256").update(big).digest("hex");
await A.p.goto(BASE + "/");
await A.ctx.route("**/test-atlas.epub", route => route.fulfill({ body: Buffer.from(big), contentType: "application/epub+zip" }));
await A.p.evaluate(async () => { const bytes = await (await fetch("/test-atlas.epub")).arrayBuffer(); const f = new File([bytes], "atlas.epub", { type: "application/epub+zip" }); const dt = new DataTransfer(); dt.items.add(f); window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt })); });
await A.p.waitForFunction(sha => JSON.parse(localStorage.getItem("vic:lib1") || "[]").some(b => b.sha256 === sha), bigSha, { timeout: 120000 }).catch(() => fail("A could not import the 50 MB book"));
log("50 MB book on A");
await B.p.goto(BASE + "/settings");
const partial = await until(async () => { const n = await B.p.evaluate(sha => new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => { const q = r.result.transaction("partials").objectStore("partials").getAllKeys(IDBKeyRange.bound([sha], [sha, []])); q.onsuccess = () => { r.result.close(); ok(q.result.length); }; }; }), bigSha); return n > 150 ? n : 0; }, 120000, "the big book did not start arriving on B");
await B.p.close(); log("B closed with", partial, "of", Math.ceil(big.length / 65536), "chunks");
B.p = await B.ctx.newPage(); B.p.on("pageerror", e => B.errors.push(String(e)));
await B.p.goto(BASE + "/settings");
const kept = await B.p.evaluate(sha => new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => { const q = r.result.transaction("partials").objectStore("partials").getAllKeys(IDBKeyRange.bound([sha], [sha, []])); q.onsuccess = () => { r.result.close(); ok(q.result.length); }; }; }), bigSha);
if (kept < partial) fail(`B lost chunks while closed (${partial} then ${kept})`);
r = await until(() => same(A, B), 180000, "the big book did not finish on B after resuming");
if (r && !r.b.books.includes(bigSha)) fail("B's copy of the big book has another SHA-256");
// hash the bytes B actually stored (OPFS, else IndexedDB), not the recorded checksum
const storedSha = await B.p.evaluate(async sha => {
  let blob = null;
  try { blob = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("originals")).getFileHandle(`${sha}.epub`)).getFile(); } catch { /* not in OPFS */ }
  if (!blob) blob = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => { const q = r.result.transaction("originals").objectStore("originals").get(sha); q.onsuccess = () => { r.result.close(); ok(q.result || null); }; }; });
  if (!blob) return null;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, "0")).join("");
}, bigSha);
if (storedSha !== bigSha) fail(`the bytes B stored hash to ${storedSha}, not ${bigSha}`);
log("50 MB book on B, resumed from", kept, "chunks; stored bytes hash the same:", storedSha === bigSha);

// ---- 3. relay only: devices never online together ----
await B.p.close();
await openBook(A.p, classic);
await select(A.p, blk + 1 < 9999 ? blk : blk, 40, 20); await A.p.locator(".seltools .sw.blue").click();
await A.p.waitForTimeout(6000); // the mailbox is written 1.5 s after a change
const before = relay.stored();
await A.p.close(); log("A closed; relay holds", before, "events");
B.p = await B.ctx.newPage(); B.p.on("pageerror", e => B.errors.push(String(e)));
await B.p.goto(BASE + "/settings");
// A's last highlight (blue) must be on B through the relay only (A is not open)
await until(async () => (await state(B.p)).ops.some(o => o.includes('"color":"blue"')), 30000, "B did not get A's change from the relay");
log("relay-only delivery ok");

// ---- 4. a device still on 0.x: its real sync code (sync.js, p2p.js) and its real Python sync behind the routes ----
const { execFileSync } = await import("node:child_process");
const { mkdtempSync, readFileSync, readdirSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const ROOT = new URL("../../", import.meta.url).pathname, PY = new URL("../tests/py/zero.py", import.meta.url).pathname;
const lib = link.match(/EXC1\.(cp-[a-z0-9]+)\./)[1], key = link.match(/\.([A-Za-z0-9_-]{43})$/)[1];
const dir = mkdtempSync(tmpdir() + "/vic0-");
const zero = (cmd, input, extra = []) => execFileSync("python3", [PY, dir, cmd, ...extra], { input, encoding: "utf8" });
const oldBook = JSON.parse(zero("setup", undefined, [ROOT + "tests/corpus/meditations-se.epub", lib])).book;
const C = await device("C (0.x)");
await C.ctx.addInitScript(({ lib, key, url }) => { localStorage.dev = "dev-old1"; localStorage.xsync = JSON.stringify({ lib, key, relays: [url] }); }, { lib, key, url: relay.url });
await C.ctx.routeWebSocket(u => !String(u).startsWith(relay.url), ws => ws.close()); // keep the test off public relays
await C.ctx.route("**/zero/**", async route => {
  const u = new URL(route.request().url()), path = u.pathname.replace(/^.*\/zero/, "");
  if (path === "/old.html") return route.fulfill({ contentType: "text/html", body: '<!doctype html><script>window.EXC_BASE="/zero";</script><script src="/zero/p2p.js"></script><script src="/zero/sync.js"></script>' });
  if (path === "/p2p.js") return route.fulfill({ contentType: "text/javascript", body: readFileSync(ROOT + "standalone/web/vendor/p2p.js") });
  if (path === "/sync.js") return route.fulfill({ contentType: "text/javascript", body: readFileSync(ROOT + "standalone/web/sync.js") });
  if (path === "/api/x/sync/export") return route.fulfill({ contentType: "application/json", body: zero("export") });
  if (path === "/api/x/sync/import") return route.fulfill({ contentType: "application/json", body: JSON.stringify(JSON.parse(zero("import", route.request().postData())).result) });
  if (path.startsWith("/api/x/epub/")) return route.fulfill({ contentType: "application/epub+zip", body: readFileSync(`${dir}/${decodeURIComponent(path.split("/").pop())}/book.epub`) });
  return route.fulfill({ status: 404, body: "{}" });
});
A.p = await A.ctx.newPage(); A.p.on("pageerror", e => A.errors.push(String(e)));
await A.p.goto(BASE + "/settings");
await C.p.goto(BASE.replace(/\/vicaria\/next$/, "") + "/zero/old.html");
const zeroOps = () => { const e = JSON.parse(zero("export")); return [...(e.books[oldBook] || []), ...e.reader].map(o => JSON.stringify(o)); };
const old0 = zeroOps();

// 0.x -> 1.0: its ops arrive with the same bytes, the book file is fetched and linked, its highlight is placed
await until(async () => { const s = await state(A.p); return old0.every(l => s.ops.includes(l.replace(/^\{(.*)\}$/, (m, x) => `{${x},"b":"${oldBook}"}`)) || s.ops.includes(l)); }, 40000, "0.x ops did not reach 1.0 unchanged");
await until(async () => (await state(A.p)).ops.some(o => o.includes('"k":"alias"') && o.includes(`"old":"${oldBook}"`)), 30000, "1.0 did not link the 0.x book");
log("0.x -> 1.0: ops identical, book linked");
await openBook(A.p, classic);
await A.p.waitForFunction(() => (window.__vicPainted?.() || []).some(m => /grandfather Verus/.test(m.text)), null, { timeout: 15000 }).catch(() => fail("the 0.x highlight is not drawn on 1.0"));
// 1.0 -> 0.x: removing and restoring the book on 1.0 writes shelf ops under the 0.x key, which 0.x stores unchanged
await A.p.goto(BASE + "/settings");
await A.p.locator(".manage li", { hasText: "Meditations" }).locator("button.link", { hasText: "Remove" }).click();
await A.p.locator(".manage li", { hasText: "Meditations" }).locator("button.btn.danger").click();
const shelfOp = await until(async () => (await state(A.p)).ops.find(o => o.includes('"k":"shelf"') && o.includes(`"book":"${oldBook}"`) && o.includes('"trash"')), 10000, "1.0 did not write a shelf op under the 0.x key");
await until(() => zeroOps().includes(shelfOp), 40000, "0.x did not store 1.0's shelf op unchanged");
log("1.0 -> 0.x: shelf op identical in 0.x");

if (process.env.SYNC_LINGER) await new Promise(r => setTimeout(r, +process.env.SYNC_LINGER));
for (const d of [A, B, C]) if (d.errors.length) fail(`${d.label}: page errors ${d.errors.join(" | ")}`);
await b.close(); await relay.close();
if (process.exitCode) console.error("sync e2e FAILED"); else console.log("sync e2e passed");

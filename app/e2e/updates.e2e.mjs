// End to end: updates in a real browser, through the real service worker.
//  1. Build A (normal) runs, the reader highlights and writes a note.
//  2. Build B arrives with a migration that fails. B switches in at launch, cannot open the library, steps back to A.
//     Afterwards: A is what runs, the database is at its old version with every record, B is remembered as bad.
//  3. Build C arrives with a migration that works. C upgrades the library, nothing is lost, a snapshot was saved.
//  4. Build D arrives while a note is being written: Reload waits until the note is saved, then switches.
//  5. Build E arrives while a note is open and the reader taps Reload: the note is saved first.
// Usage: node e2e/updates.e2e.mjs   (builds A to D itself into a temp folder; needs the app's devDependencies)
import { chromium } from "./engine.mjs";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { waitDrawn, clickMark } from "./drawn.mjs";

const APP = new URL("../", import.meta.url).pathname, BASEP = "/vicaria/next", PORT = 47830, URL0 = `http://127.0.0.1:${PORT}${BASEP}`;
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
// the last line names every failure, so a log cut to its tail still says what went wrong
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
const tmp = mkdtempSync(join(tmpdir(), "vic-upd-"));
const build = (name, env = {}) => {
  const out = join(tmp, name);
  execSync(`npx vite build --outDir ${out} --emptyOutDir --logLevel error && node scripts/postbuild.mjs`, { cwd: APP, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, VIC_BASE: BASEP + "/", VIC_DIST: out, ...env } });
  return { dir: out, version: readFileSync(join(out, "version.txt"), "utf8").trim() };
};
const A = build("a"), B = build("b", { VITE_TEST_MIGRATION: "fail" }), C = build("c", { VITE_TEST_MIGRATION: "ok" });
// D: the same files as C under a new build number (a new sw.js, so the browser sees an update)
const renumber = (name, ch) => {
  const x = { dir: join(tmp, name), version: (C.version[0] === ch ? "0" : ch) + C.version.slice(1) }; // never equal to C (a hash can start with d or e)
  cpSync(C.dir, x.dir, { recursive: true });
  writeFileSync(join(x.dir, "sw.js"), readFileSync(join(x.dir, "sw.js"), "utf8").replace(C.version, x.version)); writeFileSync(join(x.dir, "version.txt"), x.version + "\n");
  return x;
};
const D = renumber("d", "d"), E = renumber("e", "e");
console.log(`builds A ${A.version}, B ${B.version} (failing migration), C ${C.version}, D ${D.version}`);

let live = A.dir;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".png": "image/png", ".epub": "application/epub+zip", ".txt": "text/plain", ".svg": "image/svg+xml" };
const server = createServer(async (req, out) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (!path.startsWith(BASEP + "/")) { out.writeHead(404); out.end(); return; }
  path = path.slice(BASEP.length); if (path.endsWith("/")) path += "index.html";
  try { const f = join(live, path); if ((await stat(f)).isDirectory()) throw 0; out.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream", "cache-control": "no-cache" }); out.end(await readFile(f)); }
  catch { out.writeHead(404, { "content-type": TYPES[".html"] }); out.end(await readFile(join(live, "404.html"))); }
});
await new Promise(ok => server.listen(PORT, "127.0.0.1", ok));

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const p = await ctx.newPage();
const errors = []; p.on("pageerror", e => errors.push(String(e)));
p.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.log("console:", m.text().slice(0, 200)); });

// everything a reader cannot get back, read straight from the database
const library = () => p.evaluate(async () => {
  const d = await new Promise((ok, bad) => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  const all = s => d.objectStoreNames.contains(s) ? new Promise(ok => { const q = d.transaction(s).objectStore(s).getAll(); q.onsuccess = () => ok(q.result); }) : [];
  const keys = s => d.objectStoreNames.contains(s) ? new Promise(ok => { const q = d.transaction(s).objectStore(s).getAllKeys(); q.onsuccess = () => ok(q.result); }) : [];
  const ops = [...await all("ops"), ...(await all("segs")).flatMap(s => s.ops)].map(o => { const { bk, ...r } = o; return JSON.stringify(r); }).sort();
  const books = (await all("books")).map(x => x.id + ":" + x.sha256).sort();
  const kvk = (await keys("kv")).map(String).sort();
  const out = { version: d.version, stores: [...d.objectStoreNames].sort(), ops, books, kv: kvk };
  d.close(); return out;
});
const runningBuild = () => p.evaluate(async base => (await (await fetch(base + "/version.txt")).text()).trim(), BASEP);
const swMeta = () => p.evaluate(async () => { const c = await caches.open("vic-meta"); const r = await c.match("meta"); return r ? r.json() : null; });
const settle = async (want, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await runningBuild()) === want) return true; } catch { /* reloading */ } await p.waitForTimeout(300); } return false; };
const keptAll = (before, after, label) => {
  const have = new Set(after.ops), lost = before.ops.filter(o => !have.has(o));
  if (lost.length) fail(`${label}: ${lost.length} of ${before.ops.length} changes lost, first ${lost[0].slice(0, 120)}`);
  for (const x of before.books) if (!after.books.includes(x)) fail(`${label}: book ${x} lost`);
  for (const k of before.kv) if (!after.kv.includes(k)) fail(`${label}: setting ${k} lost`);
};

// ---- 1. build A, with a library ----
await p.goto(URL0 + "/");
await p.waitForFunction(() => !!navigator.serviceWorker.controller || new Promise(ok => navigator.serviceWorker.addEventListener("controllerchange", () => ok(true))), null, { timeout: 30000 });
await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
await p.goto(`${URL0}/book/${id}`);
await p.locator(".prose [data-b]").first().waitFor();
const blk = await p.evaluate(() => +[...document.querySelectorAll(".prose [data-b]")].find(e => (e.textContent || "").length > 120).dataset.b);
async function highlight(color, from) {
  await p.evaluate(({ block, from }) => {
    const el = document.querySelector(`.prose [data-b="${block}"]`); el.scrollIntoView({ block: "center" });
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, off = 0, s, e;
    while ((n = w.nextNode())) { const L = n.data.length; if (!s && from < off + L) s = [n, from - off]; if (!e && from + 20 <= off + L) { e = [n, from + 20 - off]; break; } off += L; }
    const r = document.createRange(); r.setStart(...s); r.setEnd(...e); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { block: blk, from });
  await p.locator(`.seltools .sw.${color}`).click();
  if (!await waitDrawn(p, x => x.c === color)) fail(`highlight ${color} not drawn`);
}
await highlight("yellow", 5); await highlight("blue", 60);
await clickMark(p, { c: "yellow" });
await p.locator(".popover.sheet textarea").fill("Una nota que no se puede perder. 📚");
await p.locator(".popover.sheet .btn", { hasText: "Done" }).click();
await p.waitForTimeout(2500); // the reading position is saved two seconds after the last move
const before = await library();
console.log(`A: database v${before.version}, ${before.ops.length} changes, ${before.books.length} book(s)`);
if (!before.ops.some(o => o.includes("Una nota que no se puede perder"))) fail("A: the note was not stored");

// ---- 2. build B: its migration fails, it steps back to A ----
live = B.dir;
await p.goto(URL0 + "/"); // the browser checks sw.js on navigation; B installs and switches in at launch
const sawB = await settle(B.version, 20000); // B may run only for a moment before stepping back
const back = await settle(A.version, 30000);
if (!back) fail(`B: the app did not step back to A (running ${await runningBuild().catch(() => "?")})`);
await p.waitForTimeout(1500);
const afterB = await library(), meta = await swMeta();
if (afterB.version !== before.version) fail(`B: database at v${afterB.version}, want v${before.version}`);
if (afterB.stores.includes("test_extra")) fail("B: the failed migration left a store behind");
keptAll(before, afterB, "B");
if (!meta?.bad?.includes(B.version)) fail(`B: not remembered as bad (${JSON.stringify(meta)})`);
await p.goto(URL0 + "/"); await p.waitForTimeout(2000);
if ((await runningBuild()) !== A.version) fail("B: a second launch did not stay on A");
await p.locator("a.book-card").first().waitFor({ timeout: 10000 }).catch(() => fail("B: no books on the shelf after stepping back"));
console.log(`B: ${sawB ? "ran, " : ""}${back ? "failed its migration, stepped back to A" : "did NOT step back"}; database v${afterB.version}, ${afterB.ops.length} changes; bad: ${meta?.bad}`);

// ---- 3. build C: the migration works ----
live = C.dir;
await p.goto(URL0 + "/");
if (!await settle(C.version, 30000)) fail(`C: did not switch to C (running ${await runningBuild().catch(() => "?")})`);
await p.waitForTimeout(1500);
const afterC = await library();
if (afterC.version !== before.version + 1 || !afterC.stores.includes("test_extra")) fail(`C: database v${afterC.version}, stores ${afterC.stores}`);
keptAll(before, afterC, "C");
const snaps = await p.evaluate(async () => { try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("snapshots"); const out = []; for await (const k of d.keys()) out.push(k); return out; } catch { return []; } });
if (!snaps.some(s => s.startsWith(`v${before.version}-to-v${before.version + 1}-`))) fail(`C: no snapshot before the upgrade (${snaps})`);
await p.locator("a.book-card").first().waitFor({ timeout: 10000 }).catch(() => fail("C: no books on the shelf"));
// Settings offers the copy saved before the upgrade; it brings back a change that went missing, and only that
await p.goto(URL0 + "/settings");
const bring = p.locator("button", { hasText: "Bring back anything missing" });
await bring.waitFor({ timeout: 10000 }).catch(() => fail("C: Settings does not offer the copy saved before the update"));
if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + "/settings-before-update.png", fullPage: true });
await bring.click();
await p.locator(".toast", { hasText: "Nothing was missing" }).waitFor({ timeout: 5000 }).catch(() => fail("C: restore on a complete library did not say nothing was missing"));
const dropped = await p.evaluate(async () => {
  const d = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); });
  const t = d.transaction(["ops", "opids"], "readwrite"), ops = await new Promise(ok => { const q = t.objectStore("ops").getAll(); q.onsuccess = () => ok(q.result); });
  const victim = ops.find(o => o.k === "mark"); t.objectStore("ops").delete(victim.id); t.objectStore("opids").delete(victim.id);
  await new Promise(ok => { t.oncomplete = ok; }); d.close(); return victim.id;
});
await p.reload(); await bring.waitFor();
await bring.click();
await p.locator(".toast", { hasText: "Brought back 1 change" }).waitFor({ timeout: 5000 }).catch(() => fail(`C: restore did not bring back the removed change ${dropped}`));
keptAll(before, await library(), "C restore");
console.log(`C: upgraded to v${afterC.version}, ${afterC.ops.length} changes kept, snapshot ${snaps.join(", ")}`);

// ---- 4. build D arrives while a note is being written ----
await p.goto(`${URL0}/book/${id}`);
await p.locator(".prose [data-b]").first().waitFor();
await waitDrawn(p, x => x.c === "blue");
await clickMark(p, { c: "blue" });
await p.locator(".popover.sheet textarea").fill("Escribiendo mientras llega una versión nueva");
live = D.dir;
await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
const toast = p.locator(".toast", { hasText: "new version" });
await toast.waitFor({ timeout: 20000 }).catch(() => fail("D: no offer to reload"));
// pressed without moving focus, so the note stays open (a real tap outside would close and save it)
await p.evaluate(() => [...document.querySelectorAll(".toast button")].find(x => x.textContent === "Reload")?.click());
await p.waitForTimeout(3000);
if ((await runningBuild()) !== C.version) fail("D: reloaded while a note was being written");
if ((await p.locator(".popover.sheet textarea").inputValue().catch(() => "")) !== "Escribiendo mientras llega una versión nueva") fail("D: the note being written was lost");
await p.locator(".popover.sheet .btn", { hasText: "Done" }).click();
if (!await settle(D.version, 20000)) fail("D: did not switch after the note was saved");
await p.waitForTimeout(1000);
const afterD = await library();
keptAll(afterC, afterD, "D");
if (!afterD.ops.some(o => o.includes("Escribiendo mientras llega"))) fail("D: the note written during the update is missing");
console.log(`D: waited for the note, then switched; ${afterD.ops.length} changes`);

// ---- 5. build E arrives while a note is open, and the reader taps Reload for real ----
await p.goto(`${URL0}/book/${id}`);
await p.locator(".prose [data-b]").first().waitFor();
await waitDrawn(p, x => x.c === "yellow");
await clickMark(p, { c: "yellow" });
await p.locator(".popover.sheet textarea").fill("Nota cambiada justo antes de recargar");
live = E.dir;
await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
const toastE = p.locator(".toast", { hasText: "new version" });
await toastE.waitFor({ timeout: 20000 }).catch(() => fail("E: no offer to reload"));
await toastE.locator("button", { hasText: "Reload" }).click().catch(() => {});
if (!await settle(E.version, 20000)) fail("E: did not switch after Reload");
await p.waitForTimeout(1500);
const afterE = await library();
keptAll(afterD, afterE, "E");
if (!afterE.ops.some(o => o.includes("Nota cambiada justo antes de recargar"))) fail("E: the open note was not saved before the switch");
console.log(`E: a real tap on Reload saved the open note, then switched; ${afterE.ops.length} changes`);

if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
await b.close(); server.close();
console.log(process.exitCode ? "updates e2e FAILED" : "updates e2e passed");

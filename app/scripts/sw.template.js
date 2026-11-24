// Vicaria service worker: the whole app is kept on the device, so it opens with no connection and no wait.
// Updates (DESIGN section 10): a new build downloads in the background and waits; the page decides when to switch,
// never in the middle of work. The build before it stays cached, so a build that cannot open the library can step
// back to it ("rollback"). update.json at the site root can hold a build back or mark one bad.
const VERSION = "__VERSION__";
const BASE = "__BASE__";
const FILES = __FILES__;
const CACHE = "vic-" + VERSION;
const META = "vic-meta"; // { current, previous, pinned, bad: [], bucket }

async function meta() {
  const r = await (await caches.open(META)).match("meta");
  return r ? r.json() : { bad: [] };
}
async function setMeta(m) { await (await caches.open(META)).put("meta", new Response(JSON.stringify(m))); }
let serving = null; // the cache pages get: this build's, or the previous one after a rollback
async function servingCache() { if (!serving) { const m = await meta(); serving = m.pinned && m.pinned === m.previous ? m.pinned : CACHE; } return serving; }

// Before installing: ask update.json whether this build may go out to this device yet. No answer (offline, no
// file): install, since an update that downloads at all came from the network that holds the file.
async function allowed() {
  try {
    const r = await fetch(BASE + "/update.json", { cache: "no-store" });
    if (!r.ok) return true;
    const u = await r.json(), m = await meta();
    if (Array.isArray(u.bad) && u.bad.includes(VERSION)) return false;
    if (typeof u.rollout === "number" && u.rollout < 100 && (!u.build || u.build === VERSION)) {
      if (typeof m.bucket !== "number") { m.bucket = Math.floor(Math.random() * 100); await setMeta(m); }
      if (m.bucket >= u.rollout) return false;
    }
  } catch { /* no answer */ }
  return true;
}
self.addEventListener("install", e => {
  e.waitUntil(allowed().then(ok => {
    if (!ok) throw new Error("held back by update.json");
    return caches.open(CACHE).then(c => c.addAll(FILES));
  }));
});
self.addEventListener("message", e => {
  const d = e.data, reply = v => e.ports[0]?.postMessage(v);
  if (d === "skip" || d?.t === "skip") { self.skipWaiting(); return; }
  if (d?.t === "info") { e.waitUntil(Promise.all([meta(), servingCache(), self.clients.matchAll({ type: "window" })]).then(([m, s, cs]) => reply({ version: VERSION, serving: s.slice(4), previous: m.previous?.slice(4) ?? null, bad: m.bad, clients: cs.length }))); return; }
  if (d?.t === "rollback") {
    e.waitUntil((async () => {
      const m = await meta();
      if (!m.previous || !(await caches.has(m.previous))) return reply({ ok: false });
      m.pinned = m.previous; m.bad = [...new Set([...(m.bad || []), VERSION])].slice(-10); m.why = String(d.why || "").slice(0, 200);
      await setMeta(m); serving = m.pinned;
      reply({ ok: true, to: m.previous.slice(4) });
    })());
  }
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const m = await meta();
    if (m.current !== CACHE) {
      // the build to step back to is the last good one: a build that was stepped back from never becomes it
      if (m.current && !(m.bad || []).includes(m.current.slice(4)) && await caches.has(m.current)) m.previous = m.current;
      m.current = CACHE;
    }
    delete m.pinned; // a new build replaced the one that was stepped back from
    await setMeta(m); serving = null;
    const keep = new Set([META, m.current, m.previous, m.pinned].filter(Boolean));
    await Promise.all((await caches.keys()).filter(k => k.startsWith("vic-") && !keep.has(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
// code fetched the first time it is needed (math, diagrams) is kept with the build that asked for it
async function later(req, name) {
  const r = await fetch(req);
  if (r.ok && new URL(req.url).pathname.startsWith(BASE + "/assets/")) (await caches.open(name)).put(req, r.clone()).catch(() => {});
  return r;
}
// Cross-origin isolation (threads for the models: about 3 times faster). GitHub Pages cannot send the headers, so
// every answer from this worker carries them. COEP "credentialless" lets other sites' covers and fonts load without
// their consent (they are fetched without cookies); COOP "same-origin" would cut a sign-in window off from its
// opener, and the app opens none (links open with noopener). The first visit is not yet controlled; from the next
// load on the page is isolated.
function isolated(r) {
  if (!r || r.type === "opaque" || r.type === "opaqueredirect" || r.status === 0 || r.status === 101) return r;
  const h = new Headers(r.headers);
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}
self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin || !u.pathname.startsWith(BASE + "/")) return;
  if (u.pathname === BASE + "/update.json" || u.pathname === BASE + "/sw.js") return;
  e.respondWith(servingCache().then(name => (req.mode === "navigate"
    ? caches.match(BASE + "/index.html", { cacheName: name }).then(r => r || fetch(req))
    : caches.match(req, { cacheName: name, ignoreSearch: true }).then(r => r || later(req, name))).then(isolated)));
});

// the optional daily reminder (src/wiser/notify.ts): a tap opens Vicaria, or brings its window forward
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow(BASE + "/")));
});

// Commonplace standalone service worker. The app's files are kept on the device at install, so it opens with no
// connection. Every /api request is answered on the device: from a small cache of read-only answers when possible,
// otherwise by the page's on-device server (standalone.js -> worker.js). No /api request ever goes to the network.
const VERSION = "__VERSION__";
const BASE = "__BASE__";
const FILES = __FILES__;
const SHELL = "cp-shell-" + VERSION, API = "cp-api-v1";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("cp-shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Answers that only change when the book itself changes; everything else is dropped after any write.
const CACHEABLE = [/^\/api\/books$/, /^\/api\/library$/, /^\/api\/trash$/, /^\/api\/settings$/, /^\/api\/voices$/, /^\/api\/graph$/,
  /^\/api\/books\/[^/]+$/, /^\/api\/books\/[^/]+\/(core|matter|cover|position|highlights|glossary|structure)$/,
  /^\/api\/books\/[^/]+\/chapters\/\d+(\/card)?$/, /^\/api\/books\/[^/]+\/image$/];
const IMMUTABLE = /^\/api\/books\/([^/]+)\/(chapters\/\d+|matter|cover|image)$/;

const strip = p => p.startsWith(BASE + "/") ? p.slice(BASE.length) : p;
async function invalidate(path) {
  const c = await caches.open(API);
  const book = (path && path.match(/^\/api\/books\/([^/]+)(\/structure|$)/)) || [];
  for (const req of await c.keys()) {
    const p = strip(new URL(req.url).pathname), m = p.match(IMMUTABLE);
    if (!m || (book[1] && m[1] === book[1])) await c.delete(req);
  }
}
self.addEventListener("message", e => { if (e.data?.type === "invalidate") e.waitUntil(invalidate()); });

async function relay(e, req, u) {
  let client = e.clientId && await self.clients.get(e.clientId);
  if (!client) client = (await self.clients.matchAll({ type: "window" }))[0];
  if (!client) return new Response(JSON.stringify({ error: "Open Commonplace first." }), { status: 503, headers: { "Content-Type": "application/json" } });
  const headers = {};
  for (const [k, v] of req.headers) headers[k] = v;
  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
  const ch = new MessageChannel();
  const got = new Promise(ok => { ch.port1.onmessage = m => ok(m.data); });
  client.postMessage({ type: "api", req: { method: req.method, path: strip(u.pathname) + u.search, headers, body } }, [ch.port2, ...(body ? [body] : [])]);
  const r = await got;
  return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
}

async function api(e, req, u) {
  const path = strip(u.pathname);
  const cacheable = req.method === "GET" && !u.search.includes("make=1") && CACHEABLE.some(re => re.test(path));
  const key = u.pathname + u.search;
  if (cacheable) {
    const hit = await (await caches.open(API)).match(key);
    if (hit) return hit;
  }
  const res = await relay(e, req, u);
  const writes = req.method !== "GET" || /[?&]make=1/.test(u.search) || path.endsWith("/distill");
  if (writes) await invalidate(path);
  else if (cacheable && res.status === 200) await (await caches.open(API)).put(key, res.clone());
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (u.origin !== location.origin) return;  // AI providers: straight from the browser
  if (u.pathname.startsWith(BASE + "/api/")) return e.respondWith(api(e, req, u));
  if (req.method !== "GET") return;
  if (req.mode === "navigate") return e.respondWith(caches.match(BASE + "/index.html", { cacheName: SHELL }).then(r => r || fetch(BASE + "/index.html")));
  e.respondWith(caches.match(req, { cacheName: SHELL, ignoreSearch: true }).then(r => r || fetch(req)));
});

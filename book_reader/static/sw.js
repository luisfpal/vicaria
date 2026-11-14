// Commonplace service worker: the app opens without a connection, and books kept offline can be read anywhere.
// Shell files: served from the cache at once and refreshed in the background (stale-while-revalidate).
// Book data: network first, the cached copy when there is no connection. Narration and writes always use the network.
const SHELL = "shell-v6b";
const SHELL_FILES = ["/", "/static/app.js", "/static/app.css", "/static/vendor/marked.min.js", "/static/vendor/purify.min.js", "/manifest.webmanifest",
  "/static/icons/icon-192.png", "/static/fonts/literata.woff2", "/static/fonts/literata-italic.woff2"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("shell-") && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function fresh(req, cacheName, key) {
  const c = await caches.open(cacheName);
  const hit = await c.match(key || req);
  const net = fetch(req).then(r => { if (r.ok) c.put(key || req, r.clone()); return r; }).catch(() => null);
  return hit || (await net) || new Response("Offline", { status: 503 });
}
async function networkFirst(req) {
  try {
    const r = await fetch(req);
    if (r.ok) (await caches.open("books")).put(req, r.clone());
    return r;
  } catch {
    const hit = await caches.match(req);
    return hit || new Response(JSON.stringify({ error: "You are offline and this is not kept on this device." }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
}
self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;
  if (req.mode === "navigate") return e.respondWith(fetch(req).catch(() => caches.match("/", { cacheName: SHELL })));
  if (u.pathname.startsWith("/static/") || u.pathname === "/manifest.webmanifest") return e.respondWith(fresh(req, SHELL));
  if (u.pathname === "/api/tts" || u.pathname.startsWith("/api/sync") || u.pathname === "/api/settings") return;
  if (u.pathname.startsWith("/api/")) return e.respondWith(networkFirst(req));
});

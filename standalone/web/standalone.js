// Excerpta: everything runs on this device. The service worker sends each /api request here, and the on-device
// server (worker.js: the Python book_reader package in Pyodide) answers it. Nothing leaves the device except AI
// requests (straight from this browser to the provider whose key you saved) and sync (see sync.js).
(() => {
  const BASE = window.EXC_BASE || "";
  // The app was written for the root of a site; when it lives under a path (GitHub Pages: /excerpta), every absolute
  // URL it makes gets that prefix, and the routes it reads lose it.
  const fix = u => typeof u === "string" && BASE && u.startsWith("/") && !u.startsWith("//") && u !== BASE && !u.startsWith(BASE + "/") ? BASE + u : u;
  window.xPath = () => BASE && location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) || "/" : location.pathname;
  if (BASE) {
    const sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (k, v) { return sa.call(this, k, (k === "href" || k === "src") ? fix(v) : v); };
    for (const f of ["pushState", "replaceState"]) { const o = history[f].bind(history); history[f] = (s, t, u) => o(s, t, fix(u)); }
    const of = window.fetch.bind(window); window.fetch = (u, o) => of(fix(u), o);
    const ES = window.EventSource; window.EventSource = function (u, o) { return new ES(fix(u), o); };
  }

  const status = document.createElement("div");
  status.id = "cp-boot";
  status.style.cssText = "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);background:var(--ink,#222);color:var(--paper,#fff);padding:6px 12px;border-radius:14px;font:13px system-ui;opacity:.85;z-index:99;display:none";
  const say = t => { status.textContent = t; status.style.display = t ? "block" : "none"; };
  document.addEventListener("DOMContentLoaded", () => document.body.append(status));

  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    document.getElementById("app").textContent = "This browser cannot run Excerpta (it needs service workers over https).";
    return;
  }

  let worker = null, ready = false, seq = 0;
  const waiting = new Map();
  function startWorker() {
    if (worker) return;
    worker = new Worker(BASE + "/worker.js", { type: "module" });
    worker.onmessage = e => {
      const m = e.data;
      if ("ready" in m) { ready = m.ready; say(m.ready ? "" : "Could not start: " + m.error); return; }
      if ("busy" in m) { say(m.busy ? "Working on your book in the background…" : ""); if (m.changed) { navigator.serviceWorker.controller?.postMessage({ type: "invalidate" }); window.ExcSync?.changed(); } return; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    };
  }
  function ask(req) {
    startWorker();
    if (!ready) say("Opening your library…");
    return new Promise(ok => { const id = ++seq; waiting.set(id, ok); worker.postMessage({ id, ...req }, req.body ? [req.body] : []); });
  }

  navigator.serviceWorker.addEventListener("message", async e => {
    if (e.data?.type !== "api") return;
    const port = e.ports[0], req = e.data.req;
    const res = await ask(req);
    port.postMessage(res, [res.body]);
    // a change worth sending to your other devices
    if ((req.method !== "GET" && !req.path.startsWith("/api/x/")) || /[?&]make=1/.test(req.path)) window.ExcSync?.changed();
  });

  const load = src => new Promise((ok, bad) => { const s = document.createElement("script"); s.src = BASE + src; s.onload = ok; s.onerror = bad; document.body.append(s); });
  async function boot() {
    await navigator.serviceWorker.register(BASE + "/sw.js", { scope: BASE + "/" });
    if (!navigator.serviceWorker.controller) {
      say("Setting up on this device…");
      await new Promise(ok => navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true }));
    }
    startWorker();  // warm the on-device server while the cached pages draw
    await load("/static/app.js");
    await load("/static/x/sync.js");
    await load("/static/x/panels.js");
    await load("/static/x/ai.js");
  }
  boot().catch(e => { document.getElementById("app").textContent = "Could not start Excerpta: " + e.message; });
})();

// Excerpta: the Discover and Devices panels, added next to the app's own pages.
(() => {
  const BASE = window.EXC_BASE || "";
  const SE = "https://standardebooks.org";
  const CLASSICS = [
    ["marcus-aurelius/meditations/george-long", "Meditations", "Marcus Aurelius"],
    ["seneca/moral-letters-to-lucilius/richard-m-gummere", "Moral Letters to Lucilius", "Seneca"],
    ["laozi/tao-te-ching/james-legge", "Tao Te Ching", "Laozi"],
    ["sun-tzu/the-art-of-war/lionel-giles", "The Art of War", "Sun Tzu"],
    ["hermann-hesse/siddhartha/various-translators", "Siddhartha", "Hermann Hesse"],
    ["jane-austen/pride-and-prejudice", "Pride and Prejudice", "Jane Austen"],
    ["mary-shelley/frankenstein", "Frankenstein", "Mary Shelley"],
    ["homer/the-odyssey/william-cullen-bryant", "The Odyssey", "Homer"],
  ];
  const h = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k.startsWith("on") ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v); n.append(...kids.flat(9).filter(k => k != null && k !== false)); return n; };
  const css = `#x-panel{position:fixed;inset:0;z-index:60;background:var(--paper,#f7f4ee);color:var(--ink,#1f1d1a);overflow:auto;padding:16px 16px 80px}
#x-panel .x-in{max-width:760px;margin:0 auto}#x-panel h2{font-family:var(--serif,Georgia,serif);margin:6px 0 4px}#x-panel .x-top{display:flex;justify-content:space-between;align-items:center}
#x-panel .x-muted{opacity:.7;font-size:14px}#x-panel input,#x-panel textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border-radius:10px;border:1px solid #0002;background:#fff8}
#x-panel .x-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px;margin-top:12px}#x-panel .x-book{display:flex;flex-direction:column;gap:6px}
#x-panel .x-book img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:6px;background:#0001}#x-panel .x-book b{font-size:14px;line-height:1.25}#x-panel .x-book span{font-size:13px;opacity:.7}
#x-panel button{font:inherit;cursor:pointer}#x-panel .x-btn{background:var(--ink,#1f1d1a);color:var(--paper,#fff);border:0;border-radius:18px;padding:8px 14px}#x-panel .x-ghost{background:transparent;border:1px solid #0003;border-radius:18px;padding:7px 13px;color:inherit}
#x-panel .x-qr svg{width:220px;height:220px;background:#fff;border-radius:10px}#x-panel code{word-break:break-all;font-size:12px}#x-panel .x-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
#x-panel ul.x-log{font-size:13px;opacity:.75;padding-left:18px}
@media (max-width:520px){header.bar .brand{display:none}header.bar nav{gap:12px}}`;
  document.head.append(h("style", {}, css));
  const api = async (p, o) => { const r = await fetch(BASE + p, o); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; };

  let panel = null;
  function show(title, body) {
    close();
    panel = h("div", { id: "x-panel", role: "dialog", "aria-label": title }, h("div", { class: "x-in" },
      h("div", { class: "x-top" }, h("h2", {}, title), h("button", { class: "x-ghost", onclick: close, "aria-label": "Close" }, "Close")), body));
    document.body.append(panel);
  }
  function close() { panel?.remove(); panel = null; window.ExcSync?.onPanel(() => {}); }
  const toast = t => window.toast ? window.toast(t) : null;

  // -- Discover: Standard Ebooks (free, carefully produced public-domain books, downloadable from any browser) --
  async function addBook(path, title, btn) {
    btn.disabled = true; btn.textContent = "Adding…";
    try {
      const slug = path.replace(/\//g, "_");
      const r = await fetch(`${SE}/ebooks/${path}/downloads/${slug}.epub?source=download`);
      if (!r.ok) throw new Error("download failed (" + r.status + ")");
      const book = await api("/api/books", { method: "POST", headers: { "X-Filename": slug + ".epub" }, body: await r.blob() });
      close(); window.go ? window.go(`${BASE}/book/${book.id}`) : (location.href = `${BASE}/book/${book.id}`);
    } catch (e) { btn.disabled = false; btn.textContent = "Try again"; toast?.("Could not add " + title + ": " + e.message); }
  }
  const cover = path => `${SE}/ebooks/${path}/downloads/cover-thumbnail.jpg`;
  const card = (path, title, author, img) => h("div", { class: "x-book" },
    h("img", { src: img || cover(path), alt: "", loading: "lazy", onerror: e => { e.target.style.visibility = "hidden"; } }),
    h("b", {}, title), h("span", {}, author), h("button", { class: "x-btn", onclick: e => addBook(path, title, e.target) }, "Add"));
  async function search(q, out) {
    out.replaceChildren(h("p", { class: "x-muted" }, "Searching…"));
    try {
      const html = await (await fetch(`${SE}/ebooks?query=${encodeURIComponent(q)}&per-page=24`)).text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const items = [...doc.querySelectorAll('li[typeof="schema:Book"]')].map(li => {
        const path = (li.getAttribute("about") || "").replace(/^\/ebooks\//, "");
        const img = li.querySelector("img")?.getAttribute("src");
        return [path, li.querySelector('[property="schema:name"]')?.textContent.trim(), li.querySelector(".author [property='schema:name']")?.textContent.trim() || "", img ? SE + img : null];
      }).filter(x => x[0] && x[1] && x[0].split("/").length >= 2);
      out.replaceChildren(items.length ? h("div", { class: "x-grid" }, items.map(x => card(...x))) : h("p", { class: "x-muted" }, "Nothing found. Try an author or a shorter title."));
    } catch (e) { out.replaceChildren(h("p", { class: "x-muted" }, "Search needs a connection. " + e.message)); }
  }
  function discover() {
    const out = h("div", {}, h("p", { class: "x-muted" }, "Start with a classic:"), h("div", { class: "x-grid" }, CLASSICS.map(([p, t, a]) => card(p, t, a))));
    const input = h("input", { type: "search", placeholder: "Search free classics: title or author", enterkeyhint: "search" });
    input.addEventListener("keydown", e => { if (e.key === "Enter" && input.value.trim()) search(input.value.trim(), out); });
    show("Discover", [h("p", { class: "x-muted" }, "Free public-domain books from Standard Ebooks. One tap adds a book to this device."), input, out,
      h("p", { class: "x-muted" }, "Have your own EPUB? Use “Add a book” in the Library. Project Gutenberg files work too: download the EPUB, then add it.")]);
    input.focus();
  }

  // -- Devices: pairing and sync ---------------------------------------------------------------------------------
  function devices() {
    const S = window.ExcSync, body = h("div", {});
    const paint = () => {
      if (!S.paired()) {
        const code = h("input", { placeholder: "Paste a pairing code or link" });
        body.replaceChildren(
          h("p", {}, "Keep your library, highlights and cards the same on all your devices. No account and no server: your devices talk to each other directly, and when they cannot, an encrypted copy waits on public relays that cannot read it."),
          h("div", { class: "x-row" }, h("button", { class: "x-btn", onclick: async () => { await S.create(); paint(); } }, "Set up sync on this device")),
          h("p", { class: "x-muted" }, "Already set up on another device? Scan its code with this device's camera, or paste it here:"),
          code, h("div", { class: "x-row" }, h("button", { class: "x-ghost", onclick: async () => { try { await S.join(code.value); paint(); toast?.("Paired"); } catch (e) { toast?.(e.message); } } }, "Join")));
        return;
      }
      const peers = S.peers(), direct = Object.values(peers).filter(p => p.direct).length;
      const missing = new Map();
      for (const p of Object.values(peers)) for (const b of p.have || []) missing.set(b.id, b.title);
      const mine = new Set(paint.mine || []);
      const relays = h("textarea", { rows: 3, placeholder: "wss://your-relay.example (one per line)" }, (JSON.parse(localStorage.xsync || "{}").relays || []).join("\n"));
      const st = S.stats, ago = x => x ? `${Math.round((Date.now() - x.at) / 1000)} s ago, ${x.ms} ms in transit` : "not yet";
      body.replaceChildren(
        h("div", { class: "x-row" }, h("div", { class: "x-qr" }), h("div", {}, h("p", {}, "To add a phone or computer, point its camera at this code. Or send yourself the link:"),
          h("div", { class: "x-row" }, h("button", { class: "x-ghost", onclick: () => navigator.clipboard.writeText(S.link()).then(() => toast?.("Link copied. Open it on your other device.")) }, "Copy link")),
          h("p", { class: "x-muted" }, "Anyone with this code or link can read your library. Share it only with your own devices."))),
        h("p", {}, direct ? `${direct} device${direct > 1 ? "s" : ""} connected directly.` : "No other device connected directly right now; changes wait on the relays."),
        h("p", { class: "x-muted" }, `Last direct sync: ${ago(st.direct)}. Last relay sync: ${ago(st.relay)}.`),
        h("div", { class: "x-row" }, h("button", { class: "x-btn", onclick: () => S.syncNow().then(() => toast?.("Synced")) }, "Sync now"),
          h("button", { class: "x-ghost", onclick: async () => { const b = await S.exportFile(); const a = h("a", { href: URL.createObjectURL(b), download: "excerpta-sync.txt" }); a.click(); } }, "Save a sync file"),
          h("label", { class: "x-ghost" }, "Open a sync file", h("input", { type: "file", style: "display:none", onchange: async e => { try { await S.importFile(await e.target.files[0].text()); toast?.("Merged"); } catch (x) { toast?.("That file is not for this library."); } } }))),
        [...missing].filter(([id]) => !mine.has(id)).length ? h("div", {}, h("p", {}, "On your other devices:"),
          [...missing].filter(([id]) => !mine.has(id)).map(([id, t]) => h("div", { class: "x-row" }, h("span", {}, t), direct ? h("button", { class: "x-ghost", onclick: () => { S.want(id); toast?.("Asking for " + t); } }, "Get it here") : null))) : null,
        h("details", {}, h("summary", {}, "Relays"), h("p", { class: "x-muted" }, "Public Nostr relays used to find your devices and hold encrypted copies: " + S.relays().join(", ") + ". Add your own:"), relays,
          h("div", { class: "x-row" }, h("button", { class: "x-ghost", onclick: () => { S.setRelays(relays.value.split(/\s+/).filter(Boolean)); toast?.("Saved"); } }, "Save relays"))),
        h("ul", { class: "x-log" }, st.log.map(l => h("li", {}, l))),
        h("button", { class: "x-ghost", onclick: async () => { if (confirm("Stop syncing on this device? Your books stay here.")) { await S.unpair(); paint(); } } }, "Stop syncing on this device"));
      body.querySelector(".x-qr").innerHTML = P2P.qrSvg(S.link());
    };
    show("Your devices", body); paint(); S.onPanel(() => panel && paint());
    api("/api/books").then(bs => { paint.mine = bs.map(b => b.id); if (panel) paint(); }).catch(() => {});
  }

  // -- entry points ------------------------------------------------------------------------------------------------
  function addNav() {
    const nav = document.querySelector("header.bar nav"); if (!nav || nav.querySelector("#navDiscover")) return;
    nav.prepend(h("a", { href: "#", id: "navDiscover", onclick: e => { e.preventDefault(); discover(); } }, "Discover"));
    const sync = h("a", { href: "#", id: "navDevices", "aria-label": "Sync your devices", title: "Sync your devices", onclick: e => { e.preventDefault(); devices(); } });
    sync.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="vertical-align:-3px"><path d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2"/><path d="M20 4v4h-4M4 20v-4h4"/></svg>';
    nav.append(sync);
  }
  window.ExcPanels = { discover, devices, close, show };
  addEventListener("DOMContentLoaded", addNav); addNav();
  // A pairing link opened on this device: join, then forget the code from the address bar.
  const m = location.hash.match(/#pair=(EXC1\.[^&]+)/);
  if (m) { history.replaceState(null, "", location.pathname); setTimeout(async () => { if (confirm("Pair this device with your other device? This device will share its library with it.")) { try { await window.ExcSync.join(m[1]); devices(); } catch (e) { alert(e.message); } } }, 600); }
  // First visit with an empty library: a classic is already on the shelf, so the first thing you can do is read.
  setTimeout(async () => {
    if (localStorage.xwelcomed || m) return; localStorage.xwelcomed = 1;
    try {
      if ((await api("/api/books")).length) return;
      const [path] = CLASSICS[0], slug = path.replace(/\//g, "_");
      const r = await fetch(`${SE}/ebooks/${path}/downloads/${slug}.epub?source=download`); if (!r.ok) return;
      await api("/api/books", { method: "POST", headers: { "X-Filename": slug + ".epub" }, body: await r.blob() });
      if (window.xPath?.() === "/") window.route?.();
    } catch {}
  }, 800);
})();

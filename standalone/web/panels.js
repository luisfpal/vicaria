// Vicaria: the Discover and Devices panels, added next to the app's own pages.
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
#x-panel .x-cover{position:relative;aspect-ratio:2/3;border-radius:6px;overflow:hidden;color:#fff;display:flex;flex-direction:column;justify-content:space-between;padding:12px 10px;box-sizing:border-box;font-family:var(--serif,Georgia,serif)}
#x-panel .x-cover strong{font-size:17px;line-height:1.2}#x-panel .x-cover em{font-size:12px;font-style:normal;opacity:.85}
#x-panel .x-cover img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0}#x-panel .x-cover img.ok{opacity:1}
#x-panel h3.x-src{font-size:13px;letter-spacing:.06em;text-transform:uppercase;opacity:.7;margin:18px 0 0}#x-panel .x-gstep{display:flex;flex-direction:column;gap:6px;font-size:13px}#x-panel .x-book b{font-size:14px;line-height:1.25}#x-panel .x-book span{font-size:13px;opacity:.7}
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

  // -- Discover: Standard Ebooks first (EPUB 3, downloadable from any browser), then Project Gutenberg through Gutendex --
  const GD = "https://gutendex.com/books/";
  async function addBlob(blob, name, title) {
    const book = await api("/api/books", { method: "POST", headers: { "X-Filename": name }, body: blob });
    close(); window.go ? window.go(`${BASE}/book/${book.id}`) : (location.href = `${BASE}/book/${book.id}`);
  }
  async function addBook(path, title, btn) {
    btn.disabled = true; btn.textContent = "Adding…";
    try {
      const slug = path.replace(/\//g, "_");
      const r = await fetch(`${SE}/ebooks/${path}/downloads/${slug}.epub?source=download`);
      if (!r.ok) throw new Error("download failed (" + r.status + ")");
      await addBlob(await r.blob(), slug + ".epub", title);
    } catch (e) { btn.disabled = false; btn.textContent = "Try again"; toast?.("Could not add " + title + ": " + e.message); }
  }
  // Project Gutenberg sends no CORS headers (www.gutenberg.org and every mirror checked, Nov 2026), so a web page cannot
  // read its files. The browser downloads the EPUB itself, in the same tap, and the next tap adds that file.
  // No server of ours sits in the middle.
  function addGutenberg(b, btn) {
    const url = `https://www.gutenberg.org/ebooks/${b.id}.epub3.images`;
    h("a", { href: url, target: "_blank", rel: "noopener", download: `pg${b.id}.epub` }).click();
    const pick = h("input", { type: "file", accept: ".epub,application/epub+zip", style: "display:none", onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      try { await addBlob(f, f.name, b.title); } catch (x) { toast?.("Could not add " + b.title + ": " + x.message); }
    } });
    btn.replaceWith(h("div", { class: "x-gstep" }, h("span", {}, "Downloading from Project Gutenberg. When it finishes:"),
      h("button", { class: "x-btn", onclick: () => pick.click() }, "Add the downloaded file"), pick));
  }
  // Ranking: the title, then the author, matched as whole words; the source's own order breaks ties.
  const norm = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  function relevance(q, title, author) {
    const Q = norm(q), T = norm(title).replace(/^(the|a|an) /, ""), A = norm(author), ws = Q.split(" ").filter(Boolean);
    const tw = new Set(norm(title).split(" ")), aw = new Set(A.split(" "));
    let s = T === Q.replace(/^(the|a|an) /, "") ? 100 : T.startsWith(Q) ? 60 : 0;
    s += 40 * ws.filter(w => tw.has(w)).length / ws.length + 30 * ws.filter(w => aw.has(w)).length / ws.length;
    if (A && (A === Q || A.includes(Q))) s += 50;
    return s;
  }
  const ranked = (q, items) => items.map((x, i) => [relevance(q, x.title, x.author) - i * 0.01, x]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
  // A cover that is always there: the title and author set in type, with the real picture on top once it loads.
  function coverEl(title, author, img) {
    let hue = 0; for (const c of title + author) hue = (hue * 31 + c.charCodeAt(0)) % 360;
    const box = h("div", { class: "x-cover", style: `background:hsl(${hue} 28% 32%)` }, h("strong", {}, title), h("em", {}, author));
    if (img) box.append(h("img", { src: img, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onload: e => e.target.classList.add("ok"), onerror: e => e.target.remove() }));
    return box;
  }
  const card = (x, add) => h("div", { class: "x-book" }, coverEl(x.title, x.author, x.img), h("b", {}, x.title), h("span", {}, x.author),
    h("button", { class: "x-btn", onclick: e => add(e.target) }, "Add"));
  async function fromSE(q) {
    const html = await (await fetch(`${SE}/ebooks?query=${encodeURIComponent(q)}&per-page=24`)).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return [...doc.querySelectorAll('li[typeof="schema:Book"]')].filter(li => li.querySelector("img")).map(li => ({  // no picture: not released yet
      path: (li.getAttribute("about") || "").replace(/^\/ebooks\//, ""), title: li.querySelector('[property="schema:name"]')?.textContent.trim(),
      author: li.querySelector(".author [property='schema:name']")?.textContent.trim() || "", img: SE + li.querySelector("img").getAttribute("src") })).filter(x => x.path && x.title);
  }
  async function fromGutenberg(q, tries = 2) {
    // Gutendex answers a new query in 1 to 60 s and sometimes not at all: give it time, and one more try.
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(`${GD}?search=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(75000) });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        return (j.results || []).filter(b => !b.copyright && Object.keys(b.formats || {}).some(k => k.includes("epub"))).map(b => ({
          id: b.id, title: (b.title || "").split(/[:;]/)[0].trim(), author: (b.authors || []).map(a => a.name.split(", ").reverse().join(" ")).join(", "),
          img: b.formats["image/jpeg"] || null }));
      } catch (e) { if (i + 1 >= tries) throw e; }
    }
  }
  let searchNo = 0;
  async function search(q, out) {
    const no = ++searchNo, key = x => norm(x.title) + "|" + norm(x.author).split(" ").pop();
    const seBox = h("div", {}, h("p", { class: "x-muted" }, "Searching Standard Ebooks…"));
    const pgBox = h("div", {}, h("h3", { class: "x-src" }, "Project Gutenberg"), h("p", { class: "x-muted" }, "Searching Project Gutenberg… (it can take a minute)"));
    out.replaceChildren(seBox, pgBox);
    let have = new Set();
    const seP = fromSE(q).then(list => {
      if (no !== searchNo) return;
      const l = ranked(q, list); have = new Set(l.map(key));
      seBox.replaceChildren(...(l.length ? [h("h3", { class: "x-src" }, "Standard Ebooks"), h("div", { class: "x-grid", "data-src": "se" }, l.map(x => card(x, btn => addBook(x.path, x.title, btn))))]
        : [h("p", { class: "x-muted" }, "Nothing at Standard Ebooks.")]));
    }).catch(() => no === searchNo && seBox.replaceChildren(h("p", { class: "x-muted" }, "Standard Ebooks did not answer. Search needs a connection.")));
    try {
      const list = await fromGutenberg(q); await seP; if (no !== searchNo) return;
      const l = ranked(q, list).filter(x => !have.has(key(x))).slice(0, 12);
      pgBox.replaceChildren(h("h3", { class: "x-src" }, "Project Gutenberg"), l.length ? h("div", { class: "x-grid", "data-src": "pg" }, l.map(x => card(x, btn => addGutenberg(x, btn))))
        : h("p", { class: "x-muted" }, "Nothing more at Project Gutenberg."));
    } catch {
      if (no === searchNo) pgBox.replaceChildren(h("h3", { class: "x-src" }, "Project Gutenberg"), h("p", { class: "x-muted" }, "Project Gutenberg's search did not answer. ",
        h("button", { class: "x-ghost", onclick: () => search(q, out) }, "Try again")));
    }
  }
  function discover() {
    const out = h("div", {}, h("p", { class: "x-muted" }, "Start with a classic:"),
      h("div", { class: "x-grid" }, CLASSICS.map(([p, t, a]) => card({ title: t, author: a, img: `${SE}/ebooks/${p}/downloads/cover-thumbnail.jpg` }, btn => addBook(p, t, btn)))));
    const input = h("input", { type: "search", placeholder: "Search free classics: title or author", enterkeyhint: "search" });
    input.addEventListener("keydown", e => { if (e.key === "Enter" && input.value.trim()) search(input.value.trim(), out); });
    show("Discover", [h("p", { class: "x-muted" }, "Free public-domain books from Standard Ebooks and Project Gutenberg. One tap adds a book to this device."), input, out,
      h("p", { class: "x-muted" }, "Have your own EPUB? Use “Add a book” in the Library.")]);
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
          h("button", { class: "x-ghost", onclick: async () => { const b = await S.exportFile(); const a = h("a", { href: URL.createObjectURL(b), download: "vicaria-sync.txt" }); a.click(); } }, "Save a sync file"),
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

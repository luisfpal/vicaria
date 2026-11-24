// Commonplace: library, book lessons, chapter cards, reading, Ask, and the Ideas graph. No framework.
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const S = { book: null, abort: null };
const PROVIDER = localStorage.provider || "";  // empty: the model picked in Settings

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [e, f] of Object.entries(v)) n.addEventListener(e, f);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : String(k));
  return n;
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
// Every bit of HTML the app writes passes through DOMPurify first: card, chat and diagram text comes from a model that
// read the book, and a hostile book can ask it to write <script> or onerror=. No sanitizer loaded means plain text.
const clean = (html, svg) => window.DOMPurify ? DOMPurify.sanitize(html, svg
  ? { USE_PROFILES: { svg: true, svgFilters: true, html: true }, ADD_TAGS: ["foreignObject"], HTML_INTEGRATION_POINTS: { foreignobject: true } }
  : { USE_PROFILES: { html: true } }) : html.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const setMd = (node, s) => { node.innerHTML = clean(marked.parse(s || "")); return node; };
const md = s => setMd(el("div", { class: "md" }), s);
const tc = s => /[a-z]/.test(s) ? s.replace(/^[A-Z]{3,}(?= [0-9IVXLC]+\b|:)/, w => w[0] + w.slice(1).toLowerCase()) : s.split(/(\s+)/).map(w => /^[IVXLC]+[.:]?$/.test(w) ? w.replace(/[.:]$/, "") :
  w.toLowerCase().replace(/(^|[:(])(\p{L})/u, (m, a, b) => a + b.toUpperCase())).join("").replace(/[.]$/, "");

// "Chapter 2: Your reason" -> ["Chapter 2", "Your reason"]; titles without a number stay whole
const titleParts = t => { const m = tc(t).match(/^((?:chapter|part|lecture|book|section|conclusion|introduction|epilogue|prologue)(?:\s+[\w]+)?)\s*[:.–-]\s+(.+)$/i); return m ? [m[1], m[2]] : [null, tc(t)]; };
const authors = a => a.map(x => /^[^,]+, [^,]+$/.test(x) ? x.split(", ").reverse().join(" ") : x).join(", ");
const short = t => t.split(/[:;]/)[0].trim();
// a title cut at a word for chips: "Discourse on the Method…"
const brief = (t, n = 32) => { t = short(t); if (t.length <= n) return t; const w = t.slice(0, n + 1).replace(/\s+\S*$/, "").replace(/\s+(of|on|the|a|and|to|for|in)$/i, ""); return w + "…"; };
// stray spaces EPUBs leave before punctuation after italics: "ikigai , namely" (display only; the saved text keeps its digest)
const tidy = t => t.replace(/(\S) +([,.;:!?)])(?=\s|$)/g, "$1$2");
const norm = x => x.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

function go(path, push = true) { if (push) history.pushState({}, "", path); route(); }
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-link]");
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute("href")); }
});
window.addEventListener("popstate", () => route());

// ---- reader settings: theme and reading type, kept in this browser and synced to your other devices ----------
const WIDTHS = { narrow: 620, medium: 760, wide: 920, full: 1180 };
const SPACING = { tight: 1.45, normal: 1.65, loose: 1.85 };
// Presets name only three colours: page, text, accent. Everything else is mixed from them, so a custom theme looks right too.
const THEMES = {
  paper: { name: "Paper", paper: "#f7f4ee", ink: "#1f1d1a", accent: "#b4532a" },
  light: { name: "White", paper: "#ffffff", ink: "#1f1d1a", accent: "#b4532a" },
  sepia: { name: "Sepia", paper: "#f1e5cc", ink: "#3b2f22", accent: "#9a4a1c" },
  study: { name: "Study", paper: "#1f2a24", ink: "#e8dfc8", accent: "#d9a45b" },
  dark: { name: "Night", paper: "#161513", ink: "#e9e4da", accent: "#e08a5f" },
  black: { name: "Black", paper: "#000000", ink: "#c9c4ba", accent: "#d88a5f" },
};
const FACES = {
  serif: ["Book serif", 'Literata, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif'],
  classic: ["Classic", '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif'],
  sans: ["Sans", '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif'],
  legible: ["Legible", '"Atkinson Hyperlegible", Verdana, "Segoe UI", sans-serif'],
};
const R = Object.assign({ theme: "paper", size: 19, lh: "normal", width: "medium", face: "serif", align: "left", custom: null, bg: null, bgBlur: 8, bgDim: 0.45 },
  (() => { try { return JSON.parse(localStorage.reader || "{}"); } catch { return {}; } })());
if (!FACES[R.face]) R.face = "serif";
// spacing and width used to be named steps; they are numbers now, so any value in between can be chosen
if (typeof R.lh === "string") R.lh = SPACING[R.lh] || 1.65;
if (typeof R.width === "string") R.width = WIDTHS[R.width] || 760;
const hex = c => { c = c.replace("#", ""); return [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16)); };
const mix = (a, b, t) => "#" + hex(a).map((x, i) => Math.round(x + (hex(b)[i] - x) * t).toString(16).padStart(2, "0")).join("");
const lum = c => { const [r, g, b] = hex(c).map(x => { x /= 255; return x <= .03928 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
function themeVars(t) {
  const dark = lum(t.paper) < .2;
  return { dark, vars: { "--paper": t.paper, "--ink": t.ink, "--accent": t.accent,
    "--card": dark ? mix(t.paper, t.ink, .06) : mix(t.paper, "#ffffff", .6), "--muted": mix(t.ink, t.paper, .42),
    "--faint": mix(t.paper, t.ink, .1), "--line": mix(t.paper, t.ink, .22), "--well": mix(t.paper, t.ink, dark ? .08 : .05),
    "--green": dark ? "#6fb3a3" : "#2f6f62", "--error": dark ? "#f08c75" : "#a2341b", "--shadow": dark ? "rgba(0,0,0,.4)" : "rgba(0,0,0,.08)" } };
}
const currentTheme = () => R.theme === "custom" && R.custom ? R.custom : THEMES[R.theme] || THEMES.paper;
function applyReader(persist = true) {
  const d = document.documentElement, st = d.style, { dark, vars } = themeVars(currentTheme());
  for (const [k, v] of Object.entries(vars)) st.setProperty(k, v);
  d.dataset.theme = R.theme; d.dataset.tone = dark ? "dark" : "light"; st.colorScheme = dark ? "dark" : "light";
  st.setProperty("--read-size", R.size + "px");
  st.setProperty("--read-lh", R.lh);
  st.setProperty("--read-measure", Math.min(R.width, innerWidth - 40) + "px");
  st.setProperty("--read-face", FACES[R.face][1]);
  st.setProperty("--read-align", R.align === "justify" ? "justify" : "left");
  $('meta[name="theme-color"]').content = vars["--paper"];
  document.body.classList.toggle("rail", innerWidth >= R.width + 500);
  // a picture behind everything, softened by blur and faded toward the page colour so text stays readable
  let bg = $("#bg");
  if (R.bg && !bg) { bg = el("div", { id: "bg", "aria-hidden": "true" }, el("div", { class: "bg-img" }), el("div", { class: "bg-dim" })); document.body.prepend(bg); }
  if (bg) {
    bg.hidden = !R.bg;
    if (R.bg) { bg.firstChild.style.backgroundImage = `url(/api/backgrounds/${R.bg})`; bg.firstChild.style.filter = R.bgBlur ? `blur(${R.bgBlur}px)` : "";
      bg.firstChild.style.inset = `${-2 * R.bgBlur}px`; bg.lastChild.style.opacity = R.bgDim; }
  }
  document.body.classList.toggle("has-bg", !!R.bg);
  localStorage.reader = JSON.stringify(R);
  localStorage.themeVars = JSON.stringify({ vars, dark });  // painted before the page shows (index.html)
  if (persist) { clearTimeout(applyReader.t); applyReader.t = setTimeout(() => Sync.op(null, "reader", readerOp()), 1500); }
}
function readerOp() {  // reading look and listening speed travel together to your other devices
  let n = {}; try { n = JSON.parse(localStorage.narration || "{}"); } catch {}
  const { narration, ...look } = R;
  return { ...look, narration: { rate: n.rate || 1, bookRates: n.bookRates || {} } };
}
function seg(key, opts, label) {
  return el("div", { class: `row ${key}` }, el("p", { class: "lbl" }, label), el("div", { class: "seg", role: "radiogroup", "aria-label": label },
    opts.map(([v, t, style]) => el("button", { role: "radio", class: R[key] === v ? "on" : null, style: style || null, "aria-checked": String(R[key] === v),
      on: { click: e => { R[key] = v; applyReader(); for (const b of e.currentTarget.parentNode.children) { b.classList.toggle("on", b === e.currentTarget); b.setAttribute("aria-checked", String(b === e.currentTarget)); } } } }, t))));
}
// a continuous control with a few named marks to jump to
function slider(key, label, min, max, step, show, marks) {
  const out = el("output", {}, show(R[key]));
  const set = v => { R[key] = Math.round(Math.max(min, Math.min(max, +v)) / step) * step; R[key] = +R[key].toFixed(2); out.textContent = show(R[key]); input.value = R[key]; applyReader();
    for (const b of row.querySelectorAll(".marks button")) b.classList.toggle("on", +b.dataset.v === R[key]); };
  const input = el("input", { type: "range", min, max, step, value: R[key], "aria-label": label, on: { input: e => set(e.target.value) } });
  const row = el("div", { class: `row ${key}` }, el("p", { class: "lbl" }, label, " ", out), input,
    el("div", { class: "marks" }, marks.map(([v, t]) => el("button", { "data-v": v, class: R[key] === v ? "on" : null, on: { click: () => set(v) } }, t))));
  return row;
}
function themeRow() {
  const sw = (id, t) => el("button", { role: "radio", class: `swatch ${R.theme === id ? "on" : ""}`, "aria-checked": String(R.theme === id), title: t.name,
    style: `background:${t.paper};color:${t.ink}`, on: { click: () => { R.theme = id; if (id === "custom" && !R.custom) R.custom = { ...currentTheme(), name: "Mine" }; applyReader(); toggleSettings(true); } } },
    el("b", {}, "Aa"), el("small", {}, t.name), el("i", { style: `background:${t.accent}` }));
  const row = el("div", { class: "row theme" }, el("p", { class: "lbl" }, "Theme"), el("div", { class: "swatches", role: "radiogroup", "aria-label": "Theme" },
    Object.entries(THEMES).map(([id, t]) => sw(id, t)), sw("custom", R.custom || { name: "Mine", paper: "#ffffff", ink: "#555555", accent: "#888888" })));
  if (R.theme === "custom") {
    const pick = (k, label) => el("label", { class: "pick" }, el("input", { type: "color", value: R.custom[k], "aria-label": label,
      on: { input: e => { R.custom[k] = e.target.value; applyReader(); } } }), label);
    row.append(el("div", { class: "picks" }, pick("paper", "Page"), pick("ink", "Text"), pick("accent", "Accent")));
  }
  return row;
}
// Background picture: shrunk on this device (at most 1920 px, JPEG), stored on the server by content, synced with the theme
function bgRow() {
  const file = el("input", { type: "file", accept: "image/*", hidden: true, on: { change: async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await api("/api/backgrounds", { method: "POST", body: await shrink(f) }); R.bg = r.id; applyReader(); toggleSettings(true); }
    catch (err) { toast(`Could not use that picture: ${err.message}`); } } } });
  const row = el("div", { class: "row bg-row" }, el("p", { class: "lbl" }, "Background picture"),
    el("div", { class: "bg-btns" }, el("button", { class: "btn ghost", on: { click: () => file.click() } }, R.bg ? "Change picture" : "Choose a picture"),
      R.bg ? el("button", { class: "link", on: { click: () => { R.bg = null; applyReader(); toggleSettings(true); } } }, "Remove") : null), file);
  if (R.bg) row.append(slider("bgBlur", "Blur", 0, 24, 1, v => `${v} px`, [[0, "Sharp"], [8, "Soft"], [20, "Mist"]]),
    slider("bgDim", "Dim", 0, 0.9, 0.05, v => `${Math.round(v * 100)}%`, [[0.2, "Bright"], [0.45, "Calm"], [0.7, "Quiet"]]));
  return row;
}
async function shrink(f, max = 1920) {
  const img = await createImageBitmap(f), k = Math.min(1, max / Math.max(img.width, img.height));
  const c = el("canvas", { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return await new Promise(ok => c.toBlob(ok, "image/jpeg", 0.84));
}
function toggleSettings(force) {
  const btn = $("#aa"), open = $(".settings");
  if (force === true && open) open.remove();
  else if (open || force === false) { open?.remove(); btn.setAttribute("aria-expanded", "false"); return; }
  const out = el("output", {}, `${R.size} px`);
  const step = d => { R.size = Math.round(Math.max(12, Math.min(34, R.size + d)) * 2) / 2; out.textContent = `${R.size} px`; size.value = R.size; applyReader(); };
  const size = el("input", { type: "range", min: 12, max: 34, step: 0.5, value: R.size, "aria-label": "Text size", on: { input: e => step(+e.target.value - R.size) } });
  const panel = el("div", { class: "settings", role: "dialog", "aria-label": "Reading settings" },
    themeRow(),
    el("div", { class: "row" }, el("p", { class: "lbl" }, "Text size"), el("div", { class: "stepper" },
      el("button", { "aria-label": "Smaller text", on: { click: () => step(-1) } }, el("span", { style: "font-size:13px" }, "A")), out,
      el("button", { "aria-label": "Larger text", on: { click: () => step(1) } }, el("span", { style: "font-size:19px" }, "A"))), size),
    seg("face", Object.entries(FACES).map(([k, [t, f]]) => [k, t, `font-family:${f.replace(/"/g, "'")}`]), "Typeface"),
    slider("lh", "Line spacing", 1.2, 2.2, 0.05, v => v.toFixed(2), [[1.45, "Tight"], [1.65, "Normal"], [1.85, "Loose"]]),
    seg("align", [["left", "Ragged"], ["justify", "Justified"]], "Lines"),
    slider("width", "Page width", 420, 1400, 10, v => `${v} px`, [[620, "Narrow"], [760, "Medium"], [920, "Wide"]]),
    bgRow());
  document.body.append(panel); btn.setAttribute("aria-expanded", "true");
}
$("#hear").addEventListener("click", () => S.listen?.());
$("#aa").addEventListener("click", e => { e.stopPropagation(); toggleSettings(); });
document.addEventListener("click", e => { if ($(".settings") && !e.target.closest(".settings") && e.target.isConnected) toggleSettings(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") toggleSettings(false); });
addEventListener("resize", () => applyReader(false));

// ---- sync: this device's changes as operations, sent to the server now or when the connection returns -------
// Each operation has an id (device.counter) and a time; the server keeps every operation and the newest wins.
// See docs/SYNC.md. Positions for one book are coalesced while offline, so the queue stays small.
const Sync = (() => {
  const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
  const dev = localStorage.dev || (localStorage.dev = "d" + rnd());
  const ua = navigator.userAgent, name = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "this device";
  let queue = (() => { try { return JSON.parse(localStorage.opq || "[]"); } catch { return []; } })(), busy = false;
  const persist = () => { localStorage.opq = JSON.stringify(queue); };
  function op(book, k, v) {
    const t = Math.max(Date.now(), +(localStorage.opt || 0) + 1), n = +(localStorage.opn || 0) + 1;
    localStorage.opt = t; localStorage.opn = n;
    if (k === "pos" || k === "reader") queue = queue.filter(x => !(x.book === book && x.op.k === k));
    queue.push({ book, op: { id: `${dev}.${n}`, dev, t, k, v: { ...v, device: name } } }); persist();
    clearTimeout(op.t); op.t = setTimeout(flush, k === "pos" ? 400 : 0);
  }
  async function flush() {
    if (busy || !queue.length) return; busy = true;
    try {
      const books = [...new Set(queue.map(x => x.book))];
      for (const b of books) {
        const batch = queue.filter(x => x.book === b);
        await api("/api/ops", { method: "POST", body: JSON.stringify({ book: b, ops: batch.map(x => x.op) }) });
        queue = queue.filter(x => !batch.includes(x)); persist();
      }
    } catch { /* offline: kept for later */ } finally { busy = false; }
  }
  addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flush(); });
  setTimeout(flush, 1000);
  // reader settings chosen on another device win when newer than this device's
  api("/api/library").then(r => {
    // another device's choice (by device id: two phones of the same kind are still two devices)
    if (r.reader && r.reader.t > +(localStorage.readerT || 0) && (r.reader.dev ? r.reader.dev !== dev : r.reader.device !== name)) {
      const { t, device, dev: _d, narration, ...rest } = r.reader; Object.assign(R, rest);
      if (narration) { try { Object.assign(Narrator.pref, narration); Narrator.save(); } catch {} } localStorage.readerT = t; applyReader(false);
    }
  }).catch(() => {});
  return { op, flush, dev, name, pending: () => queue.length };
})();
applyReader(false);

async function route() {
  S.abort?.abort(); S.abort = null; S.tok = (S.tok || 0) + 1; S.listen = null; document.body.classList.remove("can-listen");
  const p = location.pathname, q = new URLSearchParams(location.search), tok = S.tok;
  $("#navLib").classList.toggle("on", !p.startsWith("/ideas") && !p.startsWith("/settings"));
  $("#navIdeas").classList.toggle("on", p.startsWith("/ideas"));
  $("#navSettings")?.classList.toggle("on", p.startsWith("/settings"));
  app.className = ""; document.body.classList.remove("reading"); window.scrollTo(0, 0);
  try {
    let m;
    if (p === "/ideas") return await showIdeas();
    if (p === "/settings") return await showSettings();
    if ((m = p.match(/^\/book\/([\w-]+)\/matter$/))) return await showMatter(m[1]);
    if ((m = p.match(/^\/book\/([\w-]+)\/(\d+)$/))) return await showChapter(m[1], +m[2], q.get("tab") || "card");
    if ((m = p.match(/^\/book\/([\w-]+)$/))) return await showBook(m[1], q.get("tab") || "lessons");
    return await showLibrary();
  } catch (e) { if (tok === S.tok) app.replaceChildren(errorBox(e.message)); }
}
// An error, with the way out when there is one (a missing or refused key goes to Settings)
function errorBox(msg) {
  return el("div", { class: "error" }, el("p", {}, msg), /Settings|signed in|key/i.test(msg) ? el("a", { class: "btn ghost", href: "/settings", "data-link": true }, "Open Settings") : null);
}

async function loadBook(id) {
  if (S.book?.id !== id || S.book.stale) S.book = await api(`/api/books/${id}`);
  return S.book;
}

// ---- library -----------------------------------------------------------------------------------
async function showLibrary() {
  document.title = "Commonplace";
  const tok = S.tok, [books, trash] = await Promise.all([api("/api/books"), api("/api/trash").then(r => r.books).catch(() => [])]);
  const cores = await Promise.all(books.map(b => api(`/api/books/${b.id}/core`).then(r => r.core).catch(() => null)));
  if (tok !== S.tok) return;  // the reader moved on while this loaded
  const file = el("input", { type: "file", accept: ".epub,application/epub+zip", hidden: true, on: { change: () => upload(file.files[0]) } });
  app.className = "w-lib";
  const when = p => p.t || Date.parse(p.at) || 0;
  const last = books.filter(b => b.progress).sort((a, b) => when(b.progress) - when(a.progress))[0];
  let resume = null;
  if (last) {
    const full = await api(`/api/books/${last.id}`).catch(() => null), c = full?.chapters.find(x => x.index === last.progress.chapter);
    if (tok !== S.tok) return;
    if (c) {
      const k = full.chapters.indexOf(c), p = last.progress;
      const where = p.device && p.device !== Sync.name ? ` · on ${p.device} ${ago(when(p))}` : "";
      resume = el("a", { class: "resume", href: `/book/${last.id}/${c.index}?tab=read`, "data-link": true },
        cover(last, "sm"), el("div", { class: "info" }, el("p", { class: "kicker" }, "Continue reading"), el("h2", {}, titleParts(c.title)[1]),
          p.quote ? el("p", { class: "pin-quote" }, "“" + p.quote.trim().replace(/\s+\S*$/, "") + "…”") : null,
          el("p", { class: "muted small" }, `${brief(last.title, 40)} · `, el("span", { class: "nowrap" }, `chapter ${k + 1} of ${full.chapters.length}${where}`)),
          el("div", { class: "bar-track", "aria-label": `${p.percent}% of this chapter read` }, el("div", { class: "bar-fill", style: `width:${Math.max(3, p.percent)}%` }))),
        el("span", { class: "btn" }, "Resume"));
    }
  }
  app.replaceChildren(...[
    el("div", { class: "libhead" }, el("h1", {}, "Library"),
      el("button", { class: "btn ghost", on: { click: () => file.click() } }, "Add a book"), file),
    resume,
    books.length ? el("div", { class: "shelf" }, books.map((b, i) => el("a", { class: "book-card", href: `/book/${b.id}`, "data-link": true },
      cover(b),
      el("div", { class: "info" }, el("h2", { title: b.title }, brief(b.title)),
        b.authors.length ? el("div", { class: "muted small" }, authors(b.authors)) : null,
        cores[i] ? el("p", { class: "core" }, cores[i].core) : null,
        el("div", { class: "meta" }, `${b.chapters} chapters`, cores[i] ? "" : " · not distilled yet")))))
      : el("p", { class: "empty" }, "Add a DRM-free EPUB to start. Drop it anywhere on this page."),
    trash.length ? el("details", { class: "trash" }, el("summary", {}, `Recently deleted (${trash.length})`),
      el("ul", {}, trash.map(t => el("li", {}, el("span", {}, brief(t.title, 44)), el("span", { class: "muted small nowrap" }, `${t.days_left} day${t.days_left === 1 ? "" : "s"} left`),
        el("button", { class: "link", on: { click: () => restoreBook(t.id) } }, "Restore"))))) : null].filter(Boolean));
}
// The book's own cover, or a plain one set in its title when the EPUB has none
function cover(b, size = "") {
  const fallback = () => el("div", { class: `cover plain ${size}`, style: `--c:${PALETTE[[...b.id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PALETTE.length]}` },
    el("span", {}, short(b.title)));
  if (!b.cover) return fallback();
  const img = el("img", { class: `cover ${size}`, src: `/api/books/${b.id}/cover`, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(fallback()));
  return img;
}
async function upload(f) {
  if (!f) return;
  const r = await api("/api/books", { method: "POST", headers: { "X-Filename": f.name }, body: f });
  go(`/book/${r.id}`);
}
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) upload(f); });

// ---- book --------------------------------------------------------------------------------------
function tabs(names, current, href) {
  return el("div", { class: "tabs", role: "tablist" }, names.map(([k, label]) =>
    el("button", { role: "tab", class: k === current ? "on" : null, "aria-selected": k === current ? "true" : "false",
      on: { click: () => { history.replaceState({}, "", href(k)); route(); } } }, label)));
}
function tabHref(base) { return k => `${base}?tab=${k}`; }

async function showBook(id, tab) {
  const tok = S.tok, b = await loadBook(id);
  if (tok !== S.tok) return;
  document.title = b.title;
  const head = [el("a", { class: "back", href: "/", "data-link": true }, "← Library"), el("h1", {}, b.title),
    el("p", { class: "by" }, b.authors.length ? authors(b.authors) : "", offlineButton(b), menu("Book options", [["Delete this book…", () => deleteBook(b)]])),
    structureNote(b),
    tabs([["lessons", "Lessons"], ["chapters", "Chapters"], ["ask", "Ask"]], tab, tabHref(`/book/${id}`))];
  const body = el("div");
  app.replaceChildren(...head.filter(Boolean), body);
  if (tab === "chapters") return body.append(searchBox(b, chapterList(b)));
  if (tab === "ask") return chat(body, id, "book", b.title);
  const r = await api(`/api/books/${id}/core`);
  if (tok !== S.tok) return;  // the reader moved on
  if (!r.core) return body.append(distillPrompt(b, r.job), glossaryBox(id));
  const c = r.core;
  body.append(split([
    el("p", { class: "kicker" }, "The core lesson"), el("p", { class: "core-lesson" }, c.core),
    el("p", { class: "kicker" }, "Key lessons"),
    el("ol", { class: "lessons" }, c.lessons.map(l => el("li", {}, el("div", { class: "lesson" }, l.lesson),
      el("div", { class: "why" }, l.why),
      (l.chapters || []).length ? el("div", { class: "src" }, "From ", ...joinLinks(b, l.chapters)) : null))),
    el("div", { class: "actions" }, el("button", { class: "link", on: { click: () => copyText(cardMd(`${b.title}${b.authors.length ? `, ${authors(b.authors)}` : ""}`, c, r.diagram), "Book lessons copied as Markdown") } }, "Copy as Markdown"))], [
    diagramBox(r.diagram),
    c.remember ? el("p", { class: "remember" }, c.remember) : null,
    (c.timeless || []).length ? el("div", {}, el("p", { class: "kicker" }, "Timeless ideas"),
      el("ul", { class: "timeless" }, c.timeless.map(t => el("li", {}, t)))) : null,
    glossaryBox(id),
    el("div", { class: "desk-only" }, el("p", { class: "kicker" }, "Chapters"), chapterList(b))]));
}
function glossaryBox(id) {
  const box = el("details", { class: "glossary" });
  api(`/api/books/${id}/glossary`).then(r => { if (r.terms.length) box.append(el("summary", { class: "kicker" }, `Glossary (${r.terms.length})`), termList(r.terms, id)); }).catch(() => {});
  return box;
}
// Desktop: main column and a side column; phones: one column, side after main. Widens the page only when the side has content.
function split(main, side) {
  side = side.filter(Boolean);
  if (!side.length) return el("div", {}, main);
  app.className = "w-split";
  return el("div", { class: "split" }, el("div", { class: "main" }, main), el("div", { class: "side" }, side));
}
function joinLinks(b, titles) {
  const out = [];
  titles.forEach((t, k) => {
    const norm = x => x.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim(), nt = norm(t);
    const ch = b.chapters.find(c => c.title === t) || b.chapters.find(c => norm(c.title) && (nt.startsWith(norm(c.title)) || norm(c.title).startsWith(nt)));
    if (k) out.push(", ");
    out.push(ch ? el("a", { href: `/book/${b.id}/${ch.index}`, "data-link": true }, tc(t)) : tc(t));
  });
  return out;
}
function distillPrompt(b, job) {
  const box = el("div", { class: "empty" });
  const btn = el("button", { class: "btn", on: { click: async () => { await api(`/api/books/${b.id}/cards`, { method: "POST", body: JSON.stringify({ provider: PROVIDER }) }); watch(); } } }, "Distill this book");
  const status = el("p", { class: "small" });
  box.append(el("p", {}, `${b.chapters.length} chapters. One core lesson and five key lessons for the book, three for each chapter.`), btn, status);
  async function watch() {
    btn.disabled = true;
    for (;;) {
      const r = await api(`/api/books/${b.id}/core`);
      if (r.core) { S.book.stale = true; return route(); }
      status.textContent = r.job.state === "running" ? `Reading… ${r.job.done} of ${r.job.total}` : (r.job.errors || []).join("; ");
      if (r.job.state !== "running") { btn.disabled = false; return; }
      await new Promise(f => setTimeout(f, 1500));
    }
  }
  if (job?.state === "running") watch();
  return box;
}
// The book's own contents, nested as the book nests them (parts over chapters over sections). Labels are the book's;
// nothing is renumbered. Parts fold open and closed.
function tocTree(b, item, parent = null) {
  const here = new Set(b.chapters.map(c => c.index));
  const kids = b.chapters.filter(c => (here.has(c.parent) ? c.parent : null) === parent);
  return kids.flatMap(c => {
    const sub = b.chapters.some(x => x.parent === c.index) ? tocTree(b, item, c.index) : null;
    // the book's own part labels that have no page of their own ("PART ONE · ANALYSIS OF GAMES") head what follows
    const head = c.heads?.length ? el(item.head || "li", { class: "toc-head", role: "presentation" }, c.heads.map(tc).join(" · ")) : null;
    return head ? [head, item(c, sub)] : [item(c, sub)];
  });
}
function chapterList(b) {
  const tools = el("p", { class: "small list-tools" }, el("a", { href: `/api/books/${b.id}/highlights.md`, download: "" }, "Export highlights (Markdown)"));
  const item = (c, sub) => {
    const link = el("a", { href: `/book/${b.id}/${c.index}`, "data-link": true, class: c.kind === "part" ? "part-link" : null },
      el("div", { class: "t" }, tc(c.title)), c.lesson ? el("div", { class: "l" }, c.lesson) : null);
    if (!sub) return el("li", {}, link);
    return el("li", { class: "part" }, el("details", { open: true },
      el("summary", { "aria-label": `${tc(c.title)}: ${sub.length} sections` }, link, el("span", { class: "count" }, `${sub.length}`)),
      el("ul", { class: "sub" }, sub)));
  };
  return el("div", {}, tools, el("ul", { class: "chapters" },
    tocTree(b, item),
    b.matter.length ? el("li", { class: "matter" }, el("a", { href: `/book/${b.id}/matter`, "data-link": true },
      el("div", { class: "t" }, "Front & back matter"), el("div", { class: "l" }, b.matter.map(tc).join(" · ")))) : null));
}

// ---- search inside a book: type, see every place in reading order, one tap to that line -------------------------
function searchBox(b, contents) {
  const list = el("div", { class: "search-results", "aria-live": "polite" });
  const input = el("input", { type: "search", class: "book-search", placeholder: "Search in this book", "aria-label": "Search in this book", value: q("q") || "",
    on: { input: () => { clearTimeout(input.t); input.t = setTimeout(run, 180); }, keydown: e => { if (e.key === "Escape") { input.value = ""; run(); } } } });
  async function run() {
    const term = input.value.trim();
    history.replaceState(history.state, "", term ? `?tab=chapters&q=${encodeURIComponent(term)}` : "?tab=chapters");
    if (term.length < 2) { list.replaceChildren(); contents.hidden = false; return; }
    const { results } = await api(`/api/books/${b.id}/search?q=${encodeURIComponent(term)}`);
    if (input.value.trim() !== term) return;
    contents.hidden = true;
    list.replaceChildren(el("p", { class: "muted small" }, results.length ? `${results.length}${results.length >= 60 ? "+" : ""} place${results.length === 1 ? "" : "s"}` : "Not in this book."),
      el("ol", { class: "hits" }, results.map(r => el("li", {}, el("a", { "data-link": true,
        href: `/book/${b.id}/${r.chapter}?tab=read&at=${r.block}&o=${r.offset}&len=${r.len}&qt=${encodeURIComponent((r.match + r.after).slice(0, 48))}` },
        el("span", { class: "hit-ch" }, tc(r.title)), el("span", { class: "hit-t" }, r.before, el("mark", {}, r.match), r.after))))));
  }
  if (input.value) setTimeout(run);
  if (q("search")) setTimeout(() => input.focus());
  return el("div", {}, input, list, contents);
}
function showFound(prose, block, off, len) {  // the searched words light up for a few seconds where you land
  const n = prose.querySelector(`[data-i="${block}"]`); if (!n || !window.CSS?.highlights) return;
  const a = pointAt(n, off), z = pointAt(n, off + len); if (!a || !z) return;
  const r = new Range(); r.setStart(...a); r.setEnd(...z); CSS.highlights.set("found", new Highlight(r));
  setTimeout(() => CSS.highlights.delete("found"), 6000);
}

// ---- chapter -----------------------------------------------------------------------------------
async function showChapter(id, i, tab) {
  const tok = S.tok, b = await loadBook(id);
  if (tok !== S.tok) return;
  const k = b.chapters.findIndex(c => c.index === i);
  if (k < 0) return go(`/book/${id}/matter`);
  const c = b.chapters[k], prev = b.chapters[k - 1], next = b.chapters[k + 1];
  document.title = `${tc(c.title)} · ${b.title}`;
  const body = el("div");
  if (tab === "read") { app.className = "w-read"; document.body.classList.add("reading"); }
  app.replaceChildren(
    ...(tab === "read" ? [el("nav", { class: "toc", "aria-label": "Chapters" }, el("p", { class: "kicker" }, "Contents"),
      tocTree(b, Object.assign((x, sub) => {
        const a = el("a", { href: `/book/${id}/${x.index}?tab=read`, "data-link": true, class: x.index === i ? "on" : null, "aria-current": x.index === i ? "page" : null }, tc(x.title));
        if (!sub) return a;
        const open = x.index === i || c.parent === x.index || b.chapters.some(y => y.parent === x.index && y.index === c.parent);
        return el("details", { class: "toc-part", open: open ? true : null }, el("summary", {}, a), el("div", { class: "toc-sub" }, sub));
      }, { head: "p" })))] : []),
    el("a", { class: "back", href: `/book/${id}?tab=chapters`, "data-link": true }, `← ${short(b.title)}`),
    ...(([num, name]) => [num ? el("p", { class: "kicker" }, num) : null, el("h1", {}, name)].filter(Boolean))(titleParts(c.title)),
    el("p", { class: "by" }, `${k + 1} of ${b.chapters.length} · ${Math.max(1, Math.round(c.words / 230))} min read`),
    tabs([["card", "Card"], ["read", "Read"], ["ask", "Ask"]], tab, tabHref(`/book/${id}/${i}`)), body,
    el("nav", { class: "pager" },
      prev ? el("a", { href: `/book/${id}/${prev.index}?tab=${tab}`, "data-link": true }, `← ${tc(prev.title)}`) : el("span"),
      next ? el("a", { href: `/book/${id}/${next.index}?tab=${tab}`, "data-link": true }, `${tc(next.title)} →`) : el("span")));
  if (tab === "ask") return chat(body, id, String(i), tc(c.title));
  if (tab === "read") {
    const t = await api(`/api/books/${id}/chapters/${i}`);
    const prose = el("article", { class: "prose" }, blocks(t.blocks, id, c.title, next?.title));
    S.listen = () => Narrator.start(b, i, prose, -1, next); document.body.classList.add("can-listen");
    body.append(el("div", { class: "listen-row" }, el("button", { class: "btn listen", on: { click: () => Narrator.start(b, i, prose, 0, next) } },
      icon("play"), `Listen · ${Math.max(1, Math.round(c.words / 160))} min`), el("span", { class: "muted small" }, Narrator.voiceLabel()),
      el("a", { class: "search-link", href: `/book/${id}?tab=chapters&search=1`, "data-link": true, title: "Search in this book (/)" }, "Search")), prose);
    Narrator.attach(b, i, prose, next);
    const at = q("at"), saved = at == null ? (await api(`/api/books/${id}/position`).catch(() => ({}))).position : null;
    const pin = at != null ? { block: +at, offset: +(q("o") || 0), quote: q("qt") || "", y: 40 } : saved && saved.chapter === i ? saved : null;
    trackReading(b, i, prose, pin);
    if (q("len") && at != null) showFound(prose, +at, +(q("o") || 0), +q("len"));
    Highlights.load(b, i, prose);
    prose.addEventListener("click", e => Highlights.onTap(e));
    return;
  }
  if (c.kind === "part") return partView(body, b, c);
  await cardView(body, id, i);
}
// A part has no card of its own: it shows what it holds, with each chapter's one-line lesson
function partView(body, b, c) {
  const kids = b.chapters.filter(x => x.parent === c.index);
  body.replaceChildren(el("p", { class: "muted" }, `${tc(c.title)} holds ${kids.length} section${kids.length === 1 ? "" : "s"}. Its own short introduction is under Read.`),
    el("ul", { class: "chapters" }, kids.map(x => el("li", {}, el("a", { href: `/book/${b.id}/${x.index}`, "data-link": true },
      el("div", { class: "t" }, tc(x.title)), x.lesson ? el("div", { class: "l" }, x.lesson) : null)))));
}
// The chapter's own text: headings, paragraphs, quotes, figures. Lines that only repeat this chapter's title at the top,
// or the next chapter's title at the bottom (books often put the next heading before the contents anchor), are dropped.
function blocks(list, id, title, nextTitle) {
  const names = t => t ? new Set([norm(t), ...titleParts(t).filter(Boolean).map(norm), norm(titleParts(t).filter(Boolean).join(" "))]) : new Set();
  const same = new Set([...names(title), ...names(S.book?.title), ...names(short(S.book?.title || ""))]), next = names(nextTitle);
  let k = 0, end = list.length;
  while (k < Math.min(3, end) && same.has(norm(list[k].text))) k++;
  while (end > k && end > list.length - 3 && list[end - 1].type !== "img" && next.has(norm(list[end - 1].text))) end--;
  const out = [];
  for (const [j, x] of list.slice(k, end).entries()) {
    const at = k + j;
    if (x.type === "img") { out.push(picture(id, x)); out.at(-1).dataset.i = at; }
    else if (out.at(-1)?.classList?.contains("book-fig") && !out.at(-1).querySelector("figcaption") &&
      (x.type === "figcaption" || x.text.length < 200 && /^(figure|fig\.|plate|table|illustration|diagram|chart|map)\s*[\dIVXL]/i.test(x.text)))
      out.at(-1).append(el("figcaption", {}, x.text));
    else {
      const head = /^h\d?$/.test(x.type), text = tidy(x.text);
      out.push(el(head ? "h3" : x.type === "blockquote" ? "blockquote" : x.type === "figcaption" ? "figcaption" : "p", { "data-say": "", "data-i": at },
        head && !/\p{Ll}/u.test(text) ? tc(text) : text));  // shouted all-caps headings read as titles
    }
  }
  return out;
}
// A figure from the book: keeps its space while loading, fits the screen, opens full size on tap.
function picture(id, x) {
  const src = `/api/books/${id}/image?p=${encodeURIComponent(x.src)}`;
  const img = el("img", { src, alt: x.alt || "", loading: "lazy", decoding: "async",
    width: x.width || null, height: x.height || null,
    on: { load: () => { if (img.naturalWidth < 160 && img.naturalHeight < 160) fig.classList.add("ornament"); } } });
  const fig = el("figure", { class: "book-fig" }, el("button", { class: "zoomable", "aria-label": "View full size", on: { click: () => lightbox(src, x.alt) } }, img));
  return fig;
}
function lightbox(src, alt) {
  const box = el("div", { class: "lightbox", role: "dialog", "aria-label": "Figure", tabindex: "-1",
    on: { click: () => box.remove(), keydown: e => { if (e.key === "Escape") box.remove(); } } },
    el("img", { src, alt: alt || "" }), el("button", { class: "x", "aria-label": "Close" }, "×"));
  document.body.append(box); box.focus();
}
// ---- the reading pin: the exact line you stopped at, not just the page ---------------------------------------
// Saved as the paragraph (its index in the chapter), the character where the top line starts, a short quote of the
// text there (to find it again if the paragraph numbering ever shifts, as in the W3C TextQuoteSelector), and how far
// below the top of the screen that line sat. Restoring puts that same line back at that same height.
const topEdge = () => ($(".bar")?.getBoundingClientRect().bottom || 56) + 6;
function caretAt(x, y) {
  if (document.caretPositionFromPoint) { const c = document.caretPositionFromPoint(x, y); return c && { node: c.offsetNode, offset: c.offset }; }
  const r = document.caretRangeFromPoint?.(x, y); return r && { node: r.startContainer, offset: r.startOffset };
}
function textOffset(root, node, off) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n = 0, t;
  while ((t = w.nextNode())) { if (t === node) return n + off; n += t.length; }
  return 0;
}
function pointAt(root, off) {  // the text node and offset for a character offset in a block
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let t;
  while ((t = w.nextNode())) { if (off <= t.length) return [t, off]; off -= t.length; }
  return null;
}
function lineTop(n, off) {
  const p = off > 0 && pointAt(n, off);
  if (p && p[0].length > p[1]) { const r = new Range(); r.setStart(p[0], p[1]); r.setEnd(p[0], Math.min(p[0].length, p[1] + 1)); const b = r.getClientRects()[0]; if (b) return b.top; }
  return n.getBoundingClientRect().top;
}
function pinNow(prose, chapter) {
  const top = topEdge(), nodes = [...prose.querySelectorAll("[data-i]")];
  const n = nodes.find(x => x.getBoundingClientRect().bottom > top + 4); if (!n) return null;
  const text = n.textContent, r = n.getBoundingClientRect();
  let offset = 0;
  if (n.matches("[data-say]") && r.top < top) {
    const c = caretAt(r.left + 1, top + 4);
    if (c && n.contains(c.node)) offset = textOffset(n, c.node, c.offset);
    while (offset > 0 && /\S/.test(text[offset - 1])) offset--;  // the start of the word
  }
  const doc = document.documentElement;
  return { chapter, block: +n.dataset.i, offset, quote: text.slice(offset, offset + 48), y: Math.round(lineTop(n, offset) - top),
    percent: Math.round(Math.min(1, scrollY / Math.max(1, doc.scrollHeight - innerHeight)) * 100) };
}
// find the pinned text again: same paragraph and offset if the quote still matches, else the quote nearest that paragraph
function findPin(prose, a) {
  const nodes = [...prose.querySelectorAll("[data-i]")];
  let n = prose.querySelector(`[data-i="${a.block}"]`), off = a.offset || 0;
  if (!a.quote || (n && n.textContent.slice(off, off + a.quote.length) === a.quote)) return n && [n, off];
  for (const len of [a.quote.length, 24, 12]) {
    const qq = a.quote.slice(0, len).trim(); if (qq.length < 6) break;
    const hits = nodes.map(x => [x, x.textContent.indexOf(qq)]).filter(([, i]) => i >= 0);
    if (hits.length) { const [x, i] = hits.sort((p, q) => Math.abs(p[0].dataset.i - a.block) - Math.abs(q[0].dataset.i - a.block))[0]; return [x, i]; }
  }
  return n && [n, 0];
}
function restorePin(prose, a) {
  const hit = findPin(prose, a); if (!hit) return false;
  const [n, off] = hit;
  scrollTo(0, Math.max(0, scrollY + lineTop(n, off) - topEdge() - (a.y || 0)));
  return true;
}
function trackReading(b, i, prose, pin) {
  if (pin) {  // twice: once now, once after fonts and pictures have settled
    requestAnimationFrame(() => restorePin(prose, pin));
    (document.fonts?.ready || Promise.resolve()).then(() => setTimeout(() => prose.isConnected && restorePin(prose, pin), 120));
  }
  let timer = null, last = "";
  const save = () => {
    if (!prose.isConnected) return removeEventListener("scroll", onScroll);
    if (Narrator.state.on && Narrator.state.book === b.id) return;  // while listening, the voice moves the pin
    const a = pinNow(prose, i); if (!a) return;
    const key = `${a.chapter}:${a.block}:${a.offset}`; if (key === last) return; last = key;
    Sync.op(b.id, "pos", a);
  };
  const onScroll = () => { clearTimeout(timer); timer = setTimeout(save, 700); };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
  setTimeout(save, pin ? 1200 : 300);
}

// ---- highlights: select text, keep it. Stored as operations like the pin, drawn with the CSS Highlight API ----------
const Highlights = (() => {
  let list = [], prose = null, book = null, ch = null, tip = null;
  const canPaint = window.CSS?.highlights && typeof Highlight === "function";
  async function load(b, i, p) {
    book = b; ch = i; prose = p;
    try { list = (await api(`/api/books/${b.id}/highlights`)).highlights; } catch { list = []; }
    paint();
  }
  function ranges() {
    const out = [];
    for (const h of list.filter(h => h.chapter === ch)) {
      const n = prose?.querySelector(`[data-i="${h.block}"]`); if (!n) continue;
      const a = pointAt(n, h.start), z = pointAt(n, h.end); if (!a || !z) continue;
      const r = new Range(); r.setStart(...a); r.setEnd(...z); out.push([h, r]);
    }
    return out;
  }
  function paint() { if (canPaint && prose) CSS.highlights.set("hl", new Highlight(...ranges().map(x => x[1]))); }
  function hide() { tip?.remove(); tip = null; }
  function show(x, y, items) {
    hide();
    tip = el("div", { class: "hl-tip", role: "toolbar", style: `left:${Math.max(8, Math.min(innerWidth - 220, x - 90))}px;top:${Math.max(64, y - 52) + scrollY}px` },
      items.map(([t, f]) => el("button", { on: { mousedown: e => e.preventDefault(), click: e => { e.stopPropagation(); f(); hide(); } } }, t)));
    document.body.append(tip);
  }
  function selected() {
    const sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed || !prose) return [];
    const r = sel.getRangeAt(0), out = [];
    for (const n of prose.querySelectorAll("[data-say]")) {
      if (!r.intersectsNode(n)) continue;
      const start = n.contains(r.startContainer) ? textOffset(n, r.startContainer, r.startOffset) : 0;
      const end = n.contains(r.endContainer) ? textOffset(n, r.endContainer, r.endOffset) : n.textContent.length;
      if (end > start) out.push({ block: +n.dataset.i, start, end, quote: n.textContent.slice(start, end).slice(0, 400) });
    }
    return out;
  }
  function onSelect() {
    const parts = selected(); if (!parts.length) return hide();
    const rect = getSelection().getRangeAt(0).getBoundingClientRect();
    show(rect.left + rect.width / 2, rect.top, [["Highlight", () => {
      for (const x of parts) {
        const h = { id: Sync.dev + "-" + Date.now().toString(36) + x.block, chapter: ch, ...x };
        list.push(h); Sync.op(book.id, "hl", h);
      }
      getSelection().removeAllRanges(); paint(); toast("Highlighted");
    }], ["Copy", () => copyText(parts.map(x => x.quote).join("\n"), "Copied")]]);
  }
  function onTap(e) {  // tap a highlight to remove it
    if (getSelection().toString() || Narrator.state.bar) return false;
    const c = caretAt(e.clientX, e.clientY), n = c && e.target.closest?.("[data-say]"); if (!n || !n.contains(c.node)) return false;
    const off = textOffset(n, c.node, c.offset);
    const h = list.find(h => h.chapter === ch && h.block === +n.dataset.i && off >= h.start && off <= h.end); if (!h) return false;
    show(e.clientX, e.clientY, [["Remove highlight", () => remove(h)], ["Copy", () => copyText(h.quote, "Copied")]]);
    return true;
  }
  function remove(h) { list = list.filter(x => x.id !== h.id); Sync.op(book.id, "hl-", { id: h.id }); paint(); toast("Highlight removed"); }
  document.addEventListener("selectionchange", () => { clearTimeout(onSelect.t); onSelect.t = setTimeout(() => { if (prose?.isConnected && getSelection().toString().trim()) onSelect(); }, 350); });
  document.addEventListener("pointerdown", e => { if (tip && !e.target.closest(".hl-tip")) hide(); });
  return { load, onTap, remove, hide, get list() { return list; } };
})();

const q = k => new URLSearchParams(location.search).get(k);
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 2 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
async function cardView(body, id, i, make = false) {
  if (make) body.replaceChildren(el("p", { class: "muted caret" }, "Writing the card"));
  let r; const tok = S.tok;
  try { r = await api(`/api/books/${id}/chapters/${i}/card${make ? `?make=1&provider=${PROVIDER}` : ""}`); }
  catch (e) { return body.replaceChildren(errorBox(e.message)); }
  if (tok !== S.tok) return;
  if (!r.card) return body.replaceChildren(el("div", { class: "empty" }, el("p", {}, "No card yet."),
    el("button", { class: "btn", on: { click: () => cardView(body, id, i, true) } }, "Make the card")), myHighlights(id, i));
  const c = r.card, deeper = el("div");
  S.book.stale = true;
  body.replaceChildren(split([
    el("p", { class: "kicker" }, "The lesson"), el("p", { class: "core-lesson" }, c.core),
    termList(c.terms),
    el("ol", { class: "lessons" }, c.lessons.map(l => el("li", {}, el("div", { class: "lesson" }, l.lesson), el("div", { class: "why" }, l.why)))),
    c.remember ? el("p", { class: "remember" }, c.remember) : null,
    el("div", { class: "actions" },
      el("button", { class: "btn ghost", on: { click: e => { e.target.remove(); goDeeper(deeper, id, i); } } }, "Go deeper"),
      el("button", { class: "link", on: { click: () => copyText(cardMd(`${tc(S.book.chapters.find(x => x.index === i)?.title || "")} (${short(S.book.title)})`, c, r.diagram), "Card copied as Markdown") } }, "Copy as Markdown")),
    deeper, myHighlights(id, i)], [r.figure ? picture(id, r.figure) : null, diagramBox(r.diagram)]));
}
// Words the book uses its own way, defined before the lessons that use them
function termList(ts, link) {
  if (!(ts || []).length) return null;
  return el("dl", { class: "terms" }, ts.flatMap(t => [el("dt", {}, t.term),
    el("dd", {}, t.meaning, link && t.title ? el("a", { class: "src", href: `/book/${link}/${t.chapter}`, "data-link": true }, ` ${tc(t.title)}`) : null)]));
}
// Your highlights in this chapter, each one tap from its place in the text
function myHighlights(id, i) {
  const box = el("div", { class: "my-hl-box" });
  api(`/api/books/${id}/highlights`).then(r => {
    const hs = r.highlights.filter(h => h.chapter === i); if (!hs.length) return;
    box.append(el("p", { class: "kicker" }, "Your highlights"), el("ul", { class: "my-hl" }, hs.map(h => el("li", {}, h.quote,
      el("div", { class: "row-act" }, el("a", { href: `/book/${id}/${i}?tab=read&at=${h.block}&o=${h.start}&qt=${encodeURIComponent(h.quote.slice(0, 48))}`, "data-link": true }, "Read it in place"),
        el("button", { class: "link", on: { click: e => { Sync.op(id, "hl-", { id: h.id }); e.target.closest("li").remove(); toast("Highlight removed"); } } }, "Remove"))))),
      el("button", { class: "link", on: { click: () => copyText(hs.map(h => `> ${h.quote}`).join("\n\n"), "Highlights copied as Markdown") } }, "Copy highlights as Markdown"));
  }).catch(() => {});
  return box;
}
function goDeeper(target, id, i) {
  target.className = "deeper";
  const out = el("div", { class: "md caret" });
  target.replaceChildren(out);
  let text = "";
  const es = new EventSource(`/api/books/${id}/chapters/${i}/distill?provider=${PROVIDER}`);
  es.addEventListener("chunk", e => { text += JSON.parse(e.data); setMd(out, text); });
  es.addEventListener("reset", () => { text = ""; });
  es.addEventListener("done", () => { es.close(); out.classList.remove("caret"); });
  es.addEventListener("fail", e => { es.close(); out.classList.remove("caret"); out.append(errorBox(JSON.parse(e.data))); });
  es.onerror = () => { es.close(); out.classList.remove("caret"); };
}

// ---- diagrams: drawn only when the ideas have a structure a list cannot show ------------------
// The server sends a checked spec: a Mermaid flowchart (cause, process, cycle, concept map) or a comparison table.
let mermaidReady = null, mermaidN = 0;
function loadMermaid() {
  return mermaidReady ||= new Promise((ok, fail) => {
    const s = el("script", { src: "/static/vendor/mermaid.min.js" });
    s.onload = () => {
      mermaid.initialize({ startOnLoad: false, theme: "base", securityLevel: "strict",
        themeVariables: { fontFamily: getComputedStyle(document.body).fontFamily, fontSize: "15px",
          primaryColor: "#fffdf8", primaryTextColor: "#1f1d1a", primaryBorderColor: "#b9ae9b", lineColor: "#8a8276",
          edgeLabelBackground: "#f7f4ee", tertiaryColor: "#f7f4ee" },
        flowchart: { htmlLabels: true, curve: "basis", nodeSpacing: 26, rankSpacing: 46, padding: 10, wrappingWidth: 150, useMaxWidth: true } });
      ok(window.mermaid);
    };
    s.onerror = fail; document.head.append(s);
  });
}
function diagramBox(d) {
  if (!d) return null;
  const name = (d.title || d.kind || "diagram").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const items = d.type === "compare" ? [["Copy as Markdown table", () => copyText(compareMd(d), "Table copied")]] : [
    ["Copy Mermaid code", () => copyText(d.mermaid, "Mermaid code copied. It pastes into Obsidian, GitHub, Notion or Excalidraw.")],
    ["Save as SVG", async () => save(new Blob([await exportSvg(d)], { type: "image/svg+xml" }), `${name}.svg`)],
    ["Save as PNG", async () => save(await svgToPng(await exportSvg(d)), `${name}.png`)]];
  const box = el("figure", { class: `diagram ${d.type}`, "data-type": d.type },
    el("figcaption", {}, el("span", { class: "kicker" }, d.kind), d.title ? el("span", { class: "dg-title" }, d.title) : null),
    menu("Diagram options", items));
  if (d.type === "compare") {
    box.append(el("table", { class: "compare" },
      el("thead", {}, el("tr", {}, el("th", {}), el("th", {}, d.sides[0]), el("th", {}, d.sides[1]))),
      el("tbody", {}, d.rows.map(r => el("tr", {}, el("th", { scope: "row" }, r.aspect), el("td", {}, r.a), el("td", {}, r.b))))));
    return box;
  }
  const holder = el("div", { class: "mmd", role: "img", "aria-label": d.title || d.kind });
  box.append(holder);
  loadMermaid().then(async m => {
    const { svg } = await m.render(`mmd${++mermaidN}`, d.mermaid);
    holder.innerHTML = clean(svg, true); holder.dataset.ready = "1";
  }).catch(e => { holder.dataset.ready = "error"; holder.append(el("p", { class: "error small" }, "Could not draw the diagram: " + e.message)); });
  return box;
}

// ---- export: a small menu of native formats (Mermaid code, SVG, PNG, Markdown) ---------------------
function menu(label, items) {
  const btn = el("button", { class: "more", "aria-label": label, "aria-haspopup": "menu", "aria-expanded": "false", title: label }, "•••");
  const wrapEl = el("div", { class: "menu-wrap" }, btn);
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const open = $(".menu", wrapEl); document.querySelectorAll(".menu").forEach(m => m.remove()); document.querySelectorAll(".more").forEach(b => b.setAttribute("aria-expanded", "false"));
    if (open) return;
    btn.setAttribute("aria-expanded", "true");
    wrapEl.append(el("div", { class: "menu", role: "menu" }, items.map(([t, f]) => el("button", { role: "menuitem",
      on: { click: async ev => { ev.stopPropagation(); wrapEl.querySelector(".menu")?.remove(); btn.setAttribute("aria-expanded", "false"); try { await f(); } catch (err) { toast("That did not work: " + err.message); } } } }, t))));
  });
  return wrapEl;
}
document.addEventListener("click", () => { document.querySelectorAll(".menu").forEach(m => m.remove()); document.querySelectorAll(".more").forEach(b => b.setAttribute("aria-expanded", "false")); });
function toast(t, action) {  // action: [label, fn], e.g. ["Undo", restore]; such a toast stays longer
  $(".toast")?.remove();
  const n = el("div", { class: "toast", role: "status" }, t,
    action ? el("button", { class: "toast-act", on: { click: async () => { n.remove(); await action[1](); } } }, action[0]) : null);
  document.body.append(n);
  setTimeout(() => n.remove(), action ? 9000 : 2600);
}
// A book whose chapters look cut in the wrong places says so, and offers the AI fix; a fixed one says who fixed it and offers Undo
function structureNote(b) {
  const st = b.structure || {};
  if (!st.flagged && !st.ai) return null;
  const box = el("p", { class: "structure-note" });
  const after = () => { S.book = null; if (location.pathname.startsWith(`/book/${b.id}`)) route(); };
  const poll = async () => {
    const r = await api(`/api/books/${b.id}/structure`);
    const j = r.job || {};
    if (j.state === "running") { box.replaceChildren("Re-splitting the chapters with AI…"); return setTimeout(poll, 2000); }
    if (j.state === "done") { toast("Chapters re-split. Cards follow their chapters."); return after(); }
    draw(r, j.message);
  };
  const draw = (r, msg) => {
    if (r.ai) return box.replaceChildren(`Chapters re-split by AI (${r.ai.model}). `,
      el("button", { class: "link", on: { click: async () => { await api(`/api/books/${b.id}/structure/revert`, { method: "POST" }); toast("Back to the book's own chapters."); after(); } } }, "Undo"));
    box.replaceChildren(msg ? `${msg} ` : `The chapters may be cut in the wrong places (${(r.issues || [])[0] || "low score"}). `,
      el("button", { class: "link", on: { click: async () => { await api(`/api/books/${b.id}/structure/repair`, { method: "POST", body: "{}" }); poll(); } } }, "Repair with AI"));
  };
  api(`/api/books/${b.id}/structure`).then(r => (r.job || {}).state === "running" ? poll() : draw(r, (r.job || {}).message)).catch(() => box.remove());
  return box;
}
// Deleting a book: asked once, undone from the toast, and kept 30 days under "Recently deleted" in the library
async function deleteBook(b) {
  if (!confirm(`Delete “${short(b.title)}”? Its cards, notes and highlights go with it. You can restore it for 30 days.`)) return;
  await api(`/api/books/${b.id}`, { method: "DELETE" });
  S.book = null; Offline.drop(b.id).catch(() => {});
  go("/");
  toast(`Deleted “${brief(b.title, 28)}”.`, ["Undo", () => restoreBook(b.id)]);
}
async function restoreBook(id) {
  const r = await api(`/api/trash/${id}/restore`, { method: "POST" });
  toast(`Restored “${brief(r.title, 28)}”.`);
  if (location.pathname === "/") route();
}
async function copyText(text, done = "Copied") {
  try { await navigator.clipboard.writeText(text); }
  catch {  // plain http (for example over Tailscale) has no clipboard API
    const ta = el("textarea", { style: "position:fixed;opacity:0" }); ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); if (!ok) throw new Error("the browser blocked copying");
  }
  toast(done);
}
function save(blob, filename) {
  const a = el("a", { href: URL.createObjectURL(blob), download: filename }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast(`Saved ${filename}`);
}
const compareMd = d => [`| | ${d.sides[0]} | ${d.sides[1]} |`, "|---|---|---|", ...d.rows.map(r => `| ${r.aspect} | ${r.a} | ${r.b} |`)].join("\n");
// a standalone SVG with plain text labels (no HTML inside), so it opens anywhere and can be drawn to a PNG
async function exportSvg(d) {
  const m = await loadMermaid();
  const { svg } = await m.render(`mmdx${++mermaidN}`, `%%{init: {"flowchart": {"htmlLabels": false}}}%%\n${d.mermaid}`);
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml"), root = doc.documentElement, vb = root.viewBox.baseVal;
  root.setAttribute("width", Math.ceil(vb.width)); root.setAttribute("height", Math.ceil(vb.height)); root.removeAttribute("style");
  const bg = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  Object.entries({ x: vb.x, y: vb.y, width: vb.width, height: vb.height, fill: "#fffdf8" }).forEach(([k, v]) => bg.setAttribute(k, v));
  root.insertBefore(bg, root.firstChild);
  return new XMLSerializer().serializeToString(root);
}
function svgToPng(svg) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"), k = 2; c.width = img.width * k; c.height = img.height * k;
      const g = c.getContext("2d"); g.fillStyle = "#fffdf8"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? ok(b) : fail(new Error("could not make the image")), "image/png");
    };
    img.onerror = () => fail(new Error("could not draw the diagram"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
function cardMd(title, c, diagram) {
  const out = [`## ${title}`, "", `**${c.core}**`, ...(c.terms || []).flatMap(t => ["", `*${t.term}*: ${t.meaning}`]), "", ...c.lessons.map((l, i) => `${i + 1}. **${l.lesson}** ${l.why}`)];
  if (c.remember) out.push("", `> ${c.remember}`);
  if ((c.timeless || []).length) out.push("", "Timeless ideas:", ...c.timeless.map(t => `- ${t}`));
  if (diagram?.mermaid) out.push("", "```mermaid", diagram.mermaid, "```");
  if (diagram?.type === "compare") out.push("", compareMd(diagram));
  return out.join("\n");
}

// ---- front and back matter ---------------------------------------------------------------------
async function showMatter(id) {
  const tok = S.tok, b = await loadBook(id);
  const r = await api(`/api/books/${id}/matter`);
  if (tok !== S.tok) return;
  document.title = `Front & back matter · ${b.title}`;
  app.replaceChildren(el("a", { class: "back", href: `/book/${id}?tab=chapters`, "data-link": true }, `← ${short(b.title)}`),
    el("h1", {}, "Front & back matter"), el("p", { class: "by" }, "Title page, contents, notes and the rest, together. Not distilled."),
    el("article", { class: "prose" }, r.sections.map(s => [el("h3", {}, tc(s.title)), blocks(s.blocks, id, s.title)])));
}


const BADGE = { ready: "Ready", "signed-out": "Signed out", "not-installed": "Not installed", "no-key": "No key", "rate-limited": "Rate limited" };
const SIGN_IN = { "claude-cli": "claude   (then type /login once)", "codex-cli": "codex login --device-auth", "grok-cli": "grok login --device-auth" };
function statusText(p) {
  const st = p.status || {};
  if (st.state === "ready") return p.cli ? `Ready: ${st.detail}. Uses your own plan, no API key.` : `Ready (${st.detail}).`;
  if (st.state === "rate-limited") return "Hit its usage limit recently. Until it resets, the next ready provider answers.";
  if (st.state === "signed-out") return `Not signed in on the server. Sign in once there with: ${SIGN_IN[p.id] || "the provider's login command"}`;
  if (st.state === "not-installed") return "Its official app is not installed on the server.";
  if (p.id === "custom") return "Add the server address below.";
  return (st.detail === "the key was refused" ? "The key was refused (revoked or wrong). " : "No key yet. ") + "New cards and answers are paused; reading, listening, the graph and saved cards still work.";
}

// ---- Settings: which AI writes cards and answers, keys, this device, sync, offline -----------------------------
async function showSettings() {
  document.title = "Settings · Commonplace";
  const tok = S.tok, r = await api("/api/settings"), lib = await api("/api/library").catch(() => ({}));
  if (tok !== S.tok) return;  // Library or Ideas was tapped while the provider status loaded
  const body = el("div", { class: "settings-page" });
  app.replaceChildren(el("h1", {}, "Settings"), body);
  const render = r => {
    const cur = r.providers.find(p => p.id === r.provider) || r.providers[0];
    const pick = el("select", { id: "provider", "aria-label": "Provider", on: { change: e => save({ provider: e.target.value, model: "" }) } },
      r.providers.filter(p => p.id !== "ollama").map(p => el("option", { value: p.id, selected: p.id === r.provider ? true : null }, p.label)));
    const models = el("select", { id: "model", "aria-label": "Model", on: { change: e => save({ provider: r.provider, model: e.target.value }) } },
      cur.models.map(m => el("option", { value: m.id, selected: m.id === cur.model ? true : null }, m.label)));
    const state = el("p", { class: (cur.available ? "ok" : "warn") + " small" }, statusText(cur));
    const keyBox = cur.key ? keyRow(cur) : cur.cli && cur.status?.state !== "not-installed" ? cliRow(cur) : null;
    const custom = cur.id === "custom" ? el("div", { class: "row" },
      el("label", {}, "Server address", el("input", { id: "cu-url", value: r.custom.base_url || "", placeholder: "https://openrouter.ai/api/v1" })),
      el("label", {}, "Model name", el("input", { id: "cu-model", value: r.custom.model || "", placeholder: "deepseek/deepseek-chat" })),
      el("button", { class: "btn ghost", on: { click: () => save({ provider: "custom", custom: { base_url: $("#cu-url").value, model: $("#cu-model").value } }) } }, "Save")) : null;
    body.replaceChildren(
      el("section", {}, el("h2", {}, "AI for cards and Ask"),
        el("p", { class: "muted small" }, "Cards are made once per chapter and kept. Cheap models are the default."),
        el("div", { class: "row two" }, el("label", {}, "Provider", pick), cur.models.length ? el("label", {}, "Model", models) : null),
        state, custom, keyBox,
        el("label", { class: "check" }, el("input", { type: "checkbox", checked: r.fallback ? true : null, on: { change: e => save({ provider: r.provider, model: cur.model, fallback: e.target.checked }) } }),
          "If it is out of credit, signed out or rate limited, let the next ready provider answer"),
        el("details", { class: "providers-status" }, el("summary", {}, `Every provider (${r.providers.filter(p => p.available && p.id !== "ollama").length} ready)`),
          el("ul", {}, r.providers.filter(p => p.id !== "ollama").map(p => el("li", {}, el("span", { class: `badge ${p.status.state}` }, BADGE[p.status.state] || p.status.state), " ", p.label))))),
      el("section", {}, el("h2", {}, "Listening"),
        el("label", { class: "check" }, el("input", { type: "checkbox", checked: Narrator.pref.recap ? true : null, on: { change: e => { Narrator.pref.recap = e.target.checked; Narrator.save(); } } }),
          "After a break of more than 30 minutes, start with a one-line recap of what came before"),
        el("p", { class: "muted small" }, "After any break longer than a few seconds, the voice goes back up to 15 seconds, to the start of a sentence.")),
      el("section", {}, el("h2", {}, "This device"),
        installRow(),
        el("p", { class: "small" }, `This device is “${Sync.name}”. Positions and highlights from every device meet on the server; the newest wins. `,
          Sync.pending() ? `${Sync.pending()} change(s) waiting for a connection.` : "Everything is sent."),
        lib.id ? el("p", { class: "small muted" }, "Library pairing code: ", el("code", {}, lib.id), ". Another copy of Commonplace syncs with this one only if it has the same code (see SYNC.md).") : null));
  };
  function cliRow(p) {  // a subscription has no key; one tiny request shows the sign-in works
    const msg = el("p", { class: "small" });
    return el("div", { class: "row keyrow" }, el("div", { class: "actions" },
      el("button", { class: "btn ghost", on: { click: async () => { msg.textContent = "Asking…"; const x = await api(`/api/keys/${p.id}/check`, { method: "POST" }); render(x); toast(x.check.ok ? "It answers." : "It did not answer"); } } }, "Test")), msg);
  }
  function keyRow(p) {
    const input = el("input", { type: "password", autocomplete: "off", placeholder: p.key.set ? `Saved key ${p.key.hint || ""}` : "Paste an API key", "aria-label": `${p.label} API key` });
    const msg = el("p", { class: "small" });
    return el("div", { class: "row keyrow" }, el("label", {}, `${p.label} key`, input),
      el("div", { class: "actions" },
        el("button", { class: "btn", on: { click: async () => { msg.textContent = "Checking…"; try { const x = await api(`/api/keys/${p.id}`, { method: "PUT", body: JSON.stringify({ key: input.value }) }); show(x, x.check.ok ? "Saved. The key works." : "Saved, but the check failed: " + x.check.error); } catch (e) { msg.textContent = e.message; } } } }, "Save key"),
        p.key.set ? el("button", { class: "btn ghost", on: { click: async () => { msg.textContent = "Checking…"; const x = await api(`/api/keys/${p.id}/check`, { method: "POST" }); msg.textContent = x.check.ok ? "The key works." : x.check.error; } } }, "Test") : null,
        p.key.source === "settings" ? el("button", { class: "link", on: { click: async () => { const x = await api(`/api/keys/${p.id}`, { method: "DELETE" }); show(x, "Key removed."); } } }, "Remove key") : null),
      p.key.source && p.key.source !== "settings" ? el("p", { class: "muted small" }, `This key comes from the server's ${p.key.source}; change it there.`) : null, msg);
  }
  const show = (x, t) => { render(x); toast(t); };
  async function save(body) { try { render(await api("/api/settings", { method: "POST", body: JSON.stringify(body) })); toast("Saved"); } catch (e) { toast(e.message); } }
  render(r);
}

// ---- installable app: service worker, install prompt, books kept for offline reading ---------------------------
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; document.body.classList.add("can-install"); $("#install-row")?.replaceWith(installRow()); });
addEventListener("appinstalled", () => { installEvt = null; document.body.classList.remove("can-install"); toast("Installed. Open Commonplace from your home screen."); });
function installRow() {
  const standalone = matchMedia("(display-mode: standalone)").matches;
  if (standalone) return el("p", { id: "install-row", class: "small ok" }, "Running as an installed app.");
  if (installEvt) return el("div", { id: "install-row", class: "row" }, el("button", { class: "btn", on: { click: async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; } } }, "Install Commonplace on this device"));
  return el("p", { id: "install-row", class: "small muted" }, isSecureContext ? "To install: open the browser menu and choose “Install app” or “Add to Home screen”." : "Installing needs the https address of this server.");
}
if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
const Offline = {
  async has(id) { if (!window.caches) return false; const c = await caches.open("books"); return !!(await c.match(`/api/books/${id}/chapters/${S.book?.chapters?.at(-1)?.index ?? 0}`)); },
  async keep(id, onStep) {
    const { urls } = await api(`/api/books/${id}/offline`), c = await caches.open("books");
    let n = 0;
    for (let i = 0; i < urls.length; i += 6) {
      await Promise.all(urls.slice(i, i + 6).map(async u => { const r = await fetch(u); if (r.ok) await c.put(u, r); n++; }));
      onStep?.(n, urls.length);
    }
  },
  async drop(id) { const c = await caches.open("books"); for (const k of await c.keys()) if (new URL(k.url).pathname.startsWith(`/api/books/${id}`)) await c.delete(k); },
};
function offlineButton(b) {
  if (!window.caches || !isSecureContext) return null;
  const btn = el("button", { class: "link offline-btn" }, "Keep offline");
  Offline.has(b.id).then(h => { if (h) { btn.textContent = "Kept offline ✓"; btn.dataset.kept = "1"; } });
  btn.addEventListener("click", async () => {
    if (btn.dataset.kept) { await Offline.drop(b.id); btn.textContent = "Keep offline"; delete btn.dataset.kept; return toast("Removed from this device"); }
    btn.disabled = true;
    try { await Offline.keep(b.id, (n, t) => { btn.textContent = `Saving ${Math.round(n / t * 100)}%`; }); btn.textContent = "Kept offline ✓"; btn.dataset.kept = "1"; toast("The whole book is on this device now"); }
    catch (e) { btn.textContent = "Keep offline"; toast("Could not save: " + e.message); }
    btn.disabled = false;
  });
  return btn;
}

// ---- Ask ---------------------------------------------------------------------------------------
async function chat(body, id, scope, label) {
  const list = el("div", { class: "chat" });
  const input = el("input", { placeholder: `Ask about ${scope === "book" ? "this book" : "this chapter"}`, "aria-label": "Question" });
  const form = el("form", { on: { submit: e => { e.preventDefault(); const v = input.value.trim(); if (v) { input.value = ""; ask(list, id, scope, v); } } } },
    input, el("button", { class: "btn" }, "Ask"));
  body.append(list, el("div", { class: "composer" }, form));
  const msgs = (await api(`/api/books/${id}/chat/${scope}`)).messages;
  if (!msgs.length) {
    const qs = scope === "book" ? ["What is the one idea I should keep?", "How do I apply this to my work?", "Where is the author weakest?"]
      : ["Explain the core lesson simply", "Give me a real-life example", "What would the author say I get wrong?"];
    list.append(el("div", { class: "suggest" }, qs.map(t => el("button", { type: "button", on: { click: () => ask(list, id, scope, t) } }, t))));
  }
  for (const m of msgs) list.append(bubble(m.role, m.content.replace(/```diagram[\s\S]*?```/g, "")));
}
function bubble(role, text) {
  return role === "user" ? el("div", { class: "msg user" }, text) : el("div", { class: "msg bot" }, md(text));
}
async function ask(list, id, scope, message) {
  list.querySelector(".suggest")?.remove();
  list.append(bubble("user", message));
  const out = el("div", { class: "md caret" });
  list.append(el("div", { class: "msg bot" }, out));
  out.scrollIntoView({ block: "end", behavior: "smooth" });
  const ctrl = S.abort = new AbortController();
  let text = "", failed = null;
  try {
    const r = await fetch(`/api/books/${id}/chat/${scope}`, { method: "POST", signal: ctrl.signal, body: JSON.stringify({ provider: PROVIDER, message }) });
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = raw.match(/^event: (\w+)/)?.[1], data = raw.match(/\ndata: (.*)$/s)?.[1];
        if (ev === "chunk") { text += JSON.parse(data); setMd(out, text); }
        else if (ev === "fail") failed = JSON.parse(data);
      }
    }
  } catch (e) { if (e.name === "AbortError") return; failed = e.message; }
  out.classList.remove("caret");
  if (failed) out.append(errorBox(failed));
}

// ---- Ideas: a live graph of books, chapters, lessons and mental models (after Obsidian's graph view) ---------
// Drag a node and the rest follow; drag the background to pan; scroll or pinch to zoom; labels appear as you zoom in.
// Hover lights up a node's neighbours; click opens it; "Local graph" keeps only what is near it. No library.
const PALETTE = ["#b4532a", "#2f6f62", "#5a5fb0", "#a2741b", "#8a4f9e", "#3d7fa6", "#9c4a5c", "#55803a"];
const RADIUS = { book: 13, chapter: 4.5, lesson: 6.5, across: 8, model: 5 };
const KIND = { book: "Book", chapter: "Chapter", lesson: "Key lesson", across: "Across books", model: "Mental model" };
async function showIdeas() {
  document.title = "Ideas · Commonplace";
  app.className = "wide";
  const tok = S.tok, g = await api("/api/graph");
  if (tok !== S.tok) return;
  const wrap = el("div", { class: "graph-wrap" });
  app.replaceChildren(wrap);
  if (!g.nodes.length) return wrap.append(el("p", { class: "empty" }, "Distill a book to see its ideas here."));
  const NS = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const books = g.nodes.filter(n => n.type === "book"), color = {};
  books.forEach((b, i) => { color[b.book] = PALETTE[i % PALETTE.length]; });
  const byId = {}, nb = {};
  const nodes = g.nodes.map((n, i) => (byId[n.id] = { ...n, x: Math.cos(i * 2.4) * 30 * Math.sqrt(i + 1), y: Math.sin(i * 2.4) * 30 * Math.sqrt(i + 1), vx: 0, vy: 0 }));
  const links = g.links.filter(l => byId[l.source] && byId[l.target]).map(l => ({ s: byId[l.source], t: byId[l.target] }));
  for (const l of links) { (nb[l.s.id] ||= new Set()).add(l.t.id); (nb[l.t.id] ||= new Set()).add(l.s.id); }
  // a model also hangs straight off each book that uses it, for the views where chapters are hidden (big libraries, model filters)
  for (const m of nodes) if (m.type === "model") for (const bk of m.books || []) if (byId[`b:${bk}`]) links.push({ s: byId[`b:${bk}`], t: m, agg: true });
  for (const n of nodes) if (n.type === "lesson" && byId[`b:${n.book}`]) links.push({ s: byId[`b:${n.book}`], t: n, agg: true });  // lessons too, for the lessons filter
  // Big libraries open as an overview (books, shared models, cross-book lessons) and a book opens its chapters on request:
  // semantic zoom by aggregation, as in Gephi and Kumu. Below this size everything is shown at once.
  const BIG = books.length > 24;
  for (const n of nodes) {
    n.deg = nb[n.id]?.size || 0;
    n.r = RADIUS[n.type] + (n.type === "model" ? Math.min(6, Math.sqrt(n.deg) * 1.4) : n.type === "book" ? Math.min(6, Math.sqrt(n.deg) * .6) : 0);
    if (n.type === "model" && !n.shared && n.books?.length === 1) n.home = n.books[0];  // a model only one book uses sits with that book
    n.fill = n.type === "model" ? (n.shared ? "var(--ink)" : color[n.home] || "var(--muted)") : n.type === "across" ? "var(--accent)" : color[n.book] || "var(--muted)";
    n.short = (n.type === "book" ? short(n.label) : n.type === "chapter" ? titleParts(n.label)[1] : n.label);
    if (n.short.length > 44) n.short = n.short.slice(0, 42).replace(/\s+\S*$/, "") + "…";
  }
  for (const n of nodes) n.deg ||= 1;
  const members = {}; for (const n of nodes) { const hb = n.type !== "book" && (n.book || n.home); if (hb) (members[hb] ||= []).push(n); }
  // books start spread on a circle so each grows its own neighbourhood
  // the layout takes the screen's shape: wide on desktop, tall on a phone (weaker pull along the long side)
  const ratio = Math.max(0.45, Math.min(2.2, (wrap.clientWidth || 1000) / (wrap.clientHeight || 700))), GX = 0.045 / ratio, GY = 0.045 * ratio;
  books.forEach((b, i) => { const n = byId[b.id], t = i * 2 * Math.PI / books.length - Math.PI / 2; n.x = Math.cos(t) * 320 * Math.sqrt(ratio); n.y = Math.sin(t) * 320 / Math.sqrt(ratio); });
  for (const n of nodes) { const hb = n.book || n.home; if (hb && n.type !== "book") { const b = byId[`b:${hb}`]; n.x += b.x; n.y += b.y; } }

  // --- simulation (velocity Verlet, as in d3-force): repulsion, springs, a weak pull to the centre, no overlaps
  let alpha = 1, alphaTarget = 0, visible = new Set(nodes.map(n => n.id));
  const live = { nodes, links: [] };  // what is shown, kept as lists so each frame walks only those
  const relive = () => { live.nodes = nodes.filter(n => visible.has(n.id)); live.links = links.filter(l => l.on); };
  const DIST = { chapter: 46, lesson: 40, model: 80, across: 120 };
  function tick() {
    const vs = live.nodes, ls = live.links;
    alpha += (alphaTarget - alpha) * 0.0228;
    for (const l of ls) {
      const d0 = l.s.type === "book" || l.t.type === "book" ? DIST[l.t.type === "book" ? l.s.type : l.t.type] || 60 : DIST[l.t.type] || 60;
      let dx = l.t.x + l.t.vx - l.s.x - l.s.vx, dy = l.t.y + l.t.vy - l.s.y - l.s.vy, d = Math.hypot(dx, dy) || 1;
      const k = (d - d0) / d * alpha * 0.7 / Math.min(l.s.deg, l.t.deg), bias = l.s.deg / (l.s.deg + l.t.deg);
      dx *= k; dy *= k; l.t.vx -= dx * bias; l.t.vy -= dy * bias; l.s.vx += dx * (1 - bias); l.s.vy += dy * (1 - bias);
    }
    // repulsion reaches 400 units, so only nodes in neighbouring 400-unit cells can push each other (a grid, not every pair)
    const grid = new Map(), key = (i, j) => i * 100003 + j;
    for (const n of vs) { n.gi = Math.floor(n.x / 400); n.gj = Math.floor(n.y / 400); const k = key(n.gi, n.gj); (grid.get(k) || grid.set(k, []).get(k)).push(n); }
    for (const p of vs) for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const q of grid.get(key(p.gi + di, p.gj + dj)) || []) {
      if (q.id <= p.id) continue;  // each pair once
      let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
      if (d2 < 160000) {
        const w = 70 * alpha / d2, a = w * (q.type === "book" ? 3 : 1), b = w * (p.type === "book" ? 3 : 1);
        p.vx -= dx * a; p.vy -= dy * a; q.vx += dx * b; q.vy += dy * b;
      }
      const min = p.r + q.r + 3, d = Math.sqrt(d2);
      if (d < min) { const f = (min - d) / d * .5; p.vx -= dx * f * .5; p.vy -= dy * f * .5; q.vx += dx * f * .5; q.vy += dy * f * .5; }
    }
    for (const n of vs) {  // each book's ideas gather around it, so a book reads as one region (as in InfraNodus or Heptabase)
      const hb = n.type !== "book" && (n.book || n.home), b = hb && byId[`b:${hb}`];
      if (b && visible.has(b.id)) { n.vx += (b.x - n.x) * 0.02 * alpha; n.vy += (b.y - n.y) * 0.02 * alpha; }
    }
    for (const n of vs) {
      n.vx -= n.x * GX * alpha; n.vy -= n.y * GY * alpha;
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy;
    }
  }
  const hiddenBooks = new Set(), opened = new Set(); let local = null, depth = 1, kind = null, found = new Set();
  // the legend filters by kind: tap "mental model" to see only the models (with their books), tap again for everything
  const KINDS = { chapter: n => n.type === "chapter", lesson: n => n.type === "lesson", model: n => n.type === "model", shared: n => n.type === "model" && n.shared, across: n => n.type === "across" };
  const open_ = n => !BIG || n.type === "book" || n.type === "across" || (n.type === "model" && n.shared) || opened.has(n.book || n.home) || found.has(n.book || n.home);
  // a link is drawn when both ends are; a book-to-model shortcut only when the chapters between them are not
  const shown = l => visible.has(l.s.id) && visible.has(l.t.id) && (!l.agg || !!kind || (l.t.type === "model" && ![...(nb[l.t.id] || [])].some(c => byId[c].book === l.s.book && visible.has(c))));
  if (BIG) visible = new Set(nodes.filter(n => open_(n)).map(n => n.id));
  for (const l of links) l.on = shown(l);
  relive();
  for (let i = 0; i < 260; i++) tick();  // open nearly settled, still alive

  // --- drawing
  const svg = mk("svg", { role: "img", "aria-label": "Graph of your books and ideas" }), world = mk("g"), hullG = mk("g", { class: "hulls" }), edgeG = mk("g"), nodeG = mk("g"), labelG = mk("g");
  world.append(hullG, edgeG, nodeG, labelG); svg.append(world);  // labels on a layer above every dot, so no dot covers a word
  // a soft region behind each book's ideas, labelled with the book: the map's countries
  const hulls = books.map(b => { const c = mk("circle", { class: "hull", style: `fill:${color[b.book]};stroke:${color[b.book]}` }); hullG.append(c); return { book: b.book, c }; });
  for (const l of links) { l.el = mk("line", { class: `edge ${l.t.type === "model" || l.s.type === "model" ? "e-model" : ""}${l.agg ? " e-agg" : ""}` }); edgeG.append(l.el); }
  for (const n of [...nodes].sort((a, b) => RADIUS[a.type] - RADIUS[b.type])) {
    n.el = mk("g", { class: `node n-${n.type}${n.shared ? " shared" : ""}`, "data-id": n.id, tabindex: 0, "aria-label": `${KIND[n.type]}: ${n.label}` });
    n.c = mk("circle", { r: n.r, style: `fill:${n.fill}` }); n.el.append(n.c);
    n.t = mk("text", { x: 0, y: n.r + 13, "text-anchor": "middle" }); n.t.textContent = n.short;
    n.lg = mk("g", { class: "node-label" }); n.lg.append(n.t); labelG.append(n.lg);
    nodeG.append(n.el);
  }
  function draw() {
    for (const h of hulls) {
      const ms = (members[h.book] || []).filter(n => visible.has(n.id));
      if (!ms.length || hiddenBooks.has(h.book) || kind) { h.c.style.display = "none"; continue; }
      const cx = ms.reduce((a, n) => a + n.x, 0) / ms.length, cy = ms.reduce((a, n) => a + n.y, 0) / ms.length;
      const ds = ms.map(n => Math.hypot(n.x - cx, n.y - cy) + n.r).sort((a, b) => a - b), r = ds[Math.floor((ds.length - 1) * .85)] + 16;  // the core, not the stragglers
      h.c.style.display = ""; h.c.setAttribute("cx", cx.toFixed(1)); h.c.setAttribute("cy", cy.toFixed(1)); h.c.setAttribute("r", r.toFixed(1));
    }
    for (const l of live.links) { l.el.setAttribute("x1", l.s.x.toFixed(1)); l.el.setAttribute("y1", l.s.y.toFixed(1)); l.el.setAttribute("x2", l.t.x.toFixed(1)); l.el.setAttribute("y2", l.t.y.toFixed(1)); }
    for (const n of live.nodes) { const t = `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`; n.el.setAttribute("transform", t); n.lg.setAttribute("transform", t); }
  }
  // Labels never pile up: the most important ones are placed first and any label that would overlap one already
  // placed waits until you zoom in (greedy label placement, as in map making). The density control sets which kinds compete.
  const PRIORITY = { book: 0, across: 1, model: 2, lesson: 3, chapter: 4 };
  const hits = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  // the controls floating over the map (search, book chips, label density, zoom, legend, side panel) count as placed labels
  const controls = () => [...wrap.querySelectorAll(".graph-tools > *, .zoom, .legend, .sheet")].map(e => e.getBoundingClientRect())
    .filter(r => r.width && r.height).map(r => [r.left, r.top, r.right, r.bottom]);
  function declutter() {
    const mode = wrap.dataset.labels, k = view.k, ctl = controls(), kept = [], S = svg.getBoundingClientRect();
    const allowed = n => n.type === "book" || n.type === "across" || (n.type === "model" && n.shared) || mode === "all" ||
      (n.type !== "chapter" && (mode === "more" || k > 1.6)) || (n.type === "chapter" && k > 3);
    const forced = n => n.el.classList.contains("focus") || n.el.classList.contains("match");  // what you pointed at or searched for wins
    const order = nodes.filter(n => visible.has(n.id)).sort((a, b) => forced(b) - forced(a) || PRIORITY[a.type] - PRIORITY[b.type] + (a.type === "model" ? (b.shared ? 1 : 0) - (a.shared ? 1 : 0) : 0) || b.deg - a.deg);
    for (const n of order) {
      let on = allowed(n) || forced(n);
      if (on) {  // the label's real box on screen (font, phone size and zoom included), with room for its halo
        const r = n.t.getBoundingClientRect(), box = [r.left - 4, r.top - 2, r.right + 4, r.bottom + 2];
        on = !ctl.some(b => hits(box, b)) && (forced(n) || (r.left >= S.left && r.right <= S.right && r.top >= S.top && r.bottom <= S.bottom && !kept.some(b => hits(box, b))));
        if (on) kept.push(box);
      }
      n.el.classList.toggle("lab", on);
    }
    for (const n of nodes) if (visible.has(n.id)) n.lg.setAttribute("class", n.el.getAttribute("class").replace(/^node\b/, "node-label"));
  }
  let running = false, frames = 0, refit = false;
  function loop() { if (!wrap.isConnected) return; tick(); draw(); if (++frames % 8 === 0) declutter(); if (alpha > 0.004 || alphaTarget) requestAnimationFrame(loop); else { running = false; if (refit) { refit = false; fit(); } declutter(); } }
  function reheat(a = 0.3) { alpha = Math.max(alpha, a); if (!running) { running = true; requestAnimationFrame(loop); } }

  // --- view: pan and zoom (wheel, buttons, pinch). Labels keep their size on screen and fade in past a zoom level.
  const view = { k: 1, x: 0, y: 0 };
  const size = n => { const r = n.r * Math.min(1.6, Math.pow(view.k, -0.55)); n.c.setAttribute("r", r.toFixed(2)); n.t.setAttribute("y", (r + 13 / view.k).toFixed(2)); };
  // placing labels measures every shown label on screen; while zooming that runs once the wheel or pinch pauses, not per event
  let declutterT = 0; const soon = () => { clearTimeout(declutterT); declutterT = setTimeout(() => declutter(), 90); };
  function setView() {
    world.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
    labelG.style.fontSize = `${12 / view.k}px`; labelG.style.setProperty("--sw", `${3 / view.k}px`);
    // zooming in spreads nodes apart faster than it grows them (size: radius times k^-0.55)
    for (const n of nodes) if (visible.has(n.id)) size(n);
    wrap.classList.toggle("zoomed", view.k > 1.35); soon();
    wrap.classList.toggle("far", view.k < 0.55);
  }
  function fit(pad = 50) {
    const vs = nodes.filter(n => visible.has(n.id)); if (!vs.length) return;
    const sheet = !wrap.classList.contains("phone") && $(".sheet", wrap), W = svg.clientWidth - (sheet ? 390 : 0), H = svg.clientHeight - (wrap.classList.contains("phone") ? 60 : 30), top = wrap.classList.contains("phone") ? 110 : 70;
    const x0 = Math.min(...vs.map(n => n.x - n.r)), x1 = Math.max(...vs.map(n => n.x + n.r)), y0 = Math.min(...vs.map(n => n.y - n.r)), y1 = Math.max(...vs.map(n => n.y + n.r + 16));
    view.k = Math.min(2.4, (W - pad * 2) / (x1 - x0 || 1), (H - top - pad) / (y1 - y0 || 1));
    view.x = W / 2 - (x0 + x1) / 2 * view.k; view.y = top + (H - top) / 2 - (y0 + y1) / 2 * view.k + (wrap.classList.contains("phone") ? -10 : 0);
    setView();
  }
  const toWorld = (cx, cy) => { const r = svg.getBoundingClientRect(); return [(cx - r.left - view.x) / view.k, (cy - r.top - view.y) / view.k]; };
  function zoomAt(f, cx, cy) {
    const r = svg.getBoundingClientRect(), px = cx - r.left, py = cy - r.top, k = Math.max(0.15, Math.min(6, view.k * f));
    view.x = px - (px - view.x) * k / view.k; view.y = py - (py - view.y) * k / view.k; view.k = k; setView();
  }
  svg.addEventListener("wheel", e => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY); }, { passive: false });
  const pts = new Map(); let gesture = null;
  svg.addEventListener("pointerdown", e => {
    svg.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const nodeEl = e.target.closest(".node"), n = nodeEl && byId[nodeEl.dataset.id];
    if (pts.size === 2) { const [a, b] = [...pts.values()]; gesture = { pinch: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; return; }
    gesture = n ? { node: n, x0: e.clientX, y0: e.clientY, moved: false } : { pan: true, x0: e.clientX, y0: e.clientY, vx: view.x, vy: view.y, moved: false };
  });
  svg.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) { const n = e.target.closest?.(".node"); hover(n ? n.dataset.id : null); return; }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    if (gesture.pinch) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); zoomAt(gesture.k * d / gesture.pinch / view.k, gesture.mx, gesture.my); return; }
    if (Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 4) gesture.moved = true;
    if (!gesture.moved) return;
    if (gesture.node) {
      const [wx, wy] = toWorld(e.clientX, e.clientY), n = gesture.node;
      n.fx = wx; n.fy = wy; alphaTarget = 0.25; reheat(); hover(n.id);
    } else { view.x = gesture.vx + e.clientX - gesture.x0; view.y = gesture.vy + e.clientY - gesture.y0; setView(); }
  });
  function release(e) {
    pts.delete(e.pointerId);
    if (!gesture || pts.size) return;
    const gs = gesture; gesture = null;
    if (gs.node) { gs.node.fx = gs.node.fy = null; alphaTarget = 0; if (!gs.moved) openSheet(gs.node); else reheat(0.1); }
    else if (gs.pan && !gs.moved) { closeSheet(); }
  }
  svg.addEventListener("pointerup", release); svg.addEventListener("pointercancel", release);
  svg.addEventListener("pointerleave", () => { if (!gesture) hover(null); });
  svg.addEventListener("keydown", e => { const n = byId[e.target.closest?.(".node")?.dataset.id]; if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openSheet(n); } });

  // --- highlight: hovered node, its neighbours and their links
  let pinned = null, query = "";
  function hover(id) {
    const focus = id || pinned, keep = focus ? new Set([focus, ...(nb[focus] || [])]) : null;
    if (!focus && !hover.was) return; hover.was = !!focus;  // nothing lit before or now: nothing to change
    for (const n of nodes) { if (!visible.has(n.id)) continue; n.el.classList.toggle("dim", !!keep && !keep.has(n.id)); n.el.classList.toggle("lit", !!keep && keep.has(n.id)); n.el.classList.toggle("focus", n.id === focus); }
    for (const l of links) { if (!l.on) continue; const on = !!focus && (l.s.id === focus || l.t.id === focus); l.el.classList.toggle("dim", !!keep && !on); l.el.classList.toggle("lit", on); }
    declutter();
  }
  // --- filters: books on or off, search, local graph
  function applyFilter() {
    let ids = nodes.filter(n => !(n.book && hiddenBooks.has(n.book)) && !(n.home && hiddenBooks.has(n.home)) && (kind ? n.type === "book" || KINDS[kind](n) : open_(n))).map(n => n.id);
    let set = new Set(ids);
    // a mental model or cross-book lesson stays only while something it links to is shown
    if (!kind) for (const n of nodes) if ((n.type === "model" || n.type === "across") && ![...(nb[n.id] || [])].some(x => set.has(x) && !["model", "across"].includes(byId[x].type)) && !(n.type === "model" && open_(n) && BIG)) set.delete(n.id);
    if (local) {
      let ring = new Set([local]), seen = new Set([local]);
      for (let d = 0; d < depth; d++) { const nx = new Set(); for (const id of ring) for (const m of nb[id] || []) if (set.has(m) && !seen.has(m)) { seen.add(m); nx.add(m); } ring = nx; }
      set = seen;
    }
    visible = set;
    // what is hidden leaves the page (not display:none): with thousands of ideas, the browser restyles only what is shown
    for (const n of nodes) { const was = n.el.isConnected, now = set.has(n.id);
      if (now && !was) { size(n); n.el.classList.remove("dim", "lit", "focus"); nodeG.append(n.el); labelG.append(n.lg); }
      if (!now && was) { n.el.remove(); n.lg.remove(); } }
    for (const l of links) { const was = l.on && l.el.isConnected; l.on = shown(l); if (l.on && !was) edgeG.append(l.el); if (!l.on && l.el.isConnected) l.el.remove(); }
    relive();
    for (const b of legend.children) { const on = b.dataset.kind === kind; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
    wrap.classList.toggle("filtered", !!kind);
    const q = norm(query);
    for (const n of nodes) n.el.classList.toggle("match", !!q && norm(n.label).includes(q));
    declutter();
    wrap.classList.toggle("searching", !!q); wrap.classList.toggle("local", !!local);
    localBar.hidden = !local;
    if (local) localName.textContent = byId[local].short;
  }
  const search = el("input", { type: "search", placeholder: "Search ideas", "aria-label": "Search ideas",
    on: { input: e => { query = e.target.value;
      if (BIG) { const q = norm(query); found = new Set(q.length < 3 ? [] : nodes.filter(n => n.type !== "book" && norm(n.label).includes(q)).map(n => n.book || n.home).filter(Boolean).slice(0, 6)); }
      applyFilter(); if (BIG) reheat(0.3); const m = nodes.filter(n => visible.has(n.id) && n.el.classList.contains("match")); if (m.length === 1) { pinned = m[0].id; hover(null); } else if (!query) { pinned = null; hover(null); } } } });
  const chips = el("div", { class: "chips", hidden: BIG }, (BIG ? [] : books).map(b => el("button", { class: "chip on", "aria-pressed": "true", title: b.label,
    on: { click: e => { const c = e.currentTarget; hiddenBooks.has(b.book) ? hiddenBooks.delete(b.book) : hiddenBooks.add(b.book);
      const on = !hiddenBooks.has(b.book); c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on)); applyFilter(); reheat(0.5); fit(); } } },
    el("i", { style: `background:${color[b.book]}` }), el("span", {}, brief(b.label)))));
  const localName = el("strong"), localBar = el("div", { class: "localbar", hidden: true }, el("span", {}, "Near ", localName),
    el("div", { class: "seg small-seg" }, [1, 2].map(d => el("button", { class: d === depth ? "on" : null, on: { click: e => { depth = d; for (const b of e.target.parentNode.children) b.classList.toggle("on", b === e.target); applyFilter(); reheat(0.6); setTimeout(fit, 450); } } }, d === 1 ? "Links" : "2 steps"))),
    el("button", { class: "chip", on: { click: () => { local = null; applyFilter(); reheat(0.4); setTimeout(fit, 450); } } }, "Show all"));
  const labelsSeg = el("div", { class: "seg small-seg labels-seg", role: "radiogroup", "aria-label": "Labels" }, [["few", "Few labels"], ["more", "More"], ["all", "All"]].map(([v, t]) =>
    el("button", { role: "radio", class: v === (localStorage.graphLabels || "few") ? "on" : null, on: { click: e => { localStorage.graphLabels = v; wrap.dataset.labels = v; declutter(); for (const b of e.currentTarget.parentNode.children) b.classList.toggle("on", b === e.currentTarget); } } }, t)));
  wrap.dataset.labels = localStorage.graphLabels || "few";
  const legend = el("div", { class: "legend", role: "group", "aria-label": "Show only one kind" }, [["chapter", "chapters"], ["lesson", "key lessons"], ["model", "mental models"], ["shared", "shared models"], ["across", "across books"]].map(([k, t]) =>
    el("button", { "data-kind": k, "aria-pressed": "false", title: `Show only ${t} (tap again for all)`, on: { click: () => { kind = kind === k ? null : k; local = null; applyFilter(); reheat(0.6); refit = true; setTimeout(fit, 500); } } },
      el("i", { class: `lg-${k}` }), t)));
  wrap.append(svg, el("div", { class: "graph-tools" }, search, chips, labelsSeg, localBar), legend,
    el("div", { class: "zoom" }, el("button", { "aria-label": "Zoom in", on: { click: () => zoomAt(1.4, svg.getBoundingClientRect().left + svg.clientWidth / 2, svg.getBoundingClientRect().top + svg.clientHeight / 2) } }, "+"),
      el("button", { "aria-label": "Zoom out", on: { click: () => zoomAt(1 / 1.4, svg.getBoundingClientRect().left + svg.clientWidth / 2, svg.getBoundingClientRect().top + svg.clientHeight / 2) } }, "−"),
      el("button", { "aria-label": "Fit to screen", class: "fit", on: { click: () => fit() } }, "⤢")));
  wrap.classList.toggle("phone", innerWidth < 640);
  applyFilter(); draw(); fit(); reheat(0.12);
  // for tests and screenshots: how many shown labels overlap another label or a control on screen (should always be 0)
  const overlaps = () => { const bs = nodes.filter(n => visible.has(n.id) && getComputedStyle(n.t).opacity > 0.5).map(n => { const r = n.t.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
    let c = 0; bs.forEach((a, i) => { for (const b of [...bs.slice(i + 1), ...controls()]) c += hits(a, b); }); return c; };
  window.graphView = { nodes, view, get alpha() { return alpha; }, fit, overlaps };

  function closeSheet() { $(".sheet", wrap)?.remove(); pinned = null; hover(null); }
  function openSheet(n) {
    $(".sheet", wrap)?.remove(); pinned = n.id; hover(null);
    const s = el("aside", { class: "sheet" }, el("button", { class: "x", "aria-label": "Close", on: { click: closeSheet } }, "×"),
      el("p", { class: "kicker" }, n.type === "model" && n.shared ? "Mental model shared by books" : KIND[n.type]));
    const open = (href, label) => el("a", { class: "btn", href, "data-link": true }, label);
    if (n.type === "book") s.append(el("h2", {}, n.label), n.authors?.length ? el("p", { class: "muted" }, authors(n.authors)) : null,
      el("p", { class: "small muted" }, `${[...nb[n.id]].filter(x => byId[x].type === "chapter").length} chapters`), el("div", { class: "actions" }, open(`/book/${n.book}`, "Open the book"),
        BIG ? el("button", { class: "btn ghost", on: { click: e => { opened.has(n.book) ? opened.delete(n.book) : opened.add(n.book); e.target.textContent = opened.has(n.book) ? "Hide its ideas" : "Show its ideas"; applyFilter(); reheat(0.5); } } }, opened.has(n.book) ? "Hide its ideas" : "Show its ideas") : null));
    if (n.type === "chapter") s.append(el("h2", {}, titleParts(n.label)[1]), n.lesson ? el("p", { class: "core-mini" }, n.lesson) : null,
      el("p", { class: "small muted" }, short(n.book_title)),
      el("div", { class: "actions" }, open(`/book/${n.book}/${n.index}`, "Open the card"), el("a", { class: "btn ghost", href: `/book/${n.book}/${n.index}?tab=read`, "data-link": true }, "Read")));
    if (n.type === "lesson") s.append(el("h2", {}, n.label), el("p", { class: "muted" }, n.why),
      el("p", { class: "small" }, "From ", el("a", { href: `/book/${n.book}`, "data-link": true }, short(n.book_title)),
        ...(n.sources.length ? [": ", ...n.sources.flatMap((c, k) => [k ? ", " : "", el("a", { href: `/book/${n.book}/${c.index}`, "data-link": true }, tc(c.title))])] : [])));
    if (n.type === "across") s.append(el("h2", {}, n.label), el("p", { class: "muted" }, n.why),
      el("p", { class: "small" }, "From ", ...n.books.flatMap((b, k) => [k ? " and " : "", el("a", { href: `/book/${b.id}`, "data-link": true }, short(b.title))])));
    if (n.type === "model") s.append(el("h2", {}, n.label),
      el("ul", {}, n.ideas.map(i => el("li", {}, el("strong", {}, i.title), el("div", { class: "muted small" }, i.how),
        el("div", { class: "small" }, el("a", { href: `/book/${i.book}/${i.chapter_index}`, "data-link": true }, `${short(i.book_title)}, ${tc(i.chapter)}`))))));
    s.append(el("button", { class: "btn ghost local-btn", on: { click: () => { local = n.id; applyFilter(); reheat(0.6); setTimeout(() => fit(80), 500); } } }, "Local graph"));
    // In the books: the passages behind this idea, each one tap from its place in the text
    if (n.type !== "book") {
      const ev = el("div", { class: "evidence" }, el("p", { class: "kicker" }, "In the books"), el("p", { class: "muted small caret" }, "Finding the passages"));
      s.append(ev);
      api(`/api/graph/node?id=${encodeURIComponent(n.id)}`).then(r => {
        ev.querySelector(".caret")?.remove();
        if (!r.passages.length) return ev.remove();
        ev.append(...r.passages.map(x => el("blockquote", { class: "passage" }, el("p", {}, x.text),
          el("a", { href: `/book/${x.book}/${x.chapter}?tab=read&at=${x.block}`, "data-link": true }, `${short(x.book_title)} · ${tc(x.chapter_title)} · read it`))));
      }).catch(() => ev.remove());
    }
    const rel = [...(nb[n.id] || [])].map(x => byId[x]).filter(m => m.type !== "book" && visible.has(m.id)).sort((a, b) => b.deg - a.deg).slice(0, 8);
    if (rel.length) s.append(el("p", { class: "kicker" }, "Connected ideas"), el("div", { class: "related" }, rel.map(m =>
      el("button", { class: "chip on", on: { click: () => { openSheet(m); } } }, el("i", { style: `background:${m.fill}` }), el("span", {}, m.short)))));
    wrap.append(s);
    declutter();
  }
}

// ---- Narration: the chapter read aloud by a good local voice, following the text ----------------
// One <audio> element plays passage after passage (a paragraph, or a few sentences of a long one), so playback goes on
// with the screen off, and the lock screen shows play, pause and skip (Media Session). The passage being read is
// highlighted; tap any paragraph to jump there. Without the local narrator, the device's own voice reads instead.
const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z"/>', pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  prev: '<path d="M6 6h2v12H6zM20 6v12L9.5 12z"/>', next: '<path d="M16 6h2v12h-2zM4 6l10.5 6L4 18z"/>',
  back: '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle" font-family="sans-serif" font-weight="700">15</text>',
  fwd: '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle" font-family="sans-serif" font-weight="700">15</text>',
  moon: '<path d="M14.5 3.5a8.5 8.5 0 1 0 6 13.9A7 7 0 0 1 14.5 3.5z"/>',
};
const icon = n => { const sp = el("span", { class: "ico", "aria-hidden": "true" }); sp.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">${ICONS[n]}</svg>`; return sp; };
const Narrator = (() => {
  const audio = new Audio(); audio.preload = "auto";
  const pref = Object.assign({ voice: "", rate: 1, recap: false, bookRates: {} }, (() => { try { return JSON.parse(localStorage.narration || "{}"); } catch { return {}; } })());
  const save = () => { localStorage.narration = JSON.stringify(pref); };
  // Speed: any value from 0.5x to 3x in steps of 0.05, changed live; per book when asked, else for every book
  const MIN_RATE = 0.5, MAX_RATE = 3, PRESETS = [1, 1.25, 1.5, 2];
  const clampRate = v => Math.round(Math.max(MIN_RATE, Math.min(MAX_RATE, +v || 1)) * 20) / 20;
  const rate = () => clampRate(book && pref.bookRates[book.id] || pref.rate);
  const fmt = v => `${+v.toFixed(2)}×`;
  audio.preservesPitch = true;
  function setRate(v, opts = {}) {
    v = clampRate(v);
    if (book && (opts.perBook ?? pref.bookRates[book.id] !== undefined)) pref.bookRates[book.id] = v; else pref.rate = v;
    if (opts.perBook === false && book) delete pref.bookRates[book.id];
    audio.playbackRate = v; save(); paint(); position();
    if (device && on && !opts.typing) { clearTimeout(setRate.t); setRate.t = setTimeout(() => on && play(), 350); }  // the device voice takes a new speed per sentence
    Sync.op(null, "reader", readerOp());
  }
  let sleepAt = 0, sleepEnd = false, sleepTimer = null;  // a timer, or "at the end of this chapter"
  function setSleep(min) {
    clearTimeout(sleepTimer); sleepAt = 0; sleepEnd = min === "end";
    if (typeof min === "number" && min > 0) { sleepAt = Date.now() + min * 60000; sleepTimer = setTimeout(() => { sleepAt = 0; fadeOut(); }, min * 60000); }
    paint();
  }
  function fadeOut() {  // a few seconds of fade rather than a cut, like falling asleep to a radio
    if (device) return pause();
    const v0 = audio.volume; let n = 0;
    const t = setInterval(() => { n++; audio.volume = Math.max(0, v0 * (1 - n / 20)); if (n >= 20) { clearInterval(t); pause(); audio.volume = v0; } }, 150);
  }
  const REWIND = 15;  // seconds of listening replayed after a break, back to the start of a sentence
  let voices = null, book = null, ch = null, next = null, segs = [], k = 0, on = false, bar = null, device = false, autoNext = false;
  let stopped = null;  // {k, pos, at}: where and when listening stopped, for the rewind on resume
  const hl = window.CSS?.highlights && typeof Highlight === "function";
  api("/api/voices").then(v => { voices = v; if (!voices.find(x => x.id === pref.voice)) pref.voice = ""; $(".listen-row .muted") && ($(".listen-row .muted").textContent = voiceLabel()); }).catch(() => { voices = []; });
  function voiceFor(b) {
    if (!voices?.length) return null;
    const lang = (b?.language || "en").slice(0, 2).toLowerCase();
    return voices.find(v => v.id === pref.voice && v.lang === lang) || voices.find(v => v.lang === lang) || voices.find(v => v.id === pref.voice) || voices[0];
  }
  function voiceLabel() { const v = voiceFor(S.book); return v ? `${v.label} voice` : voices ? "Device voice" : ""; }
  // What a narrator should say: no footnote marks, page numbers, stray symbols or shouting capitals
  const speakable = t => {
    t = t.replace(/\[(\d{1,3}|[a-z*†‡])\]/gi, "").replace(/[\u00B9\u00B2\u00B3\u2070-\u2079]+/g, "").replace(/(\w)[*†‡]+(?=\W|$)/g, "$1")
      .replace(/https?:\/\/\S+/g, "a link").replace(/\s+/g, " ").trim();
    if (t.length > 3 && !/\p{Ll}/u.test(t)) t = t.toLowerCase().replace(/(^|[.!?:]\s+)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    return t;
  };
  // Passages are sentences (short ones joined up to about 220 characters), so the first sound comes fast and the
  // highlight follows the sentence being read. Figures are announced by their caption, never skipped in silence.
  function passages(prose) {
    const seg = window.Intl?.Segmenter ? new Intl.Segmenter(book?.language || "en", { granularity: "sentence" }) : null;
    const out = [];
    const c = book.chapters.find(x => x.index === ch), [num, name] = titleParts(c?.title || "");
    out.push({ node: $("main > h1"), s: 0, e: 0, text: num ? `${num}. ${name}.` : `${name}.`, title: true });
    for (const node of prose.querySelectorAll("[data-say], figure.book-fig")) {
      if (node.matches("figure")) {
        const cap = node.querySelector("figcaption")?.textContent.trim(), alt = node.querySelector("img")?.alt?.trim();
        if (node.classList.contains("ornament")) continue;
        const say = cap ? (/^(figure|fig\.|plate|table|illustration|diagram|chart|map)\b/i.test(cap) ? cap : `Figure: ${cap}`) : alt && alt.length > 3 && !/[\/\\]|\.(png|jpe?g|gif|svg)$/i.test(alt) ? `Figure: ${alt}` : "";
        if (say) out.push({ node, s: 0, e: 0, text: speakable(say), figure: true });
        continue;
      }
      if (node.closest("figure")) continue;  // captions are read with their figure
      const t = node.textContent; if (!t.trim() || /^\s*[\divxlc]{1,5}\.?\s*$/i.test(t)) continue;  // bare page or section numbers
      const sents = seg ? [...seg.segment(t)].map(x => [x.index, x.index + x.segment.length]) : [[0, t.length]];
      let a = null, z = 0;
      for (const [s0, s1] of sents) {
        if (a === null) a = s0;
        z = s1;
        if (z - a >= 60 || /^h/i.test(node.tagName)) { out.push({ node, s: a, e: z }); a = null; }
      }
      if (a !== null) { const prev = out.at(-1); if (prev?.node === node && z - prev.s < 220) prev.e = z; else out.push({ node, s: a, e: z }); }
    }
    // long sentences are cut at a comma, semicolon or dash (into pieces of 50 to 170 characters), so no piece makes
    // the listener wait while it is spoken into being
    for (let j = 0; j < out.length; j++) {
      const x = out[j]; if (x.text !== undefined || x.e - x.s <= 170) continue;
      const t = x.node.textContent.slice(x.s, x.e), cuts = [...t.matchAll(/[,;:\u2014–)] /g)].map(m => m.index + 2);
      const cut = cuts.filter(c => c >= 50 && t.length - c >= 50).sort((a, b) => Math.abs(a - Math.min(150, t.length / 2)) - Math.abs(b - Math.min(150, t.length / 2)))[0];
      if (cut) out.splice(j, 1, { node: x.node, s: x.s, e: x.s + cut }, { node: x.node, s: x.s + cut, e: x.e });
      if (cut) j--;
    }
    for (const x of out) if (x.text === undefined) x.text = speakable(x.node.textContent.slice(x.s, x.e));
    return out.filter(x => x.text && /[\p{L}\p{N}]/u.test(x.text));
  }
  const url = (x, b = book) => `/api/tts?voice=${encodeURIComponent(voiceFor(b).id)}&text=${encodeURIComponent(x.text)}`;
  // First sound fast: speech is made at about twice real time, so a cold start speaks a short lead (a clause of up to 42
  // characters, ready in about a second on a home server) while the rest of the sentence is made. Later passages are made one at
  // a time ahead of the voice; making several at once only slows the one being waited for.
  const warm = new Set();
  const prepare = u => warm.has(u) ? Promise.resolve() : fetch(u).then(r => r.ok && r.blob()).then(() => warm.add(u)).catch(() => {});
  async function prefetch(from, n) { for (const y of segs.slice(from, from + n)) { if (!on) return; await prepare(url(y)); } }
  function lead(j) {
    const x = segs[j]; if (!x || x.title || x.figure || x.text.length <= 70 || warm.has(url(x))) return;
    const t = x.node.textContent.slice(x.s, x.e);
    const marks = [...t.matchAll(/[,;:\u2014–)] |\s/g)].map(m => m.index + m[0].length).filter(c => c >= 16 && c <= 42 && t.length - c >= 25);
    const cut = marks.filter(c => /[,;:\u2014–)] $/.test(t.slice(0, c))).at(-1) || marks.at(-1); if (!cut) return;
    segs.splice(j, 1, { node: x.node, s: x.s, e: x.s + cut, text: speakable(t.slice(0, cut)) }, { node: x.node, s: x.s + cut, e: x.e, text: speakable(t.slice(cut)) });
  }
  function mark() {
    document.querySelectorAll(".saying").forEach(n => n.classList.remove("saying"));
    if (hl) CSS.highlights.delete("saying");
    const x = segs[k]; if (!x || !x.node?.isConnected) return;
    x.node.classList.add("saying");
    if (hl && !x.figure && !x.title) { const a = pointAt(x.node, x.s), z = pointAt(x.node, x.e); if (a && z) { const r = new Range(); r.setStart(...a); r.setEnd(...z); CSS.highlights.set("saying", new Highlight(r)); } }
    const top = x.figure || x.title ? x.node.getBoundingClientRect().top : lineTop(x.node, x.s);
    if (top < 80 || top > innerHeight - 160) scrollTo({ top: scrollY + top - innerHeight * .3, behavior: "smooth" });
  }
  function pin() {  // the reading pin follows the voice, so Continue reading lands on the sentence last heard
    const x = segs[k]; if (!x?.node || x.figure || x.title || !book) return;
    Sync.op(book.id, "pos", { chapter: ch, block: +x.node.dataset.i, offset: x.s, quote: x.node.textContent.slice(x.s, x.s + 48), y: Math.round(innerHeight * .3), percent: Math.round(k / Math.max(1, segs.length) * 100), listening: true });
    localStorage.listened = JSON.stringify({ book: book.id, ch, k, at: Date.now() });
  }
  function play(extra) {
    let x = extra || segs[k]; if (!x) return finish();
    on = true; if (!extra) { mark(); pin(); } paint();
    if (device) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(x.text); u.rate = rate(); u.lang = book?.language || "en";
      u.onend = () => { if (on && (extra || segs[k] === x)) { if (!extra) k++; play(); } };
      speechSynthesis.speak(u); return;
    }
    audio.dataset.extra = extra ? "1" : "";
    if (!extra && segs[k] === x) { lead(k); x = segs[k]; }
    audio.src = url(x); audio.playbackRate = rate(); audio.preservesPitch = true; warm.add(audio.src.replace(location.origin, ""));
    audio.play().catch(e => { if (e.name !== "AbortError") status("Could not play: " + e.message); });
    if (!extra) { const from = k + 1; audio.addEventListener("playing", () => prefetch(from, 3), { once: true }); }  // made while this one plays
    meta();
  }
  function finish() {
    on = false; paint();
    if (sleepEnd) { sleepEnd = false; paint(); return status("Sleep timer: stopped at the end of the chapter."); }
    if (next && $(".prose") && location.pathname === `/book/${book.id}/${ch}`) { autoNext = true; go(`/book/${book.id}/${next.index}?tab=read`); }
  }
  audio.addEventListener("ended", () => { if (!on) return; if (audio.dataset.extra) return play(); segs[k] && (segs[k].dur = audio.duration); k++; play(); });
  audio.addEventListener("loadedmetadata", () => { if (!audio.dataset.extra && segs[k]) segs[k].dur = audio.duration; });
  audio.addEventListener("error", () => { if (on && audio.src) status("The narrator is not answering. Try again in a moment."); });
  audio.addEventListener("pause", () => paint()); audio.addEventListener("playing", () => paint());
  audio.addEventListener("loadstart", () => { if (on) status("Preparing the voice…"); });
  function pause() {
    if (on) stopped = { k, pos: device ? 0 : audio.currentTime, at: Date.now() };
    on = false; if (device) speechSynthesis.cancel(); else audio.pause(); paint();
    if (stopped && !device) { const r = rewindFrom(stopped.k, stopped.pos, 1e9); prepare(url(segs[r.k] || segs[k])); }  // a resume after a break starts here, already made
  }
  // Coming back after a break: replay up to 15 s of listening, from the start of a sentence, so the thread is not lost.
  // A pause of a few seconds resumes exactly where it stopped.
  function rewindFrom(at, pos, gap) {
    if (gap < 8000) return { k: at, exact: true };
    const est = x => x.dur || x.text.length / 15;  // seconds of audio, measured once played
    let back = Math.min(REWIND * rate(), pos), j = at;
    let budget = REWIND * rate() - pos;
    while (j > 0 && budget >= est(segs[j - 1]) && !segs[j - 1].title) { budget -= est(segs[j - 1]); j--; }
    return { k: j, exact: false, back };
  }
  async function resume() {
    if (!stopped || device || !audio.src || audio.ended) { if (stopped) { const r = rewindFrom(stopped.k, stopped.pos, Date.now() - stopped.at); k = r.k; } stopped = null; return play(); }
    const gap = Date.now() - stopped.at, r = rewindFrom(stopped.k, stopped.pos, gap); stopped = null;
    if (r.exact) { on = true; audio.play(); return paint(); }
    k = r.k;
    if (pref.recap && gap > 30 * 60000) return recapThenPlay();
    play();
  }
  async function recapThenPlay() {
    status("Recalling where you were…");
    const x = segs[k];
    try {
      const r = await api("/api/recap", { method: "POST", body: JSON.stringify({ book: book.id, chapter: ch, block: x?.node ? +x.node.dataset.i : 0 }) });
      if (r.recap) return play({ text: r.recap });
    } catch {}
    play();
  }
  function jump(d) { k = Math.max(0, Math.min(segs.length - 1, k + d)); stopped = null; play(); }
  function back15() { const r = rewindFrom(k, device ? 0 : audio.currentTime, 1e9); k = r.k; stopped = null; play(); }
  function forward15() {  // skip about 15 s of listening, landing on a sentence start
    const est = x => x.dur || x.text.length / 15;
    let budget = REWIND * rate() - (est(segs[k] || { text: "" }) - (device ? 0 : audio.currentTime)), j = k + 1;
    while (j < segs.length - 1 && budget > est(segs[j]) / 2) { budget -= est(segs[j]); j++; }
    k = Math.min(j, segs.length - 1); stopped = null; play();
  }
  function position() {  // lock screen: speed and where in the chapter, counted in sentences of about 4 s
    try { navigator.mediaSession?.setPositionState?.({ duration: Math.max(1, segs.length * 4), position: Math.min(segs.length * 4, k * 4), playbackRate: rate() }); } catch {}
  }
  function meta() {
    if (!("mediaSession" in navigator)) return;
    const [num, name] = titleParts(book.chapters.find(c => c.index === ch)?.title || "");
    navigator.mediaSession.metadata = new MediaMetadata({ title: name, artist: authors(book.authors), album: short(book.title),
      artwork: book.cover ? [{ src: new URL(`/api/books/${book.id}/cover`, location.href).href }] : [] });
    navigator.mediaSession.setActionHandler("play", resume);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("previoustrack", () => jump(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => jump(1));
    try { navigator.mediaSession.setActionHandler("seekbackward", back15); navigator.mediaSession.setActionHandler("seekforward", forward15); } catch {}
    try { navigator.mediaSession.setActionHandler("stop", stop); } catch {}
    position();
  }
  function status(t) { bar && ($(".np-status", bar).textContent = t); }
  function paint() {
    if (!bar) return;
    const playing = device ? on : !audio.paused && on;
    const pp = $(".np-play", bar); pp.replaceChildren(icon(playing ? "pause" : "play")); pp.setAttribute("aria-label", playing ? "Pause" : "Play");
    $(".np-rate", bar).textContent = fmt(rate());
    const sl = $(".np-sleep", bar); sl.classList.toggle("on", !!(sleepAt || sleepEnd));
    sl.textContent = sleepEnd ? "End of ch." : sleepAt ? `${Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000))} min` : "";
    sl.prepend(icon("moon"));
    const sp = $(".speed-pop", bar); if (sp && !sp.contains(document.activeElement)) syncSpeed(sp);
    $(".np-fill", bar).style.width = segs.length ? `${(k + 1) / segs.length * 100}%` : "0";
    status(segs.length ? `${titleParts(book.chapters.find(c => c.index === ch)?.title || "")[1]} · ${Math.round((k + 1) / segs.length * 100)}%` : "");
  }
  function makeBar() {
    bar?.remove();
    const vs = voices?.filter(v => v.lang === (book.language || "en").slice(0, 2).toLowerCase()) || [];
    bar = el("div", { class: "nowplaying", role: "region", "aria-label": "Narration" },
      el("div", { class: "np-track" }, el("div", { class: "np-fill" })),
      el("div", { class: "np-row" },
        el("button", { class: "np-btn np-prev", "aria-label": "Previous sentence", title: "Previous sentence (Shift+←)", on: { click: () => jump(-1) } }, icon("prev")),
        el("button", { class: "np-btn np-back", "aria-label": "Back 15 seconds", title: "Back 15 seconds (←)", on: { click: back15 } }, icon("back")),
        el("button", { class: "np-btn np-play", "aria-label": "Pause", title: "Play or pause (Space)", on: { click: toggle } }, icon("pause")),
        el("button", { class: "np-btn np-fwd", "aria-label": "Forward 15 seconds", title: "Forward 15 seconds (→)", on: { click: forward15 } }, icon("fwd")),
        el("button", { class: "np-btn np-next", "aria-label": "Next sentence", title: "Next sentence (Shift+→)", on: { click: () => jump(1) } }, icon("next")),
        el("span", { class: "np-status" }),
        el("button", { class: "np-rate", "aria-label": "Speed", "aria-haspopup": "dialog", title: "Speed ([ slower, ] faster)", on: { click: e => { e.stopPropagation(); togglePop("speed"); } } }, "1×"),
        el("button", { class: "np-sleep", "aria-label": "Sleep timer", "aria-haspopup": "dialog", title: "Sleep timer", on: { click: e => { e.stopPropagation(); togglePop("sleep"); } } }),
        vs.length > 1 ? el("select", { class: "np-voice", "aria-label": "Voice", on: { change: e => { pref.voice = e.target.value; save(); play(); } } },
          vs.map(v => el("option", { value: v.id, selected: v.id === voiceFor(book)?.id ? true : null }, v.label))) : null,
        el("button", { class: "np-btn np-x", "aria-label": "Stop narration", on: { click: stop } }, "×")));
    document.body.append(bar); document.body.classList.add("has-player");
  }
  const toggle = () => (on ? pause() : resume());
  function syncSpeed(pop) {
    const v = rate();
    $(".sp-val", pop).value = v.toFixed(2); $(".sp-range", pop).value = v;
    $(".sp-range", pop).setAttribute("aria-valuetext", fmt(v));
    for (const b of pop.querySelectorAll(".sp-presets button")) b.classList.toggle("on", +b.dataset.v === v);
    const pb = $(".sp-book", pop); if (pb) pb.checked = book && pref.bookRates[book.id] !== undefined;
  }
  function togglePop(which) {
    const open = $(".np-pop", bar), same = open?.dataset.kind === which; open?.remove();
    if (same) return;
    let pop;
    if (which === "speed") {
      const range = el("input", { type: "range", class: "sp-range", min: MIN_RATE, max: MAX_RATE, step: 0.05, "aria-label": "Speed",
        on: { input: e => setRate(e.target.value, { typing: true }), change: e => setRate(e.target.value) } });
      const val = el("input", { class: "sp-val", type: "number", inputmode: "decimal", min: MIN_RATE, max: MAX_RATE, step: 0.05, "aria-label": "Exact speed",
        on: { change: e => setRate(e.target.value), keydown: e => { if (e.key === "Enter") { setRate(e.target.value); e.target.blur(); } } } });
      pop = el("div", { class: "np-pop speed-pop", role: "dialog", "aria-label": "Speed", "data-kind": "speed" },
        el("div", { class: "sp-top" }, el("button", { class: "sp-step", "aria-label": "Slower", on: { click: () => setRate(rate() - 0.05) } }, "−"),
          el("label", { class: "sp-read" }, val, el("span", {}, "×")),
          el("button", { class: "sp-step", "aria-label": "Faster", on: { click: () => setRate(rate() + 0.05) } }, "+")),
        range,
        el("div", { class: "sp-scale", "aria-hidden": "true" }, [0.5, 1, 1.5, 2, 2.5, 3].map(v => el("span", { style: `left:${(v - MIN_RATE) / (MAX_RATE - MIN_RATE) * 100}%` }, fmt(v)))),
        el("div", { class: "sp-presets" }, PRESETS.map(v => el("button", { "data-v": v, on: { click: () => setRate(v) } }, fmt(v)))),
        book ? el("label", { class: "check small" }, el("input", { type: "checkbox", class: "sp-book", on: { change: e => setRate(rate(), { perBook: e.target.checked }) } }), "Only for this book") : null,
        el("p", { class: "muted small" }, "Pitch stays natural at any speed.", el("span", { class: "keys-hint" }, " Keys: [ slower, ] faster, 0 normal.")));
      syncSpeed(pop);
    } else {
      const opt = (label, v) => el("button", { class: (v === "end" ? sleepEnd : v === 0 ? !sleepAt && !sleepEnd : false) ? "on" : null, on: { click: () => { setSleep(v); $(".np-pop", bar)?.remove(); toast(v === 0 ? "Sleep timer off" : v === "end" ? "Stops at the end of this chapter" : `Stops in ${v} minutes`); } } }, label);
      const mins = el("input", { type: "number", min: 1, max: 600, inputmode: "numeric", placeholder: "min", "aria-label": "Minutes", on: { keydown: e => { if (e.key === "Enter" && +e.target.value > 0) { setSleep(+e.target.value); $(".np-pop", bar)?.remove(); toast(`Stops in ${+e.target.value} minutes`); } } } });
      pop = el("div", { class: "np-pop sleep-pop", role: "dialog", "aria-label": "Sleep timer", "data-kind": "sleep" },
        el("p", { class: "lbl" }, "Stop listening"),
        el("div", { class: "sp-presets" }, opt("Off", 0), opt("10 min", 10), opt("20 min", 20), opt("30 min", 30), opt("45 min", 45), opt("1 h", 60), opt("End of chapter", "end")),
        el("label", { class: "sl-custom small" }, "After ", mins, " minutes"));
    }
    bar.append(pop); (which === "speed" ? $(".sp-range", pop) : pop.querySelector("button"))?.focus({ preventScroll: true });
  }
  document.addEventListener("click", e => { if (bar && !e.target.closest(".np-pop") && e.target.isConnected) $(".np-pop", bar)?.remove(); });
  // keys while the player is open (never while typing)
  document.addEventListener("keydown", e => {
    if (!bar || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const k = e.key, act = {
      " ": toggle, k: toggle, ArrowLeft: () => e.shiftKey ? jump(-1) : back15(), ArrowRight: () => e.shiftKey ? jump(1) : forward15(),
      j: back15, l: forward15, "[": () => setRate(rate() - 0.05), "]": () => setRate(rate() + 0.05), "{": () => setRate(rate() - 0.25), "}": () => setRate(rate() + 0.25),
      "0": () => setRate(1), Escape: () => $(".np-pop", bar)?.remove() }[k];
    if (!act || (k === " " && e.target.closest?.("button, a"))) return;
    e.preventDefault(); act();
  });
  function stop() { pause(); audio.removeAttribute("src"); bar?.remove(); bar = null; document.body.classList.remove("has-player"); document.querySelectorAll(".saying").forEach(n => n.classList.remove("saying")); if (hl) CSS.highlights.delete("saying"); }
  function start(b, i, prose, from, nxt) {
    book = b; ch = i; next = nxt; device = !voiceFor(b) && "speechSynthesis" in window;
    if (!voiceFor(b) && !device) return alert("No voice is available on this device.");
    segs = passages(prose); stopped = null;
    k = from >= 0 ? from : here();
    // starting again in a chapter listened to before: rewind from where the voice stopped (and recap after a long break)
    const last = (() => { try { return JSON.parse(localStorage.listened || "null"); } catch { return null; } })();
    if (from < 0 && last && last.book === b.id && last.ch === i && Math.abs(last.k - k) <= 3) {
      const gap = Date.now() - last.at, r = rewindFrom(Math.min(last.k, segs.length - 1), 0, gap); k = r.k;
      makeBar(); if (pref.recap && gap > 30 * 60000) return recapThenPlay();
      return play();
    }
    makeBar(); play();
  }
  // the first sentence on screen, so Listen starts where the eyes are
  const here = () => { const t = topEdge(); const j = segs.findIndex(x => x.node && !x.title && (x.figure ? x.node.getBoundingClientRect().bottom : lineTop(x.node, x.e - 1) + 4) > t); return Math.max(0, j); };
  // a Read page was drawn: rebind to it if it is the chapter being read, start it if the last chapter just ended
  function attach(b, i, prose, nxt) {
    if (book && book.id === b.id && ch === i && bar) { segs = passages(prose); mark(); paint(); }
    if (autoNext && book && book.id === b.id) { autoNext = false; start(b, i, prose, 0, nxt); }
    else if (voiceFor(b) && !bar) setTimeout(() => {  // have the sentence on screen ready before Listen is pressed
      if (!prose.isConnected || bar) return;
      const keep = [book, ch]; book = b; ch = i; const ps = passages(prose); [book, ch] = keep;
      const t = topEdge(), j = Math.max(0, ps.findIndex(y => y.node && !y.title && y.node.getBoundingClientRect().bottom > t));
      (async () => { for (const x of [ps[j], ps[0], ps[j + 1]].filter(Boolean)) await prepare(url(x, b)); })();
    }, 1200);
    prose.addEventListener("click", e => {
      const node = e.target.closest("[data-say], figure"); if (!node || !bar || book?.id !== b.id || ch !== i || e.target.closest("a,button")) return;
      const c = caretAt(e.clientX, e.clientY), off = c && node.contains(c.node) ? textOffset(node, c.node, c.offset) : 0;
      const j = segs.findIndex(x => x.node === node && off >= x.s && off <= x.e); const jj = j >= 0 ? j : segs.findIndex(x => x.node === node);
      if (jj >= 0) { k = jj; stopped = null; play(); }
    });
  }
  return { start, attach, voiceLabel, pref, save, passages: (p, b = S.book, i = +location.pathname.split("/")[3]) => { const keep = [book, ch]; book = b; ch = i; try { return passages(p); } finally { [book, ch] = keep; } },
    get state() { return { on, k, n: segs.length, device, src: audio.src, paused: audio.paused, rate: audio.playbackRate, book: book?.id, bar: !!bar, text: segs[k]?.text, stopped }; },
    setRate, setSleep, get rate() { return rate(); },
    _test: { rewindFrom, set segs(v) { segs = v; }, pause, resume, forward15 } };
})();

route();
// reading without the player: ← and → turn chapters, like a page turn on an e-reader keyboard
document.addEventListener("keydown", e => {
  if (!document.body.classList.contains("reading") || $(".nowplaying") || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey
      || e.target.closest?.("input, textarea, select, [contenteditable]") || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const a = [...document.querySelectorAll(".pager a")].find(x => x.textContent.trim()[e.key === "ArrowLeft" ? "startsWith" : "endsWith"](e.key === "ArrowLeft" ? "←" : "→"));
  if (a) { e.preventDefault(); a.click(); }
});
// "/" searches the book you are in, as in most readers and browsers
document.addEventListener("keydown", e => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const m = location.pathname.match(/^\/book\/([\w-]+)/); if (!m) return;
  e.preventDefault(); const box = $(".book-search"); if (box) return box.focus();
  go(`/book/${m[1]}?tab=chapters&search=1`);
});

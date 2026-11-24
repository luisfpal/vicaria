import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "preact/hooks";
import { pdfTextHtml } from "./pdftext";
import type { Head } from "../core/read";
import { cachedHead as loadHead, cachedSection as loadSection, lastSpot } from "./bookcache";
import type { Section, Note, Anchor } from "../core/types";
import { addOp, bookOps, anchorsMap, resolver, position as readPosition, onOp, onAnchors } from "../core/ops";
import { foldMarks, type Mark, type Color } from "../core/marks";
import { createMark, MarkError } from "../core/marks-io";
import { BgLayer, BgPicker } from "./background";
import { paintMarks, glyphsFor, markAt, canHighlight, type Glyph } from "./paint";
import { SelectionBar, MarkSheet, MarksPanel, NoteDraft } from "./marks-ui";
import { fraction } from "../core/progress";
import { go, books, markOpened, setProgress, mark, prefs, setPrefs, use, toast, BASE } from "./state";
import { imageUrl } from "./covers";
import { anchorFromRange } from "./anchors";
import { t } from "../core/i18n";
import { ErrorScreen } from "./errors";

type Spot = { section: number; block: number };
type Panel = null | "contents" | "search" | "type" | "marks" | "ask";

function readUrl(): Partial<Spot> {
  const u = new URLSearchParams(location.search);
  return u.has("s") ? { section: +u.get("s")!, block: +(u.get("b") || 0) } : {};
}
const localPos = lastSpot;

// text of a block from an offset, without the note numbers
function plainText(el: Element | null | undefined, from = 0): string {
  if (!el) return "";
  let out = "", at = 0;
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const d = n.data, inRef = !!n.parentElement?.closest("a.nref");
    if (at + d.length > from && !inRef) out += d.slice(Math.max(0, from - at));
    at += d.length; if (out.length > 200) break;
  }
  return out;
}

export function Reader({ id }: { id: string }) {
  const [h, setH] = useState<Head | null>(null);
  const [sec, setSec] = useState<Section | null>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [missing, setMissing] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  const [note, setNote] = useState<{ n: Note; x: number; y: number; below: boolean } | null>(null);
  const [back, setBack] = useState<Spot[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [glyphs, setGlyphs] = useState<Glyph[]>([]);
  const [sel, setSel] = useState<{ a: Anchor; x: number; y: number } | null>(null);
  const [edit, setEdit] = useState<{ id: string; x: number; y: number; focusNote?: boolean } | null>(null);
  const [draft, setDraft] = useState<{ a: Anchor; x: number; y: number; sticky: boolean } | null>(null);
  const [askSel, setAskSel] = useState<{ section: number; block: number; text: string } | null>(null);
  const [pic, setPic] = useState<{ img: HTMLImageElement; block: number; x: number; y: number } | null>(null);
  const [askPic, setAskPic] = useState<Blob | null>(null);
  const [Ask, setAsk] = useState<typeof import("./chat").AskPanel | null>(null);
  // reading aloud: loaded on the first tap of Listen; it carries on into the next section by itself
  const [Listen, setListen] = useState<typeof import("./listen") | null>(null);
  const listenNext = useRef(false);
  useEffect(() => { if (panel === "ask" && !Ask) import("./chat").then(m => setAsk(() => m.AskPanel)); }, [panel]);
  const prose = useRef<HTMLDivElement>(null);
  const target = useRef<{ block: number; frag?: string; flash?: boolean } | null>(null);
  const hoverT = useRef<number>(0);

  // open: head first (small), then the section to show
  useEffect(() => {
    let live = true;
    markOpened(id);
    (async () => {
      const fromUrl = readUrl();
      let s: Spot | null = fromUrl.section != null ? fromUrl as Spot : localPos(id);
      if (s) loadSection(id, s.section); // start reading the section while the head arrives
      const headP = loadHead(id).then(x => (mark("vic:head"), x));
      const readLog = () => Promise.all([bookOps(id).then(x => (mark("vic:ops"), x)), anchorsMap()]);
      // with the place known, the log is read after the text has had a frame to show (reading thousands of marks
      // is a long task that would otherwise hold the first paint back)
      const logP = s ? null : readLog();
      const hd = await headP;
      if (!live) return;
      if (!hd) { setMissing(true); return; }
      const show = (s: Spot) => { if (s.section >= hd.sectionInfo.length) s = { section: hd.meta.start, block: hd.meta.startBlock ?? 0 }; target.current = { block: s.block }; setH(hd); setSpot(s); };
      if (s) show(s); // the place is known: the text does not wait for the marks
      const [ops, anchors] = await (logP ?? new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0))).then(readLog));
      if (!live) return;
      const res = resolver(ops, anchors);
      setMarks(foldMarks(ops, id, res)); mark("vic:fold");
      if (s) return;
      const p = readPosition(ops, id, res);
      show(p ? { section: p.section, block: p.block } : { section: hd.meta.start, block: hd.meta.startBlock ?? 0 });
    })().catch(e => { if (live) setBroken(String((e as Error)?.message ?? e)); });
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    if (!spot || (sec && sec.idx === spot.section)) return;
    let live = true;
    loadSection(id, spot.section).then(s => { mark("vic:sec"); if (live && s) setSec(s); });
    return () => { live = false; };
  }, [id, spot?.section]);

  const refreshMarks = useCallback(async () => { const ops = await bookOps(id); setMarks(foldMarks(ops, id, resolver(ops, await anchorsMap()))); }, [id]);
  useEffect(() => onAnchors(b => { if (b === id) refreshMarks(); }), [id]);
  useEffect(() => onOp(o => { if (o.k === "mark" || o.k === "hl" || o.k === "hl-" || o.k === "alias" || o.k === "card") refreshMarks(); }), [id]);
  const placeGlyphs = useCallback(() => { const el = prose.current; if (el && sec && !sec.fixed) setGlyphs(glyphsFor(el, marks, sec.idx)); }, [marks, sec]);
  useEffect(() => { const el = prose.current; if (!el) return; const ro = new ResizeObserver(() => placeGlyphs()); ro.observe(el); return () => ro.disconnect(); }, [placeGlyphs]);

  // a PDF reads as printed pages, or as text that fits the screen (the same blocks, so marks and places hold)
  const pdfPref = use(prefs).pdf ?? "page";
  const pdfMode = h?.meta.format === "pdf" ? pdfPref : null;
  const shown = useRef<{ sec: Section | null; mode: string | null }>({ sec: null, mode: null });
  const html = useMemo(() => !sec ? "" : pdfMode === "text" ? pdfTextHtml(sec.html) : sec.html, [sec, pdfMode]);
  // a PDF's pages are drawn by PDF.js, loaded the first time a PDF is opened
  const pdfOff = useRef<(() => void) | null>(null);
  const drawPdf = (el: HTMLElement) => {
    pdfOff.current?.(); pdfOff.current = null;
    el.classList.toggle("pdf", pdfMode === "page"); el.classList.toggle("pdftext", pdfMode === "text");
    if (pdfMode !== "page" || !h) return;
    const sha = h.meta.sha256; let off: (() => void) | null = null, gone = false;
    pdfOff.current = () => { gone = true; off?.(); };
    import("./pdfview").then(m => { if (!gone) off = m.attachPdf(el, sha); });
  };
  useEffect(() => () => pdfOff.current?.(), []);

  // draw the section: html, images, highlights, then scroll to the target
  useLayoutEffect(() => {
    const el = prose.current; if (!el || !sec || !h) return;
    // switching a PDF between pages and text keeps the reader on the same block
    if (shown.current.sec?.idx === sec.idx && shown.current.mode !== pdfMode && !target.current) target.current = { block: currentBlock() };
    shown.current = { sec, mode: pdfMode };
    el.innerHTML = "";
    if (sec.fixed) {
      const fr = document.createElement("iframe");
      fr.setAttribute("sandbox", "allow-same-origin");
      fr.title = h.meta.title; fr.className = "fixed-page";
      const paths = [...new Set([...sec.html.matchAll(/vic-res:([^"')\s]+)/g)].map(m => m[1]))];
      Promise.all(paths.map(p => imageUrl(id, p).then(u => [p, u] as const))).then(pairs => {
        let html = sec.html; for (const [p, u] of pairs) if (u) html = html.split(`vic-res:${p}`).join(u);
        fr.srcdoc = html;
      });
      const wrap = document.createElement("div"); wrap.className = "fixed-wrap"; wrap.append(fr); el.append(wrap);
      const fit = () => { const w = el.clientWidth, s = Math.min(w / sec.fixed!.w, (innerHeight - 120) / sec.fixed!.h); fr.style.width = sec.fixed!.w + "px"; fr.style.height = sec.fixed!.h + "px"; fr.style.transform = `scale(${s})`; wrap.style.height = sec.fixed!.h * s + "px"; wrap.style.width = sec.fixed!.w * s + "px"; };
      fit(); addEventListener("resize", fit);
      mark("vic:book");
      return () => removeEventListener("resize", fit);
    }
    // switching a PDF between pages and text keeps the reader on the same block
    el.innerHTML = html; drawPdf(el);
    // wide equations and tables scroll inside their own block instead of pushing the page sideways
    for (const w of el.querySelectorAll("math, table, pre")) w.closest("[data-b]")?.classList.add("wide");
    mark("vic:book");
    for (const img of el.querySelectorAll<HTMLImageElement>("img[data-src]")) imageUrl(id, img.dataset.src!).then(u => { if (u) img.src = u; });
    painted.current = false;
    const tg = target.current; target.current = null;
    if (tg) {
      const dest = (tg.frag && el.querySelector(`#${CSS.escape(`s${sec.idx}-${tg.frag}`)}`)) || (tg.block > 0 ? el.querySelector(`[data-b="${tg.block}"]`) : null);
      if (dest) { (dest as HTMLElement).scrollIntoView({ block: "start" }); scrollBy(0, -70); if (tg.flash) { dest.classList.add("flash"); setTimeout(() => dest.classList.remove("flash"), 1600); } }
      else scrollTo(0, 0);
    }
  }, [sec, h, html]);

  useEffect(() => {
    const el = prose.current; if (!listenNext.current || !Listen || !el || !sec || !h) return;
    listenNext.current = false; Listen.player.continueIn(el, listenMeta(), listenEnd);
  }, [sec, html]);
  useEffect(() => () => { Listen?.player.stop(); }, [Listen]);
  // with search by meaning on this device, the open book is prepared for it in the background, this section first
  useEffect(() => { if (sec && localStorage.getItem("vicaria.models.wanted")?.includes('"search"')) import("../models/search").then(m => m.embedInBackground(id, sec.idx)).catch(() => {}); }, [id, sec?.idx]);

  // draw the marks over it (the text shows first; marks follow as soon as the log is read). CSS highlights are
  // redrawn in place; marks drawn as elements need the section's own html back first.
  const painted = useRef(false);
  useLayoutEffect(() => {
    const el = prose.current; if (!el || !sec || !h || sec.fixed) return;
    if (painted.current && !canHighlight()) {
      const y = scrollY; el.innerHTML = html; drawPdf(el);
      for (const w of el.querySelectorAll("math, table, pre")) w.closest("[data-b]")?.classList.add("wide");
      for (const img of el.querySelectorAll<HTMLImageElement>("img[data-src]")) imageUrl(id, img.dataset.src!).then(u => { if (u) img.src = u; });
      scrollTo(0, y);
    }
    mark("vic:paint0"); paintMarks(el, marks, sec.idx); painted.current = true;
    mark("vic:marks");
    placeGlyphs();
  }, [sec, h, marks, html]);

  // remember where reading stopped
  useEffect(() => {
    const el = prose.current; if (!el || !sec) return;
    let timer = 0, lastSaved = "";
    const save = () => {
      const blocks = el.querySelectorAll<HTMLElement>("[data-b]");
      let b = 0;
      for (const x of blocks) { if (x.getBoundingClientRect().bottom > 80) { b = +x.dataset.b!; break; } }
      const s = { section: sec.idx, block: b }; const key = JSON.stringify(s);
      localStorage.setItem("vic:pos:" + id, key);
      if (h) setProgress(id, fraction(h.sectionInfo.map(x => x.blocks), s.section, s.block));
      if (key !== lastSaved && location.pathname.endsWith(`/book/${id}`)) history.replaceState(history.state, "", `${BASE}/book/${id}?s=${s.section}&b=${s.block}`);
      if (key !== lastSaved) { lastSaved = key; clearTimeout(timer); timer = window.setTimeout(() => addOp("pos", { book: id, ...s }), 2000); }
    };
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(save); };
    let raf = 0;
    addEventListener("scroll", onScroll, { passive: true });
    save();
    return () => { removeEventListener("scroll", onScroll); clearTimeout(timer); };
  }, [sec]);

  const spotUrl = (s: Spot) => `${BASE}/book/${id}?s=${s.section}&b=${s.block}`;
  // jumps (notes, links, search hits) are browser history entries, so the system Back gesture returns too
  const open = (s: Spot & { frag?: string; flash?: boolean }, remember = true, fromHistory = false) => {
    if (remember && spot && sec) {
      const here = { section: sec.idx, block: currentBlock() };
      setBack(b => [...b.slice(-20), here]);
      history.replaceState(history.state, "", spotUrl(here));
      history.pushState({ vicJump: true }, "", spotUrl(s));
    } else if (!fromHistory) history.replaceState(history.state, "", spotUrl(s));
    target.current = { block: s.block, frag: s.frag, flash: s.flash };
    setNote(null); setPanel(null); setSel(null); setEdit(null); setDraft(null);
    if (sec && s.section === sec.idx) { setSec({ ...sec }); return; }
    setSpot({ section: s.section, block: s.block });
  };
  const currentBlock = () => { const el = prose.current; if (!el) return 0; for (const x of el.querySelectorAll<HTMLElement>("[data-b]")) if (x.getBoundingClientRect().bottom > 80) return +x.dataset.b!; return 0; };
  const goBack = () => { if (back.length) history.back(); };
  useEffect(() => {
    const pop = () => {
      if (!location.pathname.endsWith(`/book/${id}`)) return; // leaving the book: the router handles it
      const u = readUrl();
      setBack(b => b.slice(0, -1));
      open({ section: u.section ?? 0, block: u.block ?? 0, flash: true }, false, true);
    };
    addEventListener("popstate", pop); return () => removeEventListener("popstate", pop);
  });

  // clicks inside the text: note references, internal links, highlights
  const showNote = (a: HTMLElement) => {
    const n = h?.notes[a.dataset.note!]; if (!n) return false;
    const r = a.getBoundingClientRect();
    const below = r.top < innerHeight * 0.45;
    setNote({ n, x: Math.min(Math.max(12, r.left + r.width / 2), innerWidth - 12), y: below ? r.bottom + 8 : r.top - 8, below });
    mark("vic:note");
    return true;
  };
  const onClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    setPic(null);
    const ref = el.closest<HTMLElement>("a.nref");
    if (ref) { e.preventDefault(); showNote(ref); return; }
    const link = el.closest<HTMLAnchorElement>("a[data-sec]");
    if (link) { e.preventDefault(); open({ section: +link.dataset.sec!, block: 0, frag: link.dataset.frag, flash: true }); return; }
    const img = el.closest<HTMLImageElement>("img");
    if (img && img.src && !img.closest("a")) { const r = img.getBoundingClientRect(); const b = img.closest<HTMLElement>("[data-b]"); setPic({ img, block: b ? +b.dataset.b! : 0, x: r.left + r.width / 2, y: Math.min(innerHeight - 60, Math.max(60, r.top + r.height / 2)) }); return; }
    if (!getSelection()?.toString()) {
      const m = el.closest<HTMLElement>("mark.hl"), hit = m ? null : markAt(e.clientX, e.clientY);
      const r = m ? m.getBoundingClientRect() : hit ? [...hit.range.getClientRects()].find(b => e.clientY >= b.top - 1 && e.clientY <= b.bottom + 1) ?? hit.range.getBoundingClientRect() : null;
      const id = m?.dataset.h ?? hit?.m.id;
      if (id && r) { setEdit({ id, x: r.left + r.width / 2, y: r.bottom + 8 }); return; }
    }
    if (!el.closest(".popover")) { setNote(null); setEdit(null); }
  };
  // highlights drawn as CSS highlights have no element to style, so the pointer hand is set from a hit test
  const moveT = useRef(0);
  const onMove = (e: MouseEvent) => {
    if (moveT.current || e.buttons) return;
    const { clientX: x, clientY: y } = e;
    moveT.current = requestAnimationFrame(() => { moveT.current = 0; const el = prose.current; if (el) el.style.cursor = markAt(x, y) ? "pointer" : ""; });
  };
  const onOver = (e: MouseEvent) => {
    if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const ref = (e.target as HTMLElement).closest<HTMLElement>("a.nref");
    clearTimeout(hoverT.current);
    if (ref) hoverT.current = window.setTimeout(() => showNote(ref), 180);
  };
  const onUp = () => setTimeout(() => {
    const s = getSelection(); if (!s || s.isCollapsed || !sec || !prose.current?.contains(s.anchorNode)) { setSel(null); return; }
    const a = anchorFromRange(s.getRangeAt(0), sec.idx); if (!a) return;
    const r = s.getRangeAt(0).getBoundingClientRect();
    setSel({ a, x: r.left + r.width / 2, y: r.top - 8 });
  }, 10);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setNote(null); setPanel(null); setSel(null); setEdit(null); setDraft(null); }
      if ((e.target as HTMLElement).closest?.("input,textarea,select")) return;
      if (e.key === "/") { e.preventDefault(); setPanel("search"); }
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, []);

  const failed = (e: unknown) => toast(e instanceof MarkError ? e.message : t("reader.saveFailed"));
  const clearSel = () => { getSelection()?.removeAllRanges(); setSel(null); };
  const highlight = async (color: Color) => { if (!sel) return; const a = sel.a; clearSel(); await createMark(id, { at: a, color }).catch(failed); };
  const pointAt = (a: Anchor): Anchor => ({ section: a.section, block: a.block, offset: a.offset, endBlock: a.block, endOffset: a.offset, exact: a.exact.slice(0, 60), prefix: a.prefix, suffix: "" });
  // a named place: from a selection, or the top of the page from the ribbon button
  const bookmark = async (a: Anchor, x: number, y: number) => {
    const existing = marks.find(m => m.bookmark && !m.gone && m.at && m.at.section === a.section && m.at.block === a.block);
    if (existing) { setEdit({ id: existing.id, x, y }); return; }
    // named by its first words (note numbers left out); the chapter is shown next to it anyway
    const words = plainText(prose.current?.querySelector(`[data-b="${a.block}"]`), a.offset).replace(/\s+/g, " ").trim();
    const name = (words.length > 56 ? words.slice(0, 56).replace(/\s+\S*$/, "") + "…" : words) || chapterOf(a.section);
    try { const op = await createMark(id, { at: pointAt(a), bookmark: { name } }); toast(t("reader.bookmarked"), { action: { label: t("reader.nameIt"), run: () => setEdit({ id: String((op.v as { id: string }).id), x, y }) } }); } catch (e) { failed(e); }
  };
  const topAnchor = (): Anchor | null => {
    const el = prose.current; if (!el || !sec) return null;
    for (const x of el.querySelectorAll<HTMLElement>("[data-b]")) if (x.getBoundingClientRect().bottom > 80) { const txt = (x.textContent || "").replace(/\s+/g, " ").trim(); return { section: sec.idx, block: +x.dataset.b!, offset: 0, endBlock: +x.dataset.b!, endOffset: 0, exact: txt.slice(0, 60), prefix: "", suffix: "" }; }
    return null;
  };
  // the last block on screen: questions use the book up to here (nothing the reader has not reached)
  const placeShown = () => {
    let last = topAnchor()?.block ?? 0;
    for (const x of prose.current?.querySelectorAll<HTMLElement>("[data-b]") ?? []) if (x.getBoundingClientRect().top < innerHeight) last = Math.max(last, +x.dataset.b!);
    return { section: sec?.idx ?? 0, block: last };
  };
  const editing = edit ? marks.find(m => m.id === edit.id) : undefined;

  if (broken) return <ErrorScreen title={t("errors.bookTitle")} body={t("errors.bookBody")} problem={broken} reload />;
  if (missing) return <section class="page"><p>{t("reader.notHere")}</p><button class="btn" onClick={() => go("/")}>{t("reader.library")}</button></section>;
  const info = h?.sectionInfo;
  const linear = info ? info.filter(s => s.linear || s.idx === sec?.idx) : [];
  const pos = sec ? linear.findIndex(s => s.idx === sec.idx) : -1;
  const prev = pos > 0 ? linear[pos - 1] : null, next = pos >= 0 && pos < linear.length - 1 ? linear[pos + 1] : null;
  const chapterOf = (s: number) => (h?.meta.format === "pdf" && h.toc.find(x => x.section === s) || h?.toc.filter(x => x.section <= s).pop())?.title || info?.[s]?.title || "";
  const listenMeta = () => ({ title: h?.meta.title || "", author: h?.meta.author || "", chapter: sec ? chapterOf(sec.idx) : "", lang: h?.meta.language || "en" });
  const listenEnd = () => { const nx = next; if (!nx) return null; return () => { listenNext.current = true; open({ section: nx.idx, block: 0 }, false); }; };
  const startListen = async () => {
    const m = Listen ?? await import("./listen"); setListen(() => m);
    const el = prose.current; if (!el) return;
    if (m.player.listen.on) { m.player.stop(); return; }
    m.player.start(el, currentBlock(), listenMeta(), listenEnd());
  };
  const title = (s: { idx: number; title: string }) => h?.toc.find(x => x.section === s.idx)?.title || s.title || t("reader.part", { n: s.idx + 1 });

  return (
    <div class={`reader ${h?.meta.vertical ? "vertical" : ""}`} lang={h?.meta.language} dir={h?.meta.dir}>
      <BgLayer textShown={!!sec} />
      <header class="rbar" dir="ltr">
        <a class="icon" href={BASE + "/"} aria-label={t("reader.library")} onClick={e => { e.preventDefault(); go("/"); }}>←</a>
        <div class="rtitle"><b>{h?.meta.title || ""}</b>{sec && <span>{chapterOf(sec.idx)}</span>}</div>
        <button class="icon" aria-label={t("reader.contents")} onClick={() => setPanel(panel === "contents" ? null : "contents")}>☰</button>
        <button class="icon" aria-label={t("reader.searchInBook")} onClick={() => setPanel(panel === "search" ? null : "search")}>⌕</button>
        <button class="icon" aria-label={t("reader.bookmarkPage")} onClick={e => { const a = topAnchor(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); if (a) bookmark(a, r.left, r.bottom + 8); }}><svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><path d="M3 1.5h10v15l-5-3.6-5 3.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg></button>
        <button class="icon" aria-label={t("reader.marks")} onClick={() => setPanel(panel === "marks" ? null : "marks")}>✎</button>
        <button class="icon" aria-label={t("reader.listen")} onClick={startListen}><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 7h3l4-3.5v11L6 11H3z" fill="currentColor" /><path d="M12.5 6.2a4 4 0 0 1 0 5.6M14.6 4.1a7 7 0 0 1 0 9.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button>
        <button class="icon ask" aria-label={t("reader.askAbout")} onClick={() => { setAskSel(null); setAskPic(null); setPanel(panel === "ask" ? null : "ask"); }}>{t("reader.ask")}</button>
        <button class="icon" aria-label={t("reader.textSettings")} onClick={() => setPanel(panel === "type" ? null : "type")}>Aa</button>
      </header>
      <div class="pagewrap">
        <article class="prose" ref={prose} onClick={onClick as never} onMouseOver={onOver as never} onMouseMove={onMove as never} onMouseUp={onUp} onTouchEnd={onUp} onKeyUp={onUp} />
        <div class="margin" dir="ltr" role="region" aria-label={t("reader.notesMargin")}>
          {glyphs.map(g => {
            const sticky = g.marks.find(m => m.sticky);
            const loved = g.marks.some(m => m.loved), bm = g.marks.some(m => m.bookmark);
            const open = (e: MouseEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setEdit({ id: (sticky || g.marks[0]).id, x: r.left, y: r.bottom + 6 }); };
            return sticky
              ? <button key={g.block} class={`stickycard ${sticky.sticky!.tint}`} style={{ top: g.top + "px", left: g.left + "px" }} onClick={open as never} aria-label={t("reader.stickyNote")}>{sticky.note}{g.marks.length > 1 && <small> +{g.marks.length - 1}</small>}</button>
              : <button key={g.block} class={`mg ${bm ? "bm" : ""} ${loved ? "loved" : ""}`} style={{ top: g.top + "px", left: g.left + "px" }} onClick={open as never} aria-label={t("reader.marksHere", { n: g.marks.length })}>{bm ? "" : g.marks.length > 1 ? g.marks.length : ""}</button>;
          })}
        </div>
      </div>
      {sec && (
        <nav class="chapnav" dir="ltr">
          {prev ? <button class="btn ghost" onClick={() => open({ section: prev.idx, block: 0 }, false)}>← {title(prev)}</button> : <span />}
          {next && <button class="btn" onClick={() => open({ section: next.idx, block: 0 }, false)}>{title(next)} →</button>}
        </nav>
      )}
      {Listen && <Listen.ListenBar lang={h?.meta.language || "en"} />}
      {back.length > 0 && <button class="backchip" dir="ltr" onClick={goBack}>← {t("reader.back")}</button>}
      {note && <NotePopover {...note} book={id} onClose={() => setNote(null)} onGo={() => open({ section: note.n.section, block: note.n.block, frag: note.n.id.replace(/^s\d+-/, ""), flash: true })} />}
      {sel && <SelectionBar x={sel.x} y={sel.y} onColor={highlight}
        onNote={() => { setDraft({ a: sel.a, x: sel.x, y: sel.y + 12, sticky: false }); clearSel(); }}
        onSticky={() => { setDraft({ a: sel.a, x: sel.x, y: sel.y + 12, sticky: true }); clearSel(); }}
        onBookmark={() => { const a = sel.a; clearSel(); bookmark(a, sel.x, sel.y + 12); }}
        onCopy={() => { navigator.clipboard?.writeText(sel.a.exact); clearSel(); toast(t("reader.copied")); }}
        onAsk={() => { const a = sel.a; setAskPic(null); setAskSel({ section: a.section, block: a.block, text: a.exact }); clearSel(); setPanel("ask"); }} />}
      {pic && <div class="popover seltools" dir="ltr" role="toolbar" aria-label={t("reader.picture")} style={{ left: pic.x + "px", top: pic.y + "px" }}>
        <button onClick={async () => { const blob = await (await fetch(pic.img.src)).blob().catch(() => null); setAskSel({ section: sec?.idx ?? 0, block: pic.block, text: pic.img.alt ? `(picture: ${pic.img.alt})` : "(picture)" }); setAskPic(blob); setPic(null); setPanel("ask"); }}>{t("reader.askPicture")}</button>
        <button class="icon" aria-label={t("reader.close")} onClick={() => setPic(null)}>×</button>
      </div>}
      {draft && <NoteDraft x={draft.x} y={draft.y} sticky={draft.sticky} onClose={() => setDraft(null)}
        onSave={text => createMark(id, draft.sticky ? { at: draft.a, sticky: { side: "r", tint: "yellow" } } : { at: draft.a }, { note: text })} />}
      {edit && editing && <MarkSheet m={editing} x={edit.x} y={edit.y} focusNote={edit.focusNote} onClose={() => setEdit(null)} />}
      {panel && h && sec && (
        <div class="panel" dir="ltr" role="dialog" aria-label={panel}>
          <div class="ptop"><b>{{ contents: t("reader.contents"), search: t("reader.search"), type: t("reader.text"), marks: t("reader.marks"), ask: t("reader.ask") }[panel]}</b><button class="icon" aria-label={t("reader.close")} onClick={() => setPanel(null)}>×</button></div>
          {panel === "contents" && <Contents h={h} current={sec.idx} onPick={t => open({ section: t.section, block: t.block }, false)} />}
          {panel === "search" && <Search id={id} onPick={x => open({ section: x.section, block: x.block, flash: true })} />}
          {panel === "type" && <TypePanel pdf={h.meta.format === "pdf"} />}
          {panel === "ask" && (Ask ? <Ask book={{ id, title: h.meta.title, author: h.meta.author }} selection={askSel} picture={askPic} chapterOf={chapterOf} place={placeShown}
            onCite={(s, b) => { open({ section: s, block: b, flash: true }); if (innerWidth < 700) setPanel(null); }} /> : <p class="muted">{t("reader.loading")}</p>)}
          {panel === "marks" && <MarksPanel book={id} marks={marks} chapterOf={chapterOf} onPick={m => open({ section: m.at!.section, block: m.at!.block, flash: true })} onEdit={m => setEdit({ id: m.id, x: innerWidth / 2, y: 80 })} />}
        </div>
      )}
    </div>
  );
}

function NotePopover(p: { n: Note; x: number; y: number; below: boolean; book: string; onClose: () => void; onGo: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    el.querySelector(".nbody")!.innerHTML = p.n.html;
    for (const img of el.querySelectorAll<HTMLImageElement>("img[data-src]")) imageUrl(p.book, img.dataset.src!).then(u => { if (u) img.src = u; });
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth - 8) el.style.left = `${innerWidth - 8 - r.width / 2}px`;
    if (r.left < 8) el.style.left = `${8 + r.width / 2}px`;
  }, [p.n, p.x, p.y]);
  return (
    <div ref={ref} class={`popover note ${p.below ? "below" : "above"}`} role="dialog" aria-label={t("reader.note", { label: p.n.label })} style={{ left: p.x + "px", top: p.y + "px" }}>
      <div class="nbody" />
      <div class="nfoot"><button class="link" onClick={p.onGo}>{t("reader.goToNote")}</button><button class="link" onClick={p.onClose}>{t("reader.close")}</button></div>
    </div>
  );
}

function Contents(p: { h: Head; current: number; onPick: (t: { section: number; block: number }) => void }) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => { ref.current?.querySelector(".on")?.scrollIntoView({ block: "center" }); }, []);
  const toc = p.h.toc.length ? p.h.toc : p.h.sectionInfo.map(s => ({ title: s.title || t("reader.part", { n: s.idx + 1 }), section: s.idx, block: 0, depth: 0 }));
  const cur = [...toc].reverse().find(x => x.section <= p.current);
  return <ul class="toc" ref={ref}>{toc.map((e, i) => <li key={i} style={{ paddingLeft: e.depth * 14 + "px" }} class={e === cur ? "on" : ""}><button class="link" onClick={() => p.onPick(e)}>{e.title}</button></li>)}</ul>;
}

type Hit = { section: number; block: number; before: string; match: string; after: string; title: string };
function Search(p: { id: string; onPick: (h: Hit) => void }) {
  const [q, setQ] = useState(sessionStorage.getItem("vic:q:" + p.id) || "");
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => {
    sessionStorage.setItem("vic:q:" + p.id, q);
    if (q.trim().length < 2) { setHits(null); return; }
    let live = true; const timer = setTimeout(() => books.call<Hit[]>("search", [p.id, q]).then(r => { if (live) setHits(r); }), 120);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);
  return (
    <div class="search">
      <input type="search" autoFocus placeholder={t("reader.searchInBook")} aria-label={t("reader.searchInBook")} value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
      {hits && <p class="muted">{hits.length >= 200 ? t("reader.resultsMany") : t("reader.results", { n: hits.length })}</p>}
      <ul class="hits">{hits?.map((h, i) => <li key={i}><button class="link" onClick={() => p.onPick(h)}><small>{h.title}</small><span>…{h.before}<mark>{h.match}</mark>{h.after}…</span></button></li>)}</ul>
    </div>
  );
}

function TypePanel(q: { pdf: boolean }) {
  const p = use(prefs);
  return (
    <div class="type">
      {q.pdf && <div class="row" role="radiogroup" aria-label={t("reader.pdfPages")}>{(["page", "text"] as const).map(m => <button key={m} role="radio" aria-checked={(p.pdf ?? "page") === m} class={`chip ${(p.pdf ?? "page") === m ? "on" : ""}`} onClick={() => setPrefs({ pdf: m })}>{m === "page" ? t("reader.pdfAsPrinted") : t("reader.pdfText")}</button>)}</div>}
      <div class="row">{(["auto", "light", "sepia", "dark"] as const).map(th => <button key={th} class={`chip ${p.theme === th ? "on" : ""}`} onClick={() => setPrefs({ theme: th })}>{{ auto: t("reader.auto"), light: t("reader.light"), sepia: t("reader.sepia"), dark: t("reader.dark") }[th]}</button>)}</div>
      <div class="row">{(["serif", "sans"] as const).map(f => <button key={f} class={`chip ${p.font === f ? "on" : ""}`} onClick={() => setPrefs({ font: f })}>{f === "serif" ? "Literata" : "Atkinson"}</button>)}</div>
      <label>{t("reader.size")} <span class="row"><button class="chip" onClick={() => setPrefs({ size: Math.max(13, p.size - 1) })}><span aria-hidden="true">A−</span><span class="sr">{t("reader.smaller")}</span></button><span>{p.size}</span><button class="chip" onClick={() => setPrefs({ size: Math.min(34, p.size + 1) })}><span aria-hidden="true">A+</span><span class="sr">{t("reader.larger")}</span></button></span></label>
      <label>{t("reader.lineSpacing")} <input type="range" min="1.2" max="2.2" step="0.1" value={p.leading} onInput={e => setPrefs({ leading: +(e.target as HTMLInputElement).value })} /></label>
      <label>{t("reader.width")} <input type="range" min="26" max="56" step="1" value={p.width} onInput={e => setPrefs({ width: +(e.target as HTMLInputElement).value })} /></label>
      <label class="check"><input type="checkbox" checked={p.justify} onChange={e => setPrefs({ justify: (e.target as HTMLInputElement).checked })} /> {t("reader.justify")}</label>
      <h3 class="sub">{t("reader.background")}</h3>
      <BgPicker />
    </div>
  );
}

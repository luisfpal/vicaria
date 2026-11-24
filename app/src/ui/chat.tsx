// Ask about the book: a conversation with this chapter or with the book so far, answers that cite the passages they
// use (tap a citation to go there), math and diagrams, a question about a selection, pictures, and dictation.
// Loaded only when the reader opens it.
import { useEffect, useRef, useState } from "preact/hooks";
import { activeRoute, AiError, type Part } from "../ai/providers";
import { prepare, askBook, chatKey, loadChat, saveChat, clearChat, type Turn, type BookInfo } from "../ai/ask";
import { renderAnswer, hasMath, hasMermaid, type KatexLike } from "../ai/render";
import type { Scope } from "../ai/retrieve";
import { busy } from "../core/busy";
import { canRecord, record, transcribe, type Recording } from "../ai/whisper";
import { progressOf, startModel, checkModels } from "../models/client";
import { voiceSupport, voiceMode, installVoice, listen, voiceError, type Rec } from "../ai/voice";
import { toast } from "./state";
import { go } from "./state";
import { t } from "../core/i18n";

export interface AskProps {
  book: BookInfo;
  place: () => { section: number; block: number };
  selection?: { section: number; block: number; text: string } | null;
  picture?: Blob | null; // a picture from the book to ask about
  chapterOf: (section: number) => string;
  onCite: (section: number, block: number) => void;
}

let katex: KatexLike | null = null;
async function loadKatex() { if (!katex) { const [k] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]); katex = (k as unknown as { default: KatexLike }).default; } return katex; }
let mermaidN = 0;
const MIN_SCALE = 0.85; // labels are drawn at 16px; below this scale they fall under about 13.5px
const naturalWidth = (d: HTMLElement) => { const vb = d.querySelector("svg")?.getAttribute("viewBox")?.split(/[\s,]+/).map(Number); return vb && vb.length === 4 && vb[2] > 0 ? vb[2] : 0; };
async function drawMermaid(root: HTMLElement) {
  const blocks = [...root.querySelectorAll<HTMLElement>(".mermaid-src:not([data-done])")]; if (!blocks.length) return;
  const m = (await import("mermaid")).default;
  const dark = document.documentElement.dataset.theme === "dark";
  m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "inherit" });
  for (const b of blocks) {
    b.dataset.done = "1";
    try {
      let src = b.textContent || "";
      const room = b.parentElement?.clientWidth || 400;
      const d = document.createElement("div"); d.className = "mermaid";
      d.innerHTML = (await m.render(`vic-mm-${++mermaidN}`, src)).svg;
      // A wide left-to-right chart shrunk to the panel has unreadable labels: draw it top to bottom instead,
      // and if it is still too wide, keep the labels readable and let it scroll sideways.
      if (naturalWidth(d) * MIN_SCALE > room && /^\s*(flowchart|graph)\s+LR\b/.test(src)) {
        src = src.replace(/^(\s*(?:flowchart|graph)\s+)LR\b/, "$1TD");
        d.innerHTML = (await m.render(`vic-mm-${++mermaidN}`, src)).svg;
      }
      const w = naturalWidth(d);
      if (w * MIN_SCALE > room) { const svg = d.querySelector("svg"); if (svg) { svg.style.maxWidth = "none"; svg.style.width = `${Math.round(w * MIN_SCALE)}px`; } }
      b.replaceWith(d);
    }
    catch { b.classList.add("bad"); } // the source stays visible
  }
}

function Answer(p: { text: string; sent: Set<string>; done: boolean; label: (id: string) => string; onCite: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [, setK] = useState(0);
  useEffect(() => { if (!katex && hasMath(p.text)) loadKatex().then(() => setK(n => n + 1)).catch(() => {}); }, [p.text]);
  const html = renderAnswer(p.text, { sent: p.sent, katex, label: p.label });
  // after every change of the HTML (math arriving replaces it), draw the diagrams again
  useEffect(() => { if (p.done && ref.current && hasMermaid(p.text)) drawMermaid(ref.current).catch(() => {}); }, [p.done, html]);
  return <div ref={ref} class="answer" dangerouslySetInnerHTML={{ __html: html }}
    onClick={e => { const b = (e.target as HTMLElement).closest<HTMLElement>("button.cite"); if (b?.dataset.cite) p.onCite(b.dataset.cite); }} />;
}

// a picture for the model: at most 1568 px on the long side, JPEG
async function picture(f: Blob): Promise<Part & { type: "image" }> {
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return { type: "image", mime: "image/jpeg", data: btoa(s) };
}

// The card for the chapter on screen: made on request from the chapter's text, kept and synced as an op
function ChapterCard(p: { book: BookInfo; section: number; chapter: string; label: (id: string) => string; onCite: (id: string) => void }) {
  const [card, setCard] = useState<import("../ai/cards").Card | null | undefined>(undefined);
  const [state, setState] = useState<string>("");
  const r = activeRoute();
  useEffect(() => { let on = true; setCard(undefined); import("../ai/cards").then(m => m.savedCard(p.book.id, p.section)).then(c => on && setCard(c)); return () => { on = false; }; }, [p.book.id, p.section]);
  const make = async () => {
    if (!r) return; const done = busy("card"); setState(t("chat.readingChapter"));
    try {
      const [m, { passages }] = await Promise.all([import("../ai/cards"), import("../core/read")]);
      const text = ((await passages(p.book.id)) ?? []).filter(x => x.section === p.section).map(x => x.text).join("\n\n");
      if (!text.trim()) { setState(t("chat.noChapterText")); return; }
      const c = await m.makeCard(r.route, r.key, p.book, p.chapter, text);
      await m.saveCard(p.book.id, p.section, c); setCard(c); setState("");
    } catch (e) { setState(e instanceof AiError ? e.message : (e as Error).message || t("chat.cardFailed")); }
    finally { done(); }
  };
  const [md, setMd] = useState("");
  useEffect(() => { if (card) import("../ai/cards").then(m => setMd(m.cardMarkdown(card))); }, [card]);
  return (
    <div class="cardview">
      {card === undefined ? <p class="muted">{t("chat.loading")}</p> : card ? <Answer text={md} sent={new Set()} done label={p.label} onCite={p.onCite} /> :
        <p class="muted">{t("chat.cardIntro")}</p>}
      {state && <p class={state.endsWith("…") ? "muted thinking" : "err"} role="status">{state}</p>}
      {r && !state.endsWith("…") && <button class={card ? "link" : "btn"} onClick={make}>{card ? t("chat.makeItAgain") : t("chat.makeTheCard")}</button>}
    </div>
  );
}

export function AskPanel(p: AskProps) {
  const [mode, setMode] = useState<"chapter" | "book" | "card">("chapter");
  const [whole, setWhole] = useState(false);
  const [sel, setSel] = useState(p.selection ?? null);
  const scope = (): Scope => ({ mode: mode === "book" ? "book" : "chapter", whole, upTo: p.place(), ...(sel ? { selection: sel } : {}) });
  const key = chatKey(p.book.id, scope());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [imgs, setImgs] = useState<(Part & { type: "image" })[]>([]);
  const [live, setLive] = useState<{ text: string; sent: string[] } | null>(null);
  const [listening, setListening] = useState(false);
  const stop = useRef<AbortController | null>(null);
  const rec = useRef<Rec | null>(null);
  const lang = navigator.language || "en-US";
  // no recognizer in the browser: Whisper on this device, after a one time download, where the microphone can be used
  const whisper = voiceSupport() === "none" && canRecord();
  const voice = whisper ? "whisper" : voiceSupport();
  const taking = useRef<Recording | null>(null);
  // while search by meaning reads this book in the background: how far it is
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (!localStorage.getItem("vicaria.models.wanted")?.includes('"search"')) return;
    let off = () => {}, gone = false;
    import("../models/search").then(m => {
      if (gone) return;
      const look = () => { const e = m.embedded(p.book.id); setReading(e && e.total ? e : null); };
      off = m.onEmbed(look); look();
    }).catch(() => {});
    return () => { gone = true; off(); };
  }, [p.book.id]);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const r = activeRoute();

  useEffect(() => { setSel(p.selection ?? null); if (p.selection) input.current?.focus(); }, [p.selection]);
  useEffect(() => { if (p.picture && r?.route.vision) picture(p.picture).then(x => setImgs([x])).catch(() => {}); }, [p.picture]);
  useEffect(() => { let on = true; loadChat(key).then(t => on && setTurns(t)); return () => { on = false; }; }, [key]);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [turns.length, live?.text]);
  useEffect(() => () => { stop.current?.abort(); rec.current?.stop(); }, []);

  const label = (id: string) => { const [s] = id.split("."); return p.chapterOf(+s) ? `${p.chapterOf(+s).slice(0, 18)} ¶${id.split(".")[1]}` : id; };
  const cite = (id: string) => { const [s, b] = id.split(".").map(Number); p.onCite(s, b); };

  async function send(text = q.trim()) {
    if (!r || !text || live) return;
    const done = busy("ask");
    const s = scope(), history = turns;
    // passages by meaning, when search by meaning is on this device and the book has been read for it
    const meaning = localStorage.getItem("vicaria.models.wanted")?.includes('"search"') ? await import("../models/search").then(m => m.byMeaning(p.book.id, `${text} ${sel?.text ?? ""}`)).catch(() => []) : [];
    const asked = await prepare(p.book, s, text, history, imgs, undefined, meaning);
    const ids = asked.sent.map(x => `${x.section}.${x.b0}`);
    const user: Turn = { role: "user", text, at: Date.now(), ...(sel ? { selection: sel.text } : {}), ...(imgs.length ? { images: imgs.length } : {}) };
    const now = [...history, user]; setTurns(now); setQ(""); setImgs([]); setSel(null);
    const ac = new AbortController(); stop.current = ac;
    setLive({ text: "", sent: ids });
    let frame = 0, latest = "";
    try {
      const res = await askBook(r.route, r.key, asked, { signal: ac.signal, onText: (_d, all) => { latest = all; if (!frame) frame = requestAnimationFrame(() => { frame = 0; setLive({ text: latest, sent: ids }); }); } });
      const next = [...now, { role: "assistant" as const, text: res.text, at: Date.now(), sent: ids }];
      setTurns(next); setLive(null); await saveChat(key, next); // the box takes a new question as soon as the answer shows, not after the save
    } catch (e) {
      const msg = e instanceof AiError ? e.message : t("chat.somethingWrong");
      const next = [...now, { role: "assistant" as const, text: latest, at: Date.now(), sent: ids, error: msg, errorKind: e instanceof AiError ? e.kind : "provider" }];
      setTurns(next); setLive(null); await saveChat(key, next);
    } finally { cancelAnimationFrame(frame); setLive(null); stop.current = null; done(); }
  }
  async function dictateWhisper() {
    if (taking.current) {
      const rec = taking.current; taking.current = null; setListening(false); toast(t("chat.writingItDown"));
      try { const text = await transcribe(await rec.stop(), lang); if (text) setQ(x => (x ? x.replace(/\s*$/, " ") : "") + text); else toast(t("chat.nothingHeard")); }
      catch { toast(t("chat.dictationFailed")); }
      input.current?.focus(); return;
    }
    await checkModels();
    const m = progressOf("speech");
    if (m?.status !== "done") {
      if (m?.status === "downloading" || m?.status === "queued") { toast(t("chat.dictationDownloading", { pct: Math.floor(100 * m.got / Math.max(1, m.total)) })); return; }
      await startModel("speech", true);
      toast(t("chat.dictationGetting")); return;
    }
    try { taking.current = await record(); setListening(true); }
    catch { toast(t("chat.micDenied")); }
  }
  async function dictate() {
    if (whisper) return dictateWhisper();
    if (listening) { rec.current?.stop(); return; }
    let mode = await voiceMode(lang);
    if (mode.kind === "none") { toast(t("chat.dictationUnavailable")); return; }
    if (mode.kind === "local" && mode.install) {
      toast(t("chat.dictationInstalling"));
      if (!(await installVoice(lang))) { toast(t("chat.dictationInstallFailed")); return; }
      mode = { kind: "local", install: false };
    }
    const base = q ? q.replace(/\s*$/, " ") : "";
    rec.current = listen(lang, mode, {
      text: t => setQ(base + t),
      end: err => { setListening(false); rec.current = null; if (err && err !== "aborted") toast(voiceError(err)); input.current?.focus(); },
    });
    setListening(!!rec.current);
  }
  if (!r) return (
    <div class="ask empty">
      <p>{t("chat.noKey")}</p>
      <p class="muted">{t("chat.noKeyHint")}</p>
      <button class="btn" onClick={() => go("/settings#ai")}>{t("chat.openSettings")}</button>
    </div>
  );
  return (
    <div class="ask">
      <div class="askscope" role="radiogroup" aria-label={t("chat.askAbout")}>
        <button role="radio" aria-checked={mode === "chapter"} class={`chip ${mode === "chapter" ? "on" : ""}`} onClick={() => setMode("chapter")}>{t("chat.thisChapter")}</button>
        <button role="radio" aria-checked={mode === "book"} class={`chip ${mode === "book" ? "on" : ""}`} onClick={() => setMode("book")}>{t("chat.bookSoFar")}</button>
        <button role="radio" aria-checked={mode === "card"} class={`chip ${mode === "card" ? "on" : ""}`} onClick={() => setMode("card")}>{t("chat.chapterCard")}</button>
        {mode !== "card" && <label class="whole"><input type="checkbox" checked={whole} onChange={e => setWhole((e.target as HTMLInputElement).checked)} /> {t("chat.includeUnread")}</label>}
      </div>
      {reading && <p class="muted small" data-embed={reading.done >= reading.total ? "done" : `${reading.done}/${reading.total}`} role="status">{reading.done >= reading.total ? t("chat.readyForMeaning") : t("chat.readingForMeaning", { pct: Math.floor(100 * reading.done / reading.total) })}</p>}
      {mode === "card" && <ChapterCard book={p.book} section={p.place().section} chapter={p.chapterOf(p.place().section)} label={label} onCite={cite} />}
      {mode !== "card" && <>
      <div class="turns" ref={list} aria-live="polite">
        {!turns.length && !live && <p class="muted">{t("chat.emptyTurns", { whole: whole ? t("chat.emptyTurnsWhole") : "" })}</p>}
        {turns.map((turn, i) => turn.role === "user"
          ? <div key={i} class="turn me">{turn.selection && <blockquote>{turn.selection}</blockquote>}<p>{turn.text}</p>{turn.images ? <small class="muted">{t("chat.pictures", { n: turn.images })}</small> : null}</div>
          : <div key={i} class="turn ai">
              {turn.text && <Answer text={turn.text} sent={new Set(turn.sent)} done label={label} onCite={cite} />}
              {turn.error && <p class={turn.errorKind === "cancelled" ? "muted small" : "err"}>{turn.error}{" "}
                {turn.errorKind === "key" ? <button class="link" onClick={() => go("/settings#ai")}>{t("chat.openSettings")}</button>
                  : i === turns.length - 1 && <button class="link" onClick={() => { const u = turns[i - 1]; setTurns(turns.slice(0, i - 1)); send(u.text); }}>{turn.errorKind === "cancelled" ? t("chat.askAgain") : t("chat.tryAgain")}</button>}</p>}
              {turn.sent?.length ? <details class="sent"><summary>{t("chat.whatWasSent", { n: turn.sent.length })}</summary><ul>{turn.sent.map(id => <li key={id}><button class="link" onClick={() => cite(id)}>{label(id)}</button></li>)}</ul></details> : null}
            </div>)}
        {live && <div class="turn ai">{live.text ? <Answer text={live.text} sent={new Set(live.sent)} done={false} label={label} onCite={cite} /> : <p class="muted thinking">{t("chat.readingPassages", { n: live.sent.length })}</p>}</div>}
      </div>
      {sel && <div class="asksel"><blockquote>{sel.text.length > 220 ? sel.text.slice(0, 220) + "…" : sel.text}</blockquote><button class="icon" aria-label={t("chat.dismissSelection")} onClick={() => setSel(null)}>×</button></div>}
      {imgs.length > 0 && <div class="askimgs">{imgs.map((im, i) => <span key={i} class="thumb"><img alt={t("chat.picture", { n: i + 1 })} src={`data:${im.mime};base64,${im.data}`} /><button class="icon" aria-label={t("chat.removePicture", { n: i + 1 })} onClick={() => setImgs(imgs.filter((_, j) => j !== i))}>×</button></span>)}</div>}
      <form class="askbox" onSubmit={e => { e.preventDefault(); send(); }}>
        <textarea ref={input} rows={2} value={q} placeholder={sel ? t("chat.askAboutSelection") : t("chat.askAboutBook")} aria-label={t("chat.question")}
          onInput={e => setQ((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
        <div class="row">
          {r.route.vision && <label class="icon" aria-label={t("chat.addPicture")} title={t("chat.addPicture")}>
            <input type="file" accept="image/*" hidden multiple onChange={async e => { const fs = [...((e.target as HTMLInputElement).files || [])].slice(0, 4); (e.target as HTMLInputElement).value = ""; const got = await Promise.all(fs.map(picture)); setImgs([...imgs, ...got].slice(0, 4)); }} />
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="1.5" y="3" width="15" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" /><circle cx="6" cy="7.5" r="1.5" fill="currentColor" /><path d="M2 14l4.5-4.5 3 3 2.5-2.5 4 4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
          </label>}
          {voice !== "none" && <button type="button" class={`icon ${listening ? "on" : ""}`} aria-label={listening ? t("chat.stopDictation") : t("chat.dictate")} aria-pressed={listening} onClick={dictate}>
            <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><rect x="5" y="1.5" width="6" height="10" rx="3" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M2.5 8.5a5.5 5.5 0 0011 0M8 14v2.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
          </button>}
          <span class="grow" />
          {turns.length > 0 && !live && <button type="button" class="link" onClick={async () => { await clearChat(key); setTurns([]); }}>{t("chat.clear")}</button>}
          {live ? <button type="button" class="btn ghost" onClick={() => stop.current?.abort()}>{t("chat.stop")}</button> : <button class="btn" disabled={!q.trim()}>{t("chat.ask")}</button>}
        </div>
      </form>
      </>}
    </div>
  );
}

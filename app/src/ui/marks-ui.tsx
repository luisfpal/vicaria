// The reader's tools for marks: the selection bar, the sheet that edits one mark, and the marks panel.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { COLORS, NOTE_MAX, kindOf, type Color, type Mark, type Style } from "../core/marks";
import { updateMark, setNote, addTag, removeTag, removeMark, restoreMark, dismissConflicts, MarkError } from "../core/marks-io";
import { store, use, toast } from "./state";
import { busy } from "../core/busy";
import { t } from "../core/i18n";

// an unsaved note keeps an update from reloading the page
function useBusyWhile(on: boolean, why: string) { useEffect(() => (on ? busy(why) : undefined), [on, why]); }

const defaultLabels = (): Record<Color, string> => ({ yellow: t("marks.labelHighlight"), green: t("marks.labelIdea"), blue: t("marks.labelQuote"), pink: t("marks.labelQuestion"), purple: t("marks.labelWord"), orange: t("marks.labelImportant") });
// Only the reader's own names are stored; the defaults come from the interface language when shown, so they follow
// a change of language. (Older versions stored all six; a stored name equal to a default in either language is not kept.)
const DEFAULTS = new Set(["Highlight", "Idea", "Quote", "Question", "Word", "Important", "Subrayado", "Cita", "Pregunta", "Palabra", "Importante"]);
const own = (o: Partial<Record<Color, string>>) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string" && v && !DEFAULTS.has(v))) as Partial<Record<Color, string>>;
export const labels = store<Partial<Record<Color, string>>>(own((() => { try { return JSON.parse(localStorage.getItem("vic:labels") || "{}"); } catch { return {}; } })()));
export const fullLabels = (o: Partial<Record<Color, string>> = labels.get()): Record<Color, string> => ({ ...defaultLabels(), ...o });
export function setLabel(c: Color, name: string) {
  const n = { ...labels.get() }; const v = name.trim().slice(0, 40);
  if (v && v !== defaultLabels()[c]) n[c] = v; else delete n[c];
  labels.set(n); localStorage.setItem("vic:labels", JSON.stringify(n));
}
const fail = (e: unknown) => toast(e instanceof MarkError ? e.message.replace(/^./, c => c.toUpperCase()) : t("marks.saveFailed"));
const bytes = (s: string) => new TextEncoder().encode(s).length;

export function Swatches(p: { on?: Color; onPick: (c: Color) => void; size?: "s" | "m" }) {
  const L = fullLabels(use(labels));
  return <>{COLORS.map(c => <button key={c} class={`sw ${c} ${p.on === c ? "on" : ""}`} title={L[c]} aria-label={`${L[c]} (${c})`} aria-pressed={p.on === c} onClick={() => p.onPick(c)} />)}</>;
}

// keeps a centered popover fully on screen
export function useOnScreen(ref: { current: HTMLElement | null }, deps: unknown[]) {
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.left < 8) el.style.left = `${parseFloat(el.style.left) + 8 - r.left}px`;
    else if (r.right > innerWidth - 8) el.style.left = `${parseFloat(el.style.left) - (r.right - innerWidth + 8)}px`;
    if (r.top < 8) el.style.top = `${parseFloat(el.style.top) + 8 - r.top}px`;
  }, deps);
}
export function SelectionBar(p: { x: number; y: number; onColor: (c: Color) => void; onNote: () => void; onSticky: () => void; onBookmark: () => void; onCopy: () => void; onAsk?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useOnScreen(ref, [p.x, p.y]);
  return (
    <div ref={ref} class="popover seltools" dir="ltr" role="toolbar" aria-label={t("marks.selection")} style={{ left: p.x + "px", top: p.y + "px" }} onMouseDown={e => e.preventDefault()}>
      <Swatches onPick={p.onColor} />
      <span class="sep" />
      <button onClick={p.onNote}>{t("marks.note")}</button>
      <button onClick={p.onSticky}>{t("marks.sticky")}</button>
      <button onClick={p.onBookmark} aria-label={t("marks.bookmarkHere")}>{t("marks.bookmark")}</button>
      <button onClick={p.onCopy}>{t("marks.copy")}</button>
      {p.onAsk && <button onClick={p.onAsk}>{t("marks.ask")}</button>}
    </div>
  );
}

// Edit one mark. Every control writes at once (no Save for colors and toggles); the note saves on blur and Done.
export function MarkSheet(p: { m: Mark; x: number; y: number; focusNote?: boolean; onClose: () => void }) {
  const { m } = p;
  const [text, setText] = useState(m.note || "");
  const [tag, setTag] = useState("");
  const [name, setName] = useState(m.bookmark?.name || "");
  const ref = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const saved = useRef(m.note || ""); // what we last wrote; m.note lags until the mark list refreshes
  // reload the fields only when another note arrives; effects run after paint, so an unconditional reset on mount
  // could wipe what was typed in the first frame
  const shown = useRef(`${m.id}|${m.noteOp}`);
  useEffect(() => {
    const key = `${m.id}|${m.noteOp}`; if (key === shown.current) return; shown.current = key;
    setText(m.note || ""); setName(m.bookmark?.name || ""); saved.current = m.note || "";
  }, [m.id, m.noteOp]);
  useEffect(() => { if (p.focusNote) ta.current?.focus(); }, []);
  useLayoutEffect(() => { const el = ref.current; if (!el) return; const r = el.getBoundingClientRect(); if (r.bottom > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - 8 - r.height)}px`; });
  const used = bytes(text), near = used > NOTE_MAX * 0.9;
  useBusyWhile(text !== saved.current, "note");
  const saveNote = async (resolve = false) => { if (text === saved.current && !resolve) return; const was = saved.current; saved.current = text; try { await setNote(m, text, resolve); } catch (e) { saved.current = was; fail(e); } };
  const up = (set: Parameters<typeof updateMark>[1]) => updateMark(m, set).catch(fail);
  const k = kindOf(m);
  return (
    <div ref={ref} class="popover sheet" dir="ltr" role="dialog" aria-label={t("marks.editMark")} style={{ left: Math.min(Math.max(180, p.x), innerWidth - 180) + "px", top: p.y + "px" }}>
      {m.bookmark ? (
        <label class="field">{t("marks.bookmarkName")}<input value={name} maxLength={200} onInput={e => setName((e.target as HTMLInputElement).value)} onBlur={() => name !== m.bookmark!.name && up({ bookmark: { name } })} /></label>
      ) : (
        <div class="row swrow"><Swatches on={m.color} onPick={c => up({ color: c })} />
          <span class="styles">{(["fill", "underline", "strike"] as Style[]).map(s => <button key={s} class={`st ${s} ${(m.style || "fill") === s ? "on" : ""}`} aria-label={s} aria-pressed={(m.style || "fill") === s} disabled={!m.color} onClick={() => up({ style: s })}>{s === "fill" ? "A" : s === "underline" ? "U" : "S"}</button>)}</span>
        </div>
      )}
      {m.conflicts.length > 0 && (
        <div class="conflict" role="note">
          <b>{t("marks.alsoWritten")}</b>
          {m.conflicts.map(c => <blockquote key={c.op}>{c.text || <i>{t("marks.empty")}</i>}</blockquote>)}
          <div class="row">
            <button class="link" onClick={() => setText([text, ...m.conflicts.map(c => c.text)].filter(Boolean).join("\n\n"))}>{t("marks.combineBoth")}</button>
            <button class="link" onClick={() => dismissConflicts(m).catch(fail)}>{t("marks.keepThisOne")}</button>
          </div>
        </div>
      )}
      <textarea ref={ta} placeholder={k === "bookmark" ? t("marks.whyThisPlace") : t("marks.addNote")} value={text} rows={3} aria-label={t("marks.note")}
        onInput={e => setText((e.target as HTMLTextAreaElement).value)} onBlur={() => saveNote()} />
      {near && <small class={used > NOTE_MAX ? "danger" : "muted"}>{t("marks.kb", { used: Math.round(used / 1024), max: NOTE_MAX / 1024 })}</small>}
      <div class="row toggles">
        <button class={`chip ${m.loved ? "on" : ""}`} aria-pressed={!!m.loved} onClick={() => up({ loved: !m.loved })}>{t("marks.loved")}</button>
        {!m.bookmark && <button class={`chip ${m.sticky ? "on" : ""}`} aria-pressed={!!m.sticky} disabled={!m.sticky && !text.trim()} title={!text.trim() ? t("marks.writeNoteFirst") : ""}
          onClick={async () => { if (!m.sticky) await saveNote(); up({ sticky: m.sticky ? null : { side: "r", tint: m.color || "yellow" } }); }}>{t("marks.sticky")}</button>}
      </div>
      <div class="row tags">
        {m.tags.map(tg => <button key={tg} class="chip tag" aria-label={t("marks.removeTag", { tag: tg })} onClick={() => removeTag(m, tg).catch(fail)}>#{tg} ×</button>)}
        <input class="tagin" placeholder={t("marks.addTag")} value={tag} maxLength={64} onInput={e => setTag((e.target as HTMLInputElement).value)}
          onKeyDown={e => { if (e.key === "Enter" && tag.trim()) { addTag(m, tag).catch(fail); setTag(""); } }} />
      </div>
      <div class="row end">
        <button class="link danger" onClick={async () => { await removeMark(m).catch(fail); p.onClose(); toast(t("marks.removed", { kind: t(k === "bookmark" ? "marks.kindBookmark" : k === "highlight" ? "marks.kindHighlight" : "marks.kindNote") }), { action: { label: t("marks.undo"), run: () => { restoreMark(m).catch(fail); } } }); }}>{t("marks.remove")}</button>
        <button class="btn" onClick={async () => { await saveNote(m.conflicts.length > 0 && text !== saved.current); p.onClose(); }}>{t("marks.done")}</button>
      </div>
    </div>
  );
}

type Filter = "all" | Color | "notes" | "sticky" | "bookmarks" | "loved" | "unplaced";
const PAGE = 40; // a couple of screens; more load while scrolling (150 at once took 160 ms at 4x CPU with 2,000 marks)
export function MarksPanel(p: { book: string; marks: Mark[]; chapterOf: (s: number) => string; onPick: (m: Mark) => void; onEdit: (m: Mark) => void }) {
  const L = fullLabels(use(labels));
  const key = "vic:mf:" + p.book;
  const saved = JSON.parse(sessionStorage.getItem(key) || "{}") as { f?: Filter; n?: number; y?: number };
  const [f, setF] = useState<Filter>(saved.f || "all");
  const [n, setN] = useState(saved.n || PAGE);
  const [q, setQ] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const live = p.marks.filter(m => !m.gone);
  const counts: Partial<Record<Filter, number>> = { all: live.filter(m => m.at).length };
  for (const m of live) {
    if (!m.at) { counts.unplaced = (counts.unplaced || 0) + 1; continue; }
    if (m.color && !m.bookmark) counts[m.color] = (counts[m.color] || 0) + 1;
    if (m.note) counts.notes = (counts.notes || 0) + 1;
    if (m.sticky) counts.sticky = (counts.sticky || 0) + 1;
    if (m.bookmark) counts.bookmarks = (counts.bookmarks || 0) + 1;
    if (m.loved) counts.loved = (counts.loved || 0) + 1;
  }
  const ql = q.trim().toLowerCase();
  const shown = live.filter(m => f === "unplaced" ? !m.at : !!m.at && (f === "all" || (f === "notes" ? !!m.note : f === "sticky" ? !!m.sticky : f === "bookmarks" ? !!m.bookmark : f === "loved" ? !!m.loved : m.color === f && !m.bookmark)))
    .filter(m => !ql || ((m.at ?? m.lost)?.exact || "").toLowerCase().includes(ql) || (m.note || "").toLowerCase().includes(ql) || (m.bookmark?.name || "").toLowerCase().includes(ql) || m.tags.some(t => t.includes(ql)));
  // keep the filter, how far the list was loaded and where it was scrolled, so returning to it lands in place
  useLayoutEffect(() => { const sc = list.current?.parentElement; if (sc && saved.y) sc.scrollTop = saved.y; }, []);
  useEffect(() => () => { const sc = list.current?.parentElement; sessionStorage.setItem(key, JSON.stringify({ f, n, y: sc?.scrollTop || 0 })); });
  useEffect(() => {
    const sc = list.current?.parentElement; if (!sc) return;
    const on = () => { if (sc.scrollTop + sc.clientHeight > sc.scrollHeight - 400 && n < shown.length) setN(n + PAGE); };
    sc.addEventListener("scroll", on, { passive: true }); return () => sc.removeEventListener("scroll", on);
  }, [n, shown.length]);
  const chips: [Filter, string][] = [["all", t("marks.chipAll")], ...COLORS.filter(c => counts[c]).map(c => [c, L[c]] as [Filter, string]), ["notes", t("marks.chipNotes")], ["sticky", t("marks.chipSticky")], ["bookmarks", t("marks.chipBookmarks")], ["loved", t("marks.chipLoved")], ...(counts.unplaced ? [["unplaced", t("marks.chipUnplaced")] as [Filter, string]] : [])];
  return (
    <div class="marks">
      <div class="fchips" role="tablist">{chips.filter(([k]) => k === "all" || counts[k]).map(([k, label]) => <button key={k} role="tab" aria-selected={f === k} class={`chip ${f === k ? "on" : ""} ${(COLORS as readonly string[]).includes(k) ? "c-" + k : ""}`} onClick={() => { setF(k); setN(PAGE); }}>{label} <small>{counts[k] || 0}</small></button>)}</div>
      {live.length > 8 && <input type="search" class="mq" placeholder={t("marks.filterMarks")} aria-label={t("marks.filterMarks")} value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />}
      {!live.length && <p class="muted">{t("marks.emptyList")}</p>}
      {f === "unplaced" && <p class="muted">{t("marks.unplacedHelp")}</p>}
      <ul class="hits" ref={list}>
        {shown.slice(0, n).map(m => (
          <li key={m.id} class={kindOf(m)}>
            <button class="link" onClick={() => m.at ? p.onPick(m) : p.onEdit(m)}>
              <small>{m.at ? p.chapterOf(m.at.section) : t("marks.notPlaced")}{m.loved ? t("marks.lovedMark") : ""}{m.sticky ? t("marks.stickyMark") : ""}</small>
              {m.bookmark ? <span class="bm"><svg width="10" height="13" viewBox="0 0 16 18" aria-hidden="true"><path d="M3 1.5h10v15l-5-3.6-5 3.6z" fill="currentColor" /></svg> {m.bookmark.name || t("marks.bookmark")}</span> : <span class={`q ${m.color || "none"}`}>{((m.at ?? m.lost)?.exact || "").slice(0, 240)}</span>}
              {m.note && <em>{m.note.slice(0, 400)}</em>}
              {m.tags.length > 0 && <span class="tags">{m.tags.map(t => "#" + t).join(" ")}</span>}
            </button>
            <button class="icon more" aria-label={t("marks.edit")} onClick={() => p.onEdit(m)}>⋯</button>
          </li>
        ))}
      </ul>
      {f !== "unplaced" && f !== "all" && (COLORS as readonly string[]).includes(f) && <p class="muted small">{t("marks.renameColor")} <input class="lbl" value={L[f as Color]} onChange={e => setLabel(f as Color, (e.target as HTMLInputElement).value)} aria-label={t("marks.colorName")} /></p>}
    </div>
  );
}

// A new note or sticky note on a selection: written first, created on Save, so nothing empty is ever stored.
export function NoteDraft(p: { x: number; y: number; sticky: boolean; onSave: (text: string) => Promise<unknown>; onClose: () => void }) {
  const [text, setText] = useState("");
  const used = bytes(text);
  useBusyWhile(text.trim() !== "", "note");
  return (
    <div class="popover sheet" dir="ltr" role="dialog" aria-label={p.sticky ? t("marks.newSticky") : t("marks.newNote")} style={{ left: Math.min(Math.max(180, p.x), innerWidth - 180) + "px", top: p.y + "px" }}>
      <textarea autoFocus placeholder={p.sticky ? t("marks.stickyNote") : t("marks.note")} value={text} rows={4} aria-label={t("marks.note")} onInput={e => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) p.onSave(text).then(p.onClose, fail); }} />
      {used > NOTE_MAX * 0.9 && <small class={used > NOTE_MAX ? "danger" : "muted"}>{t("marks.kb", { used: Math.round(used / 1024), max: NOTE_MAX / 1024 })}</small>}
      <div class="row end"><button class="link" onClick={p.onClose}>{t("marks.cancel")}</button><button class="btn" disabled={!text.trim() || used > NOTE_MAX} onClick={() => p.onSave(text).then(p.onClose, fail)}>{t("marks.save")}</button></div>
    </div>
  );
}

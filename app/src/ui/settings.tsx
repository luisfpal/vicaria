import { useEffect, useState } from "preact/hooks";
import { books, library, use, toast, setLibrary, progressStore, store, BASE } from "./state";
import { listBooks, type LibraryBook } from "../core/read";
import { checkForUpdate, VERSION } from "./updates";
import { fullLabels } from "./marks-ui";
import { Devices } from "./sync-ui";
import { OnDevice } from "./ondevice";
import { WiserSettings } from "./wiser-settings";
import { ROUTES, getKey, setKey, hasKey, setModel, setActive, routeById, activeRoute, listModels, pickModel, stream, AiError, type Route } from "../ai/providers";
import { startConnect as orStart, pendingCode as orPending, finishConnect as orFinish } from "../ai/openrouter";
import { isNative } from "./nativeupdate";
import { Link } from "./app";
import { currentReport } from "./errors";
import { issueUrl } from "../core/feedback";
import { t, tparts, lang, setLang, LANGS, type Lang } from "../core/i18n";

const save = (blob: Blob, name: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
const mb = (n: number) => (n / 1e6).toFixed(n > 1e8 ? 0 : 1) + " MB";

export function Settings() {
  const bs = use(library);
  const [est, setEst] = useState<{ usage?: number; quota?: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    navigator.storage?.estimate?.().then(setEst).catch(() => {});
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
  }, [bs.length]);
  // a link to a part of Settings (#device, #ai) scrolls to it once the page is drawn
  useEffect(() => { const id = location.hash.slice(1); if (id) document.getElementById(id)?.scrollIntoView(); }, []);
  const day = new Date().toISOString().slice(0, 10);
  return (
    <section class="page settings">
      <h1>{t("settings.title")}</h1>
      <label class="row lang">{t("settings.language")}{" "}
        <select value={lang} onChange={e => setLang((e.target as HTMLSelectElement).value as Lang)}>
          {LANGS.map(l => <option key={l} value={l}>{{ en: "English", es: "Español" }[l]}</option>)}
        </select>
      </label>
      <h2>{t("settings.libraryHeading")}</h2>
      <p>{est?.usage != null ? t("settings.libraryUsed", { n: bs.length, size: mb(est.usage) }) : t("settings.library", { n: bs.length })}{" "}
        {persisted === true ? t("settings.kept") : persisted === false ? t("settings.mayClear") : ""}</p>
      {persisted === false && <button class="btn ghost" onClick={async () => setPersisted(await navigator.storage.persist())}>{t("settings.askKeep")}</button>}
      <Devices />
      <h2>{t("settings.backupHeading")}</h2>
      <p class="muted">{t("settings.backupBody")}</p>
      <div class="row">
        <button class="btn" onClick={async () => { try { save(await books.call<Blob>("backup"), `vicaria-backup-${day}.zip`); } catch (e) { toast(t("settings.backupFailed", { error: (e as Error).message })); } finally { progressStore.set(null); } }}>{t("settings.saveBackup")}</button>
        <label class="btn ghost">{t("settings.restoreBackup")}<input type="file" accept=".zip,application/zip" hidden onChange={async e => {
          const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
          try { const buf = await f.arrayBuffer(); const r = await books.call<{ books: number; ops: number }>("restore", [buf], [buf]); setLibrary(await listBooks()); toast(t("settings.restored", { books: r.books, ops: r.ops })); }
          catch (x) { toast((x as Error).message); } finally { progressStore.set(null); }
        }} /></label>
      </div>
      <h2>{t("settings.exportMarks")}</h2>
      <p class="muted">{t("settings.exportBody")}</p>
      <button class="btn ghost" onClick={async () => save(await books.call<Blob>("markdown", [fullLabels()]), `vicaria-highlights-${day}.zip`)}>{t("settings.exportMarks")}</button>
      <Previous />
      <AiKey />
      <WiserSettings />
      <OnDevice />
      <h2>{t("settings.booksHeading")}</h2>
      {bs.length ? <ul class="manage">{bs.map(b => <BookRow key={b.id} b={b} />)}</ul> : <p class="muted">{t("settings.noBooks")}</p>}
      <Removed />
      <h2>{t("settings.aboutHeading")}</h2>
      <p class="muted">{t("settings.about", { version: VERSION })}</p>
      <div class="row">
        <button class="btn ghost" onClick={async () => toast((await checkForUpdate()) ? t("settings.updating") : t("settings.latest"))}>{t("settings.checkUpdates")}</button>
        <a class="btn ghost" href={issueUrl(currentReport())} target="_blank" rel="noopener">{t("settings.feedback")}</a>
        <Link class="btn ghost" href="/privacy">{t("privacy.link")}</Link>
      </div>
      <BeforeUpdate />
    </section>
  );
}

function BookRow({ b }: { b: LibraryBook }) {
  const [sure, setSure] = useState(false);
  return <li><span><b>{b.title}</b> <span class="muted">{b.author} · {mb(b.size)}</span></span>
    {sure ? <span class="row"><button class="btn danger" onClick={() => removeWithUndo(b)}>{t("settings.remove")}</button><button class="link" onClick={() => setSure(false)}>{t("settings.cancel")}</button></span>
      : <button class="link" onClick={() => setSure(true)}>{t("settings.remove")}</button>}</li>;
}

export async function removeWithUndo(b: LibraryBook) {
  setLibrary(await books.call<LibraryBook[]>("trash", [b.id]));
  removedTick.set(removedTick.get() + 1);
  toast(t("settings.removed", { title: b.title }), { action: { label: t("settings.undo"), run: async () => { const r = await books.call<{ books: LibraryBook[] }>("restoreBook", [b.id]); setLibrary(r.books); removedTick.set(removedTick.get() + 1); } }, ms: 8000 });
}
const removedTick = store(0);
interface Trashed { id: string; title: string; author: string; at: number }
// Recently removed: books keep their file (and their marks) for 30 days
function Removed() {
  const tick = use(removedTick);
  const [l, setL] = useState<Trashed[]>([]);
  useEffect(() => { books.call<Trashed[]>("trashList").then(setL).catch(() => {}); }, [tick]);
  if (!l.length) return null;
  const left = (item: Trashed) => Math.max(1, 30 - Math.floor((Date.now() - item.at) / 86400_000));
  return <>
    <h2>{t("settings.recentlyRemoved")}</h2>
    <p class="muted">{t("settings.removedBody")}</p>
    <ul class="manage">{l.map(item => <li key={item.id}><span><b>{item.title}</b> <span class="muted">{item.author} · {t("settings.daysLeft", { n: left(item) })}</span></span>
      <span class="row"><button class="link" onClick={async () => { const r = await books.call<{ books: LibraryBook[] }>("restoreBook", [item.id]); setLibrary(r.books); removedTick.set(removedTick.get() + 1); toast(t("settings.bookBack", { title: item.title })); }}>{t("settings.restore")}</button>
      <button class="link danger" onClick={async () => { setL(await books.call<Trashed[]>("deleteForever", [item.id])); }}>{t("settings.deleteNow")}</button></span></li>)}</ul>
  </>;
}

interface Report { at: number; books: { old: string; title: string }[]; failed: { old: string; reason: string }[]; highlights: { total: number; placed: number; missed: { book: string; quote: string }[] } }
function Previous() {
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => { books.call<Report | null>("legacyReport").then(setR).catch(() => {}); }, []);
  if (!r) return null;
  const h = r.highlights;
  return <>
    <h2>{t("settings.previousHeading")}</h2>
    <p class="muted">{t("settings.previous", {
      date: new Date(r.at).toLocaleDateString(undefined, { dateStyle: "long" }),
      n: r.books.length,
      placed: h.placed,
      total: h.total,
      failed: r.failed.length ? " " + t("settings.previousMissing", { n: r.failed.length, names: r.failed.map(f => f.old).join(", ") }) : "",
    })}</p>
    {h.missed.length > 0 && <details><summary>{t("settings.missed", { n: h.missed.length })}</summary>
      <ul class="missed">{h.missed.map((m, i) => <li key={i}><b>{m.book}</b>: “{m.quote}”</li>)}</ul></details>}
  </>;
}

// The copy of the library saved before the last upgrade: brings back any change that went missing, adds nothing twice
function BeforeUpdate() {
  const [snap, setSnap] = useState<{ at: number } | null>(null);
  useEffect(() => { import("../core/snapshots").then(m => m.latestSnapshot()).then(setSnap).catch(() => {}); }, []);
  if (!snap) return null;
  const when = new Date(snap.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const [before, after] = tparts("settings.snapshot", "restore", { when });
  return (
    <p class="muted small">{before}<button class="link" onClick={async () => {
        const n = await (await import("../core/snapshots")).restoreLatest().catch(() => null);
        toast(n === null ? t("settings.badSnapshot") : n ? t("settings.broughtBack", { n }) : t("settings.nothingMissing"));
      }}>{t("settings.bringBack")}</button>{after}
    </p>
  );
}

// The reader's own key for asking about books, for any of the providers in ROUTES. It stays on this device: never
// synced, never in a backup.
function AiKey() {
  const [id, setId] = useState(() => activeRoute()?.route.id ?? ROUTES[0].id);
  const [, bump] = useState(0), again = () => bump(n => n + 1);
  const r = routeById(id)!, has = hasKey(id), using = activeRoute()?.route.id === id;
  const [val, setVal] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [state, setState] = useState<string>("");
  // coming back from OpenRouter's sign-in with a code in the address
  useEffect(() => {
    const code = orPending(); if (!code) return;
    setId("openrouter"); setState(t("settings.checking"));
    orFinish(code).then(k => { history.replaceState(history.state, "", `${BASE}/settings#ai`); if (k) { setKey("openrouter", k); setActive("openrouter"); setState(t("settings.keyAccepted", { name: "OpenRouter" })); again(); } else setState(t("settings.signInFailed")); });
  }, []);
  async function learnModels(route: Route, k: string) {
    const ids = await listModels(route, k).catch(() => []); setModels(ids);
    const pick = pickModel(ids, route.model, route.cheap);
    if (pick && pick !== route.model) { setModel(route.id, pick); again(); }
  }
  const check = async (k: string) => {
    const route = routeById(id)!;
    setState(t("settings.checking"));
    try {
      const now = route;
      await stream(now, k, [{ role: "user", content: "Reply with the single word OK." }], { maxTokens: 16 });
      setState(t("settings.keyAccepted", { name: r.name })); void learnModels(now, k); return true;
    }
    catch (e) { setState(e instanceof AiError ? e.message : t("settings.keyUnchecked")); return false; }
  };
  const add = async (k: string) => { if (await check(k)) { setKey(id, k); setActive(id); setVal(""); again(); } };
  return (
    <>
      <h2 id="ai">{t("settings.aiHeading")}</h2>
      <p class="muted">{t("settings.aiBody", { name: r.name })}</p>
      <label class="row">{t("settings.provider")} <select value={id} onChange={e => { setId((e.target as HTMLSelectElement).value); setVal(""); setState(""); setModels([]); }}>
        {ROUTES.slice(0, 2).map(x => <option key={x.id} value={x.id}>{hasKey(x.id) ? "✓ " : ""}{x.name}</option>)}
        <optgroup label={t("settings.direct")}>{ROUTES.slice(2).map(x => <option key={x.id} value={x.id}>{hasKey(x.id) ? "✓ " : ""}{x.name}</option>)}</optgroup>
      </select></label>
      {has ? (
        <div class="row">
          <span>{t("settings.keyAdded", { name: r.name })}{using ? ` ${t("settings.inUse")}` : ""}</span>
          {!using && <button class="btn ghost" onClick={() => { setActive(id); again(); }}>{t("settings.useThis")}</button>}
          <button class="btn ghost" onClick={() => check(getKey(id))}>{t("settings.checkKey")}</button>
          <button class="link danger" onClick={() => { setKey(id, ""); setState(""); again(); }}>{t("settings.removeKey")}</button>
        </div>
      ) : (
        <form class="row" onSubmit={e => { e.preventDefault(); const k = val.trim(); if (k) void add(k); }}>
          <input type="password" autocomplete="off" spellcheck={false} placeholder={t("settings.keyPlaceholder", { name: r.name })} aria-label={t("settings.keyPlaceholder", { name: r.name })} value={val} onInput={e => setVal((e.target as HTMLInputElement).value)} />
          <button class="btn" disabled={!val.trim()}>{t("settings.addKey")}</button>
          <a href={r.keyUrl} target="_blank" rel="noopener">{t("settings.getKey")}</a>
        </form>
      )}
      {id === "openrouter" && !has && !isNative() && <p><button class="btn ghost" onClick={() => void orStart(location.origin + BASE + "/settings")}>{t("settings.signInOpenRouter")}</button> <span class="muted small">{t("settings.signInBody")}</span></p>}
      {has && <label class="field">{t("settings.model")}
        <input type="text" list="aimodels" spellcheck={false} key={r.model} defaultValue={r.model} onBlur={e => { setModel(id, (e.target as HTMLInputElement).value); again(); }} />
        <datalist id="aimodels">{models.map(m => <option key={m} value={m} />)}</datalist>
      </label>}
      {state && <p class="muted small" role="status">{state}</p>}
    </>
  );
}

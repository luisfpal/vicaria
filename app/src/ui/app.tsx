import { useEffect, useLayoutEffect, useRef, useState, useErrorBoundary } from "preact/hooks";
import { route, use, go, toasts, dismiss, BASE, books, setLibrary, library, toast, progressStore } from "./state";
import { Library } from "./library";
import { applySyncedBg } from "./background";
import type { FunctionComponent } from "preact";
import { ErrorScreen } from "./errors";
import { listBooks } from "../core/read";
import { setupUpdates, afterOpen } from "./updates";
import { importFiles, ensureClassic, moveLegacy } from "./importer";
import { startSync, pickUpPairLink } from "./sync-ui";
import { t } from "../core/i18n";

// Screens other than the library and the book are their own files, so the first script stays small; they are
// fetched when the browser is idle after start-up (and cached by the service worker), so a tab opens at once.
function screen<P extends object = object>(load: () => Promise<FunctionComponent<P>>) {
  let C: FunctionComponent<P> | null = null, p: Promise<void> | null = null;
  const get = () => p ??= load().then(c => { C = c; }, e => { p = null; throw e; });
  // a file that cannot be fetched (offline before it was ever cached, or a new version replaced it) shows the error
  // screen with Reload instead of an empty page
  const S = (props: P) => {
    const [st, set] = useState(0);
    useEffect(() => { if (!C) get().then(() => set(1), () => set(2)); }, []);
    if (C) return <C {...props} />;
    return st === 2 ? <ErrorScreen title={t("errors.title")} body={t("errors.body")} problem="screen file not loaded" reload /> : null;
  };
  return Object.assign(S, { preload: () => get().catch(() => {}) });
}
// the reader too: the library's first paint does not wait for it, and main.tsx starts fetching it at once when the
// page opened is a book
const Reader = screen<{ id: string }>(() => import("./reader").then(m => m.Reader));
// what the first render needs in hand: on a book, the reader (so the page does not draw an empty frame first)
export const screenReady = (path: string) => /\/book\/[0-9a-f]{16}/.test(path) ? Reader.preload() : Promise.resolve();
const Discover = screen(() => import("./discover").then(m => m.Discover));
const Places = screen(() => import("./places").then(m => m.Places));
const Ideas = screen(() => import("./ideas").then(m => m.Ideas));
const Settings = screen(() => import("./settings").then(m => m.Settings));
const Wiser = screen(() => import("./wiser").then(m => m.Wiser));
const Privacy = screen(() => import("./privacy").then(m => m.Privacy));

export function Link(p: { href: string; class?: string; children: preact.ComponentChildren; label?: string }) {
  return <a href={BASE + p.href} class={p.class} aria-label={p.label} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); go(p.href); }}>{p.children}</a>;
}

export function App() {
  const r = use(route);
  const ts = use(toasts);
  const pr = use(progressStore);
  const [crash, resetCrash] = useErrorBoundary();
  const [noStorage, setNoStorage] = useState(false);
  useEffect(() => {
    pickUpPairLink();
    listBooks().then(bs => { if (bs.length || !library.get().length) setLibrary(bs); }).catch(() => setNoStorage(true)).finally(() => afterOpen());
    setupUpdates();
    const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback || ((f: () => void) => setTimeout(f, 300));
    idle(async () => {
      for (const S of [Reader, Ideas, Places, Discover, Settings, Privacy, Wiser]) void S.preload();
      books.warm();
      await moveLegacy();
      ensureClassic();
      books.call("refresh").then(bs => setLibrary(bs as never)).catch(() => {});
      applySyncedBg().catch(() => {});
      if (localStorage.getItem("vic:wiser:notify")) import("../wiser/notify").then(m => m.start()).catch(() => {}); // the optional daily reminder
      startSync(); // only on a paired device; loads the sync code then
      // models the reader asked for: an interrupted download resumes (the code loads only if there is one)
      if (localStorage.getItem("vicaria.models.wanted")) import("../models/client").then(m => m.checkModels()).catch(() => {});
      setTimeout(() => books.call("compact").catch(e => console.warn("compact", e)), 2000); // pack the mark log so big libraries stay fast to read, after start-up settles
    });
    const drop = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer?.files.length) importFiles([...e.dataTransfer.files]); };
    const over = (e: DragEvent) => e.preventDefault();
    addEventListener("drop", drop); addEventListener("dragover", over);
    // files opened with Vicaria from the system (installed app)
    const lq = (window as unknown as { launchQueue?: { setConsumer(f: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async p => { if (p.files?.length) importFiles(await Promise.all(p.files.map(f => f.getFile()))); });
    return () => { removeEventListener("drop", drop); removeEventListener("dragover", over); };
  }, []);
  useEffect(() => { if (pr && pr.done >= pr.total) setTimeout(() => progressStore.set(null), 800); }, [pr]);
  void toast;

  const m = r.match(/^\/book\/([0-9a-f]{16})/);
  // on a narrow phone, or with longer labels (Spanish) or a wide system font, the word mark gives its room to the
  // tabs; the open tab is kept in view if the tabs still have to scroll
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = bar.current, nav = el?.querySelector("nav"); if (!el || !nav) return;
    const fit = () => {
      el.classList.remove("tight", "tighter");
      if (nav.scrollWidth > nav.clientWidth + 1) el.classList.add("tight");
      if (nav.scrollWidth > nav.clientWidth + 1) el.classList.add("tighter");
      const on = nav.querySelector<HTMLElement>("a.on");
      if (on && (on.offsetLeft < nav.scrollLeft || on.offsetLeft + on.offsetWidth > nav.scrollLeft + nav.clientWidth)) nav.scrollLeft = on.offsetLeft - 8;
    };
    fit(); const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
  }, [r, !!m]);
  const known = r === "/" || r === "/index.html" || /^\/(discover|settings|places|ideas|privacy|wiser)(\/|$)/.test(r);
  const tab = m ? "read" : r.startsWith("/discover") ? "discover" : r.startsWith("/settings") ? "settings" : r.startsWith("/places") ? "places" : r.startsWith("/ideas") ? "ideas" : r.startsWith("/wiser") ? "wiser" : r.startsWith("/privacy") ? "privacy" : "library";
  return (
    <>
      {!m && (
        <header class="bar" ref={bar}>
          <Link href="/" class="brand"><b>Vicaria</b></Link>
          <nav>
            <Link href="/" class={tab === "library" ? "on" : ""}>{t("app.library")}</Link>
            <Link href="/ideas" class={tab === "ideas" ? "on" : ""}>{t("app.ideas")}</Link>
            <Link href="/places" class={tab === "places" ? "on" : ""}>{t("app.places")}</Link>
            <Link href="/discover" class={tab === "discover" ? "on" : ""}>{t("app.discover")}</Link>
            <Link href="/settings" class={tab === "settings" ? "on" : ""}>{t("app.settings")}</Link>
          </nav>
        </header>
      )}
      <main>
        {crash ? <ErrorScreen title={t("errors.title")} body={t("errors.body")} problem={String((crash as Error).message ?? crash)} reload onLibrary={resetCrash} />
          : noStorage ? <ErrorScreen title={t("errors.storageTitle")} body={t("errors.storageBody")} />
          : m ? <Reader id={m[1]} key={m[1]} /> : !known ? <ErrorScreen title={t("errors.notFoundTitle")} body={t("errors.notFoundBody")} />
          : tab === "wiser" ? <Wiser /> : tab === "privacy" ? <Privacy /> : tab === "discover" ? <Discover /> : tab === "settings" ? <Settings /> : tab === "places" ? <Places /> : tab === "ideas" ? <Ideas /> : <Library />}
      </main>
      {pr && <div class="progress" role="status">{pr.step === "backup" ? t("app.progressBackup", { done: pr.done, total: pr.total }) : pr.step === "restore" ? t("app.progressRestore", { done: pr.done, total: pr.total }) : pr.step === "legacy" ? t("app.progressLegacy", { done: pr.done, total: pr.total }) : t("app.progressWorking", { done: pr.done, total: pr.total })}</div>}
      <div class="toasts" aria-live="polite">
        {ts.map(item => <div class="toast" key={item.id}><span>{item.text}</span>{item.action && <button onClick={() => { item.action!.run(); dismiss(item.id); }}>{item.action.label}</button>}<button class="x" aria-label={t("app.dismiss")} onClick={() => dismiss(item.id)}>×</button></div>)}
      </div>
    </>
  );
}

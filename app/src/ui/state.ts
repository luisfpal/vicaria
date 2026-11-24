// App state shared by screens: the library list, reader settings, toasts, routing. Small on purpose.
import { useEffect, useState } from "preact/hooks";
import type { LibraryBook } from "../core/read";
import { client } from "../workers/rpc";

export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ---- tiny observable ----
export function store<T>(initial: T) {
  let v = initial; const subs = new Set<(v: T) => void>();
  return {
    get: () => v,
    set(n: T) { v = n; subs.forEach(f => f(v)); },
    sub(f: (v: T) => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export function use<T>(s: ReturnType<typeof store<T>>): T {
  const [v, set] = useState(s.get());
  useEffect(() => s.sub(set), [s]);
  return v;
}

// ---- library (snapshot in localStorage so the first paint never waits for IndexedDB) ----
import { forgetBook } from "./bookcache";
const SNAP = "vic:lib1";
const readSnap = (): LibraryBook[] => { try { return JSON.parse(localStorage.getItem(SNAP) || "[]"); } catch { return []; } };
export const library = store<LibraryBook[]>(readSnap());
export function setLibrary(books: LibraryBook[]) {
  const now = new Map(books.map(b => [b.id, b.v]));
  for (const b of library.get()) if (now.get(b.id) !== b.v) forgetBook(b.id); // reparsed or removed
  library.set(books);
  try { localStorage.setItem(SNAP, JSON.stringify(books)); } catch { /* storage full: the snapshot is only a speed-up */ }
}
export const lastOpened = store<Record<string, number>>(JSON.parse(localStorage.getItem("vic:opened") || "{}"));
export const progress = store<Record<string, number>>(JSON.parse(localStorage.getItem("vic:progress") || "{}"));
export function setProgress(id: string, f: number) {
  const r = Math.round(f * 1000) / 1000; if (progress.get()[id] === r) return;
  const m = { ...progress.get(), [id]: r }; progress.set(m);
  try { localStorage.setItem("vic:progress", JSON.stringify(m)); } catch { /* storage full: the bar is a courtesy */ }
}
export function markOpened(id: string) { const m = { ...lastOpened.get(), [id]: Date.now() }; lastOpened.set(m); localStorage.setItem("vic:opened", JSON.stringify(m)); }

// ---- reader settings ----
export interface ReaderPrefs { theme: "auto" | "light" | "sepia" | "dark"; font: "serif" | "sans"; size: number; leading: number; width: number; justify: boolean; pdf?: "page" | "text" }
const DEFAULT_PREFS: ReaderPrefs = { theme: "auto", font: "serif", size: 19, leading: 1.6, width: 38, justify: false };
export const prefs = store<ReaderPrefs>({ ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("vic:prefs") || "{}") });
export function setPrefs(p: Partial<ReaderPrefs>) { const n = { ...prefs.get(), ...p }; prefs.set(n); localStorage.setItem("vic:prefs", JSON.stringify(n)); applyPrefs(n); }
export function applyPrefs(p = prefs.get()) {
  const r = document.documentElement;
  r.dataset.theme = p.theme === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p.theme;
  r.style.setProperty("--size", p.size + "px"); r.style.setProperty("--leading", String(p.leading)); r.style.setProperty("--measure", p.width + "em");
  r.style.setProperty("--pdfzoom", String(Math.max(1, p.size / 19))); // a larger text size zooms PDF pages
  r.dataset.font = p.font; r.dataset.justify = String(p.justify);
}

// ---- toasts ----
export interface Toast { id: number; text: string; action?: { label: string; run: () => void }; sticky?: boolean }
export const toasts = store<Toast[]>([]);
let tid = 0;
export function toast(text: string, opts: { action?: Toast["action"]; sticky?: boolean; ms?: number } = {}) {
  const t: Toast = { id: ++tid, text, ...opts };
  toasts.set([...toasts.get().filter(x => x.text !== text), t]); // the same message twice shows once, refreshed
  if (!opts.sticky) setTimeout(() => dismiss(t.id), opts.ms ?? 4000);
  return t.id;
}
export const dismiss = (id: number) => toasts.set(toasts.get().filter(t => t.id !== id));

// ---- routing (History API under BASE) ----
// arriving from the site's 404 page with the route in ?r= (a deep link opened before the app was installed)
{ const r = new URLSearchParams(location.search).get("r"); if (r && r.startsWith("/") && !r.startsWith("//")) history.replaceState(null, "", BASE + r); }
export const route = store<string>(path());
function path() { const p = location.pathname; return (p.startsWith(BASE) ? p.slice(BASE.length) : p) || "/"; }
export function go(to: string, replace = false) {
  const url = BASE + to;
  if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
  route.set(path() + "");
  if (!replace) window.scrollTo(0, 0);
}
addEventListener("popstate", () => route.set(path()));

// ---- worker ----
export const books = client(() => new Worker(new URL("../workers/books.worker.ts", import.meta.url), { type: "module" }),
  p => progressStore.set(p as { step: string; done: number; total: number }));
export const progressStore = store<{ step: string; done: number; total: number } | null>(null);

export const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export function mark(name: string) { try { performance.mark(name); } catch { /* old browsers */ } }

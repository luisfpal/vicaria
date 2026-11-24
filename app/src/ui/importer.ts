import { books, setLibrary, toast, go, BASE, progressStore, setPrefs } from "./state";
import { listBooks, type LibraryBook } from "../core/read";
import { busy, whileBusy } from "../core/busy";
import { t } from "../core/i18n";

export async function importFiles(files: File[], open = files.length === 1) {
  const done = busy("import");
  try { return await importAll(files, open); } finally { done(); }
}
async function importAll(files: File[], open: boolean) {
  let last: LibraryBook | null = null;
  for (const f of files) {
    if (!/\.(epub|pdf)$/i.test(f.name) && f.type !== "application/epub+zip" && f.type !== "application/pdf") { toast(t("importer.notBook", { name: f.name })); continue; }
    const id = toast(t("importer.adding", { name: f.name.replace(/\.(epub|pdf)$/i, "") }), { sticky: true });
    try {
      const buf = await f.arrayBuffer();
      last = await books.call<LibraryBook>("importFile", [buf, f.name], [buf]);
      setLibrary(await listBooks());
      persist();
    } catch (e) { toast(t("importer.couldNotAdd", { name: f.name, error: (e as Error).message }), { ms: 8000 }); }
    finally { const { dismiss } = await import("./state"); dismiss(id); }
  }
  if (last && open) go(`/book/${last.id}`);
  return last;
}

export async function importUrl(url: string, name: string, open = true) {
  const id = toast(t("importer.adding", { name }), { sticky: true });
  try {
    const b = await whileBusy("import", () => books.call<LibraryBook>("importUrl", [url]));
    setLibrary(await listBooks()); persist();
    if (open) go(`/book/${b.id}`);
    return b;
  } finally { const { dismiss } = await import("./state"); dismiss(id); }
}

// The 0.x app on this device: its books, highlights, positions and cards move over in the background the first
// time, and again whenever the 0.x app changed something (it keeps working side by side until it is retired).
export interface LegacyResult { first: boolean; report: { books: { id: string }[]; highlights: { total: number; placed: number }; reader: Record<string, unknown> | null } }
export async function moveLegacy(): Promise<LegacyResult | null> {
  try {
    const r = await whileBusy("legacy", () => books.call<LegacyResult | null>("legacy"));
    progressStore.set(null);
    if (!r) return null;
    setLibrary(await listBooks());
    if (r.report.books.length) localStorage.setItem("vic:classic", "done"); // their own library replaces the starter classic
    if (r.first) {
      const rp = r.report.reader;
      if (rp && !localStorage.getItem("vic:prefs")) {
        const theme = ["light", "sepia", "dark"].includes(String(rp.theme)) ? rp.theme as "light" | "sepia" | "dark" : undefined;
        const font = rp.font === "sans" ? "sans" as const : rp.font === "serif" ? "serif" as const : undefined;
        const size = typeof rp.size === "number" && rp.size >= 12 && rp.size <= 40 ? rp.size : undefined;
        setPrefs({ ...(theme && { theme }), ...(font && { font }), ...(size && { size }) });
      }
      const n = r.report.books.length, h = r.report.highlights;
      if (n) toast(t("importer.moved", { n, h: h.placed }) + (h.placed < h.total ? " " + t("importer.movedSome", { n: h.total - h.placed }) : ""));
    }
    return r;
  } catch (e) { progressStore.set(null); console.warn("moving the previous library failed:", e); return null; }
}

// A classic waits on the shelf the first time. It is imported in the background after the first frame.
export const CLASSIC = { id: "", title: "Meditations", author: "Marcus Aurelius", url: `${BASE}/classics/meditations.epub` };
let classic: Promise<LibraryBook | null> | null = null;
export function ensureClassic(): Promise<LibraryBook | null> {
  if (localStorage.getItem("vic:classic") === "done") return Promise.resolve(null);
  return classic ??= books.call<LibraryBook>("importUrl", [new URL(CLASSIC.url, location.href).href]).then(async b => {
    localStorage.setItem("vic:classic", "done"); localStorage.setItem("vic:classic-id", b.id);
    setLibrary(await listBooks()); return b;
  }).catch(e => { console.warn("the starter book did not import:", e); classic = null; return null; });
}

let asked = false;
export async function persist() {
  if (asked || !navigator.storage?.persist) return; asked = true;
  try { await navigator.storage.persist(); } catch { /* not granted */ }
}

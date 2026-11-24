// The page's side of search by meaning: passages for a question (empty until the model and the book's vectors are
// there, so BM25 answers alone), and embedding the open book in the background.
import { client } from "../workers/rpc";
import { progressOf, checkModels, onProgress } from "./client";

export type EmbedProgress = { book: string; done: number; total: number };
const books = new Map<string, EmbedProgress>(), subs = new Set<() => void>();
const w = client(() => new Worker(new URL("../workers/embed.worker.ts", import.meta.url), { type: "module" }), p => { const e = p as EmbedProgress; books.set(e.book, e); for (const s of subs) s(); });
export const searchReady = () => progressOf("search")?.status === "done";
export const embedded = (book: string) => books.get(book);
export function onEmbed(f: () => void) { subs.add(f); return () => subs.delete(f); }

// passage ids by meaning, best first; gives up (and leaves the question to BM25) if it takes longer than `ms`
export async function byMeaning(book: string, question: string, ms = 3000): Promise<string[]> {
  if (!searchReady()) return [];
  const r = w.call<{ id: string }[]>("search", [book, question, 12]).then(x => x.map(y => y.id)).catch(() => []);
  return Promise.race([r, new Promise<string[]>(ok => setTimeout(() => ok([]), ms))]);
}
let open: { book: string; section: number } | null = null;
export function embedInBackground(book: string, section: number) {
  open = { book, section };
  if (!searchReady()) return;
  w.call<EmbedProgress>("status", [book]).then(s => { books.set(book, { ...s, book }); for (const f of subs) f(); if (s.done < s.total) return w.call("embedBook", [book, section]); }).catch(() => {});
}
// the model finished downloading while a book is open: start on it
void checkModels();
onProgress(() => { if (open && searchReady() && !books.has(open.book)) embedInBackground(open.book, open.section); });

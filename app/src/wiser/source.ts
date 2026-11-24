// What the features may draw from, built from the folded marks and the library: the reader's highlights and notes
// (clipped, newest 3,000) and, per book, its tags and its cluster in the Ideas graph. Runs in the books worker.
import type { Mark } from "../core/marks";
import type { LibraryBook } from "../core/read";
import { bookStats, ideaBooks, graphOf } from "../core/ideas";
import type { Source } from "./pick";

export const MAX_ITEMS_KEPT = 3000;
const clip = (s: string, n: number) => s.length <= n ? s : s.slice(0, n);
export function sourceOf(marks: Mark[], lib: LibraryBook[]): Source {
  const by = new Map(lib.map(b => [b.id, b])), live = marks.filter(m => !m.gone && by.has(m.book));
  const items = live.filter(m => m.at && ((m.at.exact && (m.color || m.note)) || m.note)).map(m => {
    const b = by.get(m.book)!, quote = m.at!.exact || "";
    return { id: m.id, book: m.book, title: b.title, author: b.author, text: clip((quote || m.note || "").replace(/\s+/g, " ").trim(), 400), note: quote ? clip((m.note || "").replace(/\s+/g, " ").trim(), 300) : "", tags: m.tags.slice(0, 6), made: m.made };
  }).filter(c => c.text).sort((a, b) => b.made - a.made || (a.id < b.id ? -1 : 1)).slice(0, MAX_ITEMS_KEPT);
  const ib = ideaBooks(lib, bookStats(marks)), g = graphOf(ib);
  return { items, books: ib.map((b, i) => ({ id: b.id, title: b.title, author: b.author, tags: b.tags, marks: b.marks, cluster: g.cluster[i] ?? 0 })) };
}

// The Ideas page's data: books with what the reader left in them (marks, tags), a search that answers in a few
// milliseconds at 1,000 books, groups for the list, and the book graph (shared tags and authors, clusters).
// Everything here is pure; the worker folds the marks and the page draws.
import type { Mark } from "./marks";
import type { LibraryBook } from "./read";

export interface BookStat { n: number; tags: string[] } // marks in the book; tags by how often they are used, most first
export interface IdeaBook { id: string; title: string; author: string; words: number; marks: number; tags: string[]; topic: string; key: string }
export const NO_TOPIC = "No topic yet";
const TAGS_KEPT = 12;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// per book: how many marks and which tags, most used first (ties alphabetical, so every device agrees)
export function bookStats(marks: Mark[]): Record<string, BookStat> {
  const count = new Map<string, number>(), tags = new Map<string, Map<string, number>>();
  for (const m of marks) {
    if (m.gone) continue;
    count.set(m.book, (count.get(m.book) ?? 0) + 1);
    if (!m.tags.length) continue;
    let t = tags.get(m.book); if (!t) tags.set(m.book, t = new Map());
    for (const x of m.tags) t.set(x, (t.get(x) ?? 0) + 1);
  }
  const out: Record<string, BookStat> = {};
  for (const [b, n] of count) out[b] = { n, tags: [...(tags.get(b) ?? [])].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, TAGS_KEPT).map(x => x[0]) };
  return out;
}

export function ideaBooks(lib: LibraryBook[], stats: Record<string, BookStat>): IdeaBook[] {
  return lib.map(b => {
    const s = stats[b.id];
    return { id: b.id, title: b.title, author: b.author, words: b.words, marks: s?.n ?? 0, tags: s?.tags ?? [], topic: s?.tags[0] ?? NO_TOPIC, key: fold(`${b.title} ${b.author} ${(s?.tags ?? []).join(" ")}`) };
  });
}

// Search: every word typed must appear in the title, the author or a tag. One pass over prefolded strings.
export function search(bs: IdeaBook[], q: string): IdeaBook[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return bs;
  return bs.filter(b => { for (const w of words) if (!b.key.includes(w)) return false; return true; });
}

export type GroupBy = "title" | "author" | "topic";
export type Row = { head: string; n: number } | { book: IdeaBook };
const lastName = (a: string) => fold(a.split(" ").pop() || "");
const sortTitle = (b: IdeaBook) => fold(b.title).replace(/^(the|a|an) /, "");
const cmp = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;

// The list as rows: books sorted by title, or under headings by author or topic (headings alphabetical, "No topic
// yet" last, books by title inside each).
export function rows(bs: IdeaBook[], by: GroupBy): Row[] {
  const sorted = bs.slice().sort((a, b) => cmp(sortTitle(a), sortTitle(b)));
  if (by === "title") return sorted.map(book => ({ book }));
  const groups = new Map<string, IdeaBook[]>();
  for (const b of sorted) { const g = by === "author" ? b.author || "Unknown author" : b.topic; const l = groups.get(g); if (l) l.push(b); else groups.set(g, [b]); }
  const names = [...groups.keys()].sort((a, b) => a === NO_TOPIC ? 1 : b === NO_TOPIC ? -1 : by === "author" ? cmp(lastName(a), lastName(b)) || cmp(a, b) : cmp(fold(a), fold(b)));
  return names.flatMap(g => [{ head: g, n: groups.get(g)!.length } as Row, ...groups.get(g)!.map(book => ({ book }))]);
}

// Virtual list: the top offset of each row (heads are shorter than books) and the rows that cross the screen.
export const ROW_BOOK = 60, ROW_HEAD = 38;
export function offsets(rs: Row[]): { top: Float64Array; total: number } {
  const top = new Float64Array(rs.length + 1);
  for (let i = 0; i < rs.length; i++) top[i + 1] = top[i] + ("head" in rs[i] ? ROW_HEAD : ROW_BOOK);
  return { top, total: top[rs.length] };
}
export function visibleRange(top: Float64Array, from: number, to: number, spare = 6): [number, number] {
  const n = top.length - 1;
  const at = (y: number) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (top[m] <= y) lo = m; else hi = m - 1; } return lo; };
  return [Math.max(0, at(Math.max(0, from)) - spare), Math.min(n, at(Math.max(0, to)) + 1 + spare)];
}

// ---- graph ----
export interface GraphData { ids: string[]; edges: [number, number, number][]; cluster: number[]; clusters: { name: string; size: number }[] }
const RING = 2; // each book links to the next two that share a tag (or author): enough to hold a group together, never n squared
const BIG_GROUP = 400; // a tag or author shared by this many books says nothing about any pair of them

// Books are nodes. Two books are joined when they share a tag or an author; the weight is how many things they
// share. Books with a tag in common are ordered by id and each joins the next RING of them, so a tag on 500 books
// makes 1,000 edges, not 125,000.
export function graphOf(bs: IdeaBook[]): GraphData {
  const ids = bs.map(b => b.id);
  const byThing = new Map<string, number[]>();
  const add = (k: string, i: number) => { const l = byThing.get(k); if (l) l.push(i); else byThing.set(k, [i]); };
  bs.forEach((b, i) => { for (const t of b.tags) add("t:" + t, i); if (b.author) add("a:" + b.author, i); });
  const w = new Map<number, number>();
  const N = bs.length;
  for (const l of byThing.values()) {
    if (l.length < 2 || l.length > BIG_GROUP) continue;
    l.sort((x, y) => x - y);
    for (let i = 0; i < l.length; i++) for (let j = 1; j <= RING && i + j < l.length; j++) { const k = l[i] * N + l[i + j]; w.set(k, (w.get(k) ?? 0) + 1); }
  }
  const edges: [number, number, number][] = [...w].sort((x, y) => x[0] - y[0]).map(([k, v]) => [Math.floor(k / N), k % N, v]);
  const cluster = communities(N, edges);
  // name each cluster by the tag most of its books carry
  const sizes = new Map<number, number>(), tagN = new Map<number, Map<string, number>>();
  cluster.forEach((c, i) => {
    sizes.set(c, (sizes.get(c) ?? 0) + 1);
    let m = tagN.get(c); if (!m) tagN.set(c, m = new Map());
    if (bs[i].tags[0]) m.set(bs[i].tags[0], (m.get(bs[i].tags[0]) ?? 0) + 1);
  });
  const order = [...sizes.keys()].sort((a, b) => sizes.get(b)! - sizes.get(a)! || a - b), renum = new Map(order.map((c, i) => [c, i]));
  const clusters = order.map(c => { const t = [...(tagN.get(c) ?? [])].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]; return { name: t?.[0] ?? NO_TOPIC, size: sizes.get(c)! }; });
  return { ids, edges, cluster: cluster.map(c => renum.get(c)!), clusters };
}

// Label propagation: every node takes the label with the most edge weight around it. Fixed order and ties to the
// smallest label, so the same library always gives the same clusters.
export function communities(n: number, edges: [number, number, number][], rounds = 12): number[] {
  const nb: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [a, b, w] of edges) { nb[a].push([b, w]); nb[b].push([a, w]); }
  const label = Array.from({ length: n }, (_, i) => i);
  for (let r = 0; r < rounds; r++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (!nb[i].length) continue;
      const sum = new Map<number, number>();
      for (const [j, w] of nb[i]) sum.set(label[j], (sum.get(label[j]) ?? 0) + w);
      let best = label[i], bw = sum.get(label[i]) ?? 0;
      for (const [l, s] of sum) if (s > bw || (s === bw && l < best)) { best = l; bw = s; }
      if (best !== label[i]) { label[i] = best; moved++; }
    }
    if (!moved) break;
  }
  return label;
}

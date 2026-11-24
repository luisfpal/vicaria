// Choosing today's thought without a model: which tier can run, the spaced repetition and serendipity weighting that
// picks a highlight, the lattice thought, and the bundled rotation. Pure: time and randomness come in as arguments.
import type { BundledThought, Thought } from "./data";

export interface Cand { id: string; book: string; title: string; author: string; text: string; note: string; tags: string[]; made: number }
export interface SrcBook { id: string; title: string; author: string; tags: string[]; marks: number; cluster: number }
export interface Source { items: Cand[]; books: SrcBook[] }
export type Seen = Record<string, { n: number; last: number }>; // times shown and when, per highlight or bundled id
export type Tier = "ai" | "mine" | "ideas" | "bundled";
const DAY = 86_400_000;

// A small seeded generator so a day's pick is the same on every open and every test run.
export function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed: string): () => number {
  let a = hash(seed) || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Weight of a candidate: (1 + days since it was last shown) / 2^times shown, so what was just surfaced sinks for a long
// time and what was never shown rises with its age; a note of the reader's own counts half again; a random factor in
// [0.75, 1.25] breaks ties and adds serendipity. Never shown: counted from when it was made.
export function weight(c: Cand, seen: Seen, now: number, r: number): number {
  const s = seen[c.id];
  const days = Math.max(0, (now - (s ? s.last : c.made)) / DAY);
  return (1 + days) / 2 ** (s?.n ?? 0) * (c.note ? 1.5 : 1) * (0.75 + r * 0.5);
}
// n distinct candidates, drawn by weight without replacement
export function sample(items: Cand[], seen: Seen, n: number, now: number, rand: () => number): Cand[] {
  const pool = items.map(c => ({ c, w: weight(c, seen, now, rand()) })), out: Cand[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let at = rand() * total, i = 0;
    for (; i < pool.length - 1; i++) { at -= pool[i].w; if (at <= 0) break; }
    out.push(pool[i].c); pool.splice(i, 1);
  }
  return out;
}
// the AI needs a spread, not the top: items from different books first
export function spread(picked: Cand[]): Cand[] {
  const seenBook = new Set<string>(), first: Cand[] = [], rest: Cand[] = [];
  for (const c of picked) (seenBook.has(c.book) ? rest : first).push(c), seenBook.add(c.book);
  return [...first, ...rest];
}

const tagged = (s: Source) => s.books.filter(b => b.tags.length);
const bridgeable = (s: Source) => tagged(s).length >= 2;
export function tierOf(s: Source, hasAi: boolean): Tier {
  if (s.books.length < 2) return "bundled"; // cold start: one book or none
  if (hasAi && (s.items.length || bridgeable(s))) return "ai";
  if (s.items.length) return "mine";
  if (bridgeable(s)) return "ideas";
  return "bundled";
}

export function seenAfter(seen: Seen, ids: string[], now: number, cap = 5000): Seen {
  const out = { ...seen };
  for (const id of ids) out[id] = { n: (out[id]?.n ?? 0) + 1, last: now };
  const keys = Object.keys(out);
  if (keys.length > cap) for (const k of keys.sort((a, b) => out[a].last - out[b].last).slice(0, keys.length - cap)) delete out[k];
  return out;
}

const clip = (s: string, n: number) => s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
// tier 2: one of the reader's own highlights, shown as it was written, with their note as the line to act on
export function highlightThought(c: Cand, day: string, now: number): Thought {
  return { id: `h-${c.id}`, text: clip(c.text, 400), ...(c.note ? { act: clip(c.note, 300) } : {}), by: c.author || undefined, from: c.title, src: "mine", day, made: now };
}
// tier 3: two books from different clusters (else two tags of one), joined by a question. `say` formats the sentence.
export type Say = (key: "ideas.bridge" | "ideas.pair", args: Record<string, string>) => string;
export function latticeThought(s: Source, day: string, now: number, rand: () => number, say: Say): Thought | null {
  const ts = tagged(s); if (ts.length < 2) return null;
  const a = ts[Math.floor(rand() * ts.length)];
  const others = ts.filter(b => b.id !== a.id && b.cluster !== a.cluster), pool = others.length ? others : ts.filter(b => b.id !== a.id);
  const b = pool[Math.floor(rand() * pool.length)];
  const ta = a.tags[Math.floor(rand() * a.tags.length)], tb = b.tags.filter(x => x !== ta)[Math.floor(rand() * Math.max(1, b.tags.filter(x => x !== ta).length))] ?? b.tags[0];
  if (ta === tb) return { id: `l-${day}`, text: say("ideas.pair", { a: ta, bookA: a.title, bookB: b.title }), from: `${a.title} · ${b.title}`, src: "ideas", day, made: now };
  return { id: `l-${day}`, text: say("ideas.bridge", { a: ta, bookA: a.title, b: tb, bookB: b.title }), from: `${a.title} · ${b.title}`, src: "ideas", day, made: now };
}
// cold start: among the bundled lines shown least often (so none repeats until all were shown), one chosen by the date
export function bundledPick(list: BundledThought[], seen: Seen, day: string): BundledThought {
  const least = Math.min(...list.map(b => seen[b.id]?.n ?? 0));
  return list.filter(b => (seen[b.id]?.n ?? 0) === least).sort((x, y) => hash(x.id + day) - hash(y.id + day))[0];
}
export function bundledThought(b: BundledThought, day: string, now: number): Thought {
  return { id: `b-${b.id}`, text: b.text, act: b.act, by: b.by, from: b.work, src: "bundled", day, made: now };
}

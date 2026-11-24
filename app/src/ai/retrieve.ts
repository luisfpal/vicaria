// Which passages of a book go to the model. BM25 over the book's passages (no index kept: a book has a few thousand
// passages and scoring them takes milliseconds), limited to what the reader has read unless they ask for the whole
// book, plus the passages around where they are. Each passage is cited by its id "section.block" (its first block).
import type { Passage } from "../core/types";

export interface Place { section: number; block: number }
export const cite = (p: Passage) => `${p.section}.${p.b0}`;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const STOP = new Set(("a an and are as at be but by for from has have he her his i if in into is it its me my not of on or our she so that the their them they this to was we were what when which who why will with you your " +
  "al como con de del el ella en es esta este la las lo los mas me mi no o para pero por que se sin su sus te tu un una y ya").split(" "));
export const terms = (s: string) => fold(s).match(/[\p{L}\p{N}]+/gu)?.filter(w => w.length > 1 && !STOP.has(w)) ?? [];

export function readSoFar(ps: Passage[], upTo?: Place): Passage[] {
  if (!upTo) return ps;
  return ps.filter(p => p.section < upTo.section || (p.section === upTo.section && p.b0 <= upTo.block));
}

// BM25 (k1 1.2, b 0.75) of each passage for the query; returns the top k with scores
export function bm25(ps: Passage[], query: string, k = 8): { p: Passage; score: number }[] {
  const q = [...new Set(terms(query))]; if (!q.length || !ps.length) return [];
  const docs = ps.map(p => terms(`${p.chapter} ${p.text}`));
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length, out: { p: Passage; score: number }[] = [];
  docs.forEach((d, i) => {
    let s = 0; const tf = new Map<string, number>();
    for (const t of d) if (df.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, f] of tf) { const n = df.get(t)!; s += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * d.length / avg)); }
    if (s > 0) out.push({ p: ps[i], score: s });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

export interface Scope { mode: "chapter" | "book"; whole?: boolean; upTo?: Place; selection?: { section: number; block: number; text: string } }
const CHARS_MAX = 60_000; // about 15,000 tokens of book text per question

// The passages for one question, in book order, within a size budget. Chapter mode: the chapter read so far comes
// first (whole chapter if it fits), then the best matches elsewhere. Book mode: the best matches, and the passages
// around the reader's place. A selection always brings its own passage and its neighbours. byMeaning: passage ids
// ranked by on-device embeddings, when the book has them; their best 6 go before the BM25 matches (in the eval, the
// top 6 by meaning plus the top 2 by BM25 found the right passage for 97 to 100% of questions, BM25 alone 50%).
export function contextFor(all: Passage[], question: string, s: Scope, byMeaning: string[] = []): Passage[] {
  const pool = s.whole ? all : readSoFar(all, s.upTo);
  const picked = new Map<string, Passage>(); let size = 0;
  const add = (p?: Passage) => { if (!p || picked.has(p.id) || size + p.text.length > CHARS_MAX) return; picked.set(p.id, p); size += p.text.length; };
  if (s.selection) {
    const i = all.findIndex(p => p.section === s.selection!.section && p.b0 <= s.selection!.block && s.selection!.block <= p.b1);
    if (i >= 0) { add(all[i]); if (s.whole || i === 0 || pool.includes(all[i - 1])) add(all[i - 1]); if (pool.includes(all[i + 1])) add(all[i + 1]); }
  }
  const here = s.selection?.section ?? s.upTo?.section;
  if (s.mode === "chapter" && here !== undefined) {
    const ch = pool.filter(p => p.section === here);
    const chSize = ch.reduce((n, p) => n + p.text.length, 0);
    if (chSize <= CHARS_MAX * 0.7) ch.forEach(add);
    else for (const { p } of bm25(ch, question, 12)) add(p);
  }
  if (byMeaning.length) {
    const inPool = new Map(pool.map(p => [p.id, p]));
    for (const id of byMeaning.filter(id => inPool.has(id)).slice(0, 6)) add(inPool.get(id));
  }
  for (const { p } of bm25(pool, `${question} ${s.selection?.text ?? ""}`, 16)) add(p);
  if (s.mode === "book" && s.upTo) { const near = pool.filter(p => p.section === s.upTo!.section).slice(-3); near.forEach(add); }
  const order = new Map(all.map((p, i) => [p.id, i]));
  return [...picked.values()].sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

// Citations in an answer: [12.4] or [12.4, 13.0]; only ids that were sent count (anything else is dropped)
export type Seg = { t: "text"; s: string } | { t: "cite"; ids: string[] };
export function splitCites(answer: string, sent: Set<string>): Seg[] {
  const out: Seg[] = []; let last = 0;
  for (const m of answer.matchAll(/\[(\d+\.\d+(?:\s*[,;]\s*\d+\.\d+)*)\]/g)) {
    const ids = m[1].split(/\s*[,;]\s*/).filter(id => sent.has(id));
    if (m.index! > last) out.push({ t: "text", s: answer.slice(last, m.index) });
    if (ids.length) out.push({ t: "cite", ids });
    last = m.index! + m[0].length;
  }
  if (last < answer.length) out.push({ t: "text", s: answer.slice(last) });
  return out;
}

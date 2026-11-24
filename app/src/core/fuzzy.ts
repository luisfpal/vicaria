// Fuzzy matching of a quote in a text, for re-attaching marks when the text changed (a new edition, a fixed typo,
// different quotation marks). After Hypothesis's anchoring: candidate places come from exact pieces of the quote, each
// is scored by edit distance over a small window, and a match is accepted only when it is close enough and clearly
// better than any other place. Thresholds come from tests/fuzzy-calibration.test.ts.

// one-to-one character folding (same length, so offsets stay valid): case, quotes, dashes, apostrophes
const FOLD: Record<string, string> = { "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'", "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u00ab": '"', "\u00bb": '"', "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-", "\u00a0": " " };
export function fold(s: string): string {
  let out = "";
  for (const ch of s) { const f = FOLD[ch]; const c = f ?? ch.toLowerCase(); out += c.length === ch.length ? c : ch; }
  return out;
}

// best match of p inside t (semi-global: free start and end in t). Returns edit distance and the span in t.
export function align(p: string, t: string): { dist: number; start: number; end: number } {
  const m = p.length, n = t.length;
  let prev = new Int32Array(n + 1), cur = new Int32Array(n + 1);
  let pstart = new Int32Array(n + 1), cstart = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) { prev[j] = 0; pstart[j] = j; }
  for (let i = 1; i <= m; i++) {
    cur[0] = i; cstart[0] = 0;
    const pc = p.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (pc === t.charCodeAt(j - 1) ? 0 : 1), del = prev[j] + 1, ins = cur[j - 1] + 1;
      if (sub <= del && sub <= ins) { cur[j] = sub; cstart[j] = pstart[j - 1]; }
      else if (del <= ins) { cur[j] = del; cstart[j] = pstart[j]; }
      else { cur[j] = ins; cstart[j] = cstart[j - 1]; }
    }
    [prev, cur] = [cur, prev]; [pstart, cstart] = [cstart, pstart];
  }
  let best = 0;
  for (let j = 1; j <= n; j++) if (prev[j] < prev[best]) best = j;
  return { dist: prev[best], start: pstart[best], end: best };
}

export interface FuzzyHit { start: number; end: number; score: number } // score: edits per quote character
export const FUZZY_MAX = 0.2;        // calibrated: accept at most this many edits per character
export const FUZZY_MARGIN = 0.08;    // calibrated: the runner-up elsewhere must score at least this much worse
export const FUZZY_MIN_LEN = 12;     // shorter quotes need context (prefix or suffix) to be placed fuzzily
export const FUZZY_SHORT = 40, FUZZY_SHORT_MAX = 0.12; // calibrated: a short quote with a few edits too easily matches other words
const SEED = 8;

// Candidates from exact seeds (every SEED characters of the folded quote), then alignment around each.
export function fuzzyFind(text: string, quote: string, opts: { expected?: number; max?: number; margin?: number } = {}): FuzzyHit | null {
  const max = Math.min(opts.max ?? FUZZY_MAX, quote.length < FUZZY_SHORT ? FUZZY_SHORT_MAX : 1), margin = opts.margin ?? FUZZY_MARGIN;
  const q = fold(quote), t = fold(text), m = q.length;
  if (m < 4 || m > 2000 || !t.length) return null;
  const slack = Math.ceil(m * max) + 2;
  const votes = new Map<number, number>();
  const step = m < 24 ? 4 : SEED;
  const seedLen = Math.min(step, m);
  for (let k = 0; k + seedLen <= m; k += step) {
    const seed = q.slice(k, k + seedLen);
    if (!seed.trim()) continue;
    let hits = 0;
    for (let i = t.indexOf(seed); i >= 0 && hits < 200; i = t.indexOf(seed, i + 1), hits++) {
      const s = Math.round((i - k) / 16) * 16; // bucket nearby proposals together
      votes.set(s, (votes.get(s) ?? 0) + 1);
    }
  }
  if (!votes.size) return null;
  const top = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 8);
  const hits: FuzzyHit[] = [];
  for (const [s] of top) {
    const from = Math.max(0, s - slack - 16), to = Math.min(t.length, s + m + slack + 16);
    const a = align(q, t.slice(from, to));
    hits.push({ start: from + a.start, end: from + a.end, score: a.dist / m });
  }
  // the same place found from two buckets counts once
  hits.sort((a, b) => a.score - b.score || a.start - b.start);
  const best = hits[0];
  if (best.score > max) return null;
  const other = hits.find(h => h.end <= best.start || h.start >= best.end);
  if (other && other.score - best.score < margin) {
    // a near tie: the expected place decides, if it clearly favors one
    if (opts.expected == null) return null;
    const d1 = Math.abs(best.start - opts.expected), d2 = Math.abs(other.start - opts.expected);
    if (d2 < d1 * 0.5) return other.score <= max ? other : null;
    if (d1 >= d2 * 0.5) return null;
  }
  return best;
}

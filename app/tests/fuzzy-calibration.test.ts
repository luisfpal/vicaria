// Calibration of fuzzy re-anchoring on changed editions. Quotes are taken from real books, the book text is changed
// the way new editions change (quotation marks, typo fixes, an added note number, a replaced word, punctuation), and
// each quote must be found at its true place. Negatives (the passage deleted or largely rewritten) must not be placed
// anywhere. The sweep prints placement rates per threshold; the chosen thresholds are asserted.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseEpub } from "../src/core/epub";
import { blockTexts, locate, type BlockText } from "../src/core/reanchor";

const CORPUS = new URL("../../tests/corpus/", import.meta.url).pathname;
let seed = 7; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const WORDS = "house river light stone garden letter winter morning silver window".split(" ");

type Kind = "quotes" | "typos" | "noteno" | "word" | "punct" | "edited8" | "deleted" | "rewritten" | "rewritten3";
// positives: what a new edition does to a passage someone marked; negatives: the passage is gone or another text
const POS: Kind[] = ["quotes", "typos", "noteno", "word", "punct", "edited8"], NEG: Kind[] = ["deleted", "rewritten", "rewritten3"];
function perturb(q: string, k: Kind): string {
  switch (k) {
    case "quotes": return q.replace(/'/g, "\u2019").replace(/"/g, "\u201d").replace(/\u2019/g, "'").replace(/,/g, ",").replace(/ - /g, " \u2014 ").replace(/\u2014/g, "--");
    case "typos": { const a = [...q]; for (let i = 5; i < a.length; i += 30) if (/[a-z]/i.test(a[i])) a[i] = a[i] === "e" ? "a" : "e"; return a.join(""); }
    case "noteno": { const sp = [...q.matchAll(/ /g)].map(m => m.index!); const at = sp[Math.floor(sp.length / 2)] ?? q.length; return q.slice(0, at) + "12" + q.slice(at); }
    case "word": { const ws = q.split(" "); if (ws.length > 3) ws[1 + rnd(ws.length - 2)] = WORDS[rnd(WORDS.length)]; return ws.join(" "); }
    case "punct": return q.replace(/,/g, ";").replace(/^\w/, c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase());
    case "deleted": return Array.from({ length: Math.ceil(q.length / 7) }, () => WORDS[rnd(WORDS.length)]).join(" ").slice(0, q.length);
    case "rewritten": return q.split(" ").map((w, i) => i % 2 ? WORDS[rnd(WORDS.length)] : w).join(" ");
    case "rewritten3": return q.split(" ").map((w, i) => i % 3 === 1 ? WORDS[rnd(WORDS.length)] : w).join(" ");
    case "edited8": return q.split(" ").map((w, i) => i % 8 === 4 ? WORDS[rnd(WORDS.length)] : w).join(" ");
  }
}

async function bookBlocks(file: string, maxSections = 60): Promise<BlockText[]> {
  const doc = (await parseEpub(new Uint8Array(readFileSync(CORPUS + file)))).doc;
  return doc.sections.slice(0, maxSections).flatMap(s => blockTexts(s.idx, s.html));
}

describe("fuzzy anchoring calibration", () => {
  it("places changed quotes and refuses removed ones", async () => {
    const rows: { kind: Kind; book: string; quote: string; truth: { section: number; block: number; start: number; end: number }; blocks: BlockText[] }[] = [];
    for (const file of ["meditations-se.epub", "pg132.epub", "pg2000.epub"]) {
      const orig = await bookBlocks(file);
      const flat = (x: string) => x.replace(/\s+/g, " ");
      const all = flat(orig.map(b => b.text).join("\n"));
      const usable = orig.map((b, i) => [b, i] as const).filter(([b]) => b.text.length > 120);
      const edition = orig.slice();
      const used = new Set<number>();
      for (let n = 0; n < 90 && used.size < usable.length; n++) {
        const [b, idx] = usable[rnd(usable.length)]; if (used.has(idx)) continue; used.add(idx);
        const len = 20 + rnd(Math.min(180, b.text.length - 30)), s0 = rnd(b.text.length - len);
        const s = b.text.lastIndexOf(" ", s0) + 1, e = Math.max(s + 15, b.text.indexOf(" ", s + len) < 0 ? b.text.length : b.text.indexOf(" ", s + len));
        const quote = b.text.slice(s, e);
        // a clean case: appears once, starts and ends on a character, and is mostly words (not layout whitespace)
        if (all.indexOf(flat(quote)) !== all.lastIndexOf(flat(quote)) || quote.trim() !== quote || quote.length < 15 || (quote.match(/\s/g)?.length ?? 0) > quote.length * 0.3) continue;
        const kind = [...POS, ...NEG][n % 9];
        const changed = perturb(quote, kind);
        const text = b.text.slice(0, s) + changed + b.text.slice(e);
        edition[idx] = { ...b, text, label: new Uint8Array(text.length) };
        rows.push({ kind, book: file, quote, truth: { section: b.section, block: b.block, start: s, end: s + changed.length }, blocks: edition });
      }
    }
    const sweep: string[] = [];
    const evalAt = (max: number, margin: number) => {
      let pos = 0, posOk = 0, neg = 0, negPlaced = 0, negAtTruth = 0; const misses: string[] = [];
      for (const r of rows) {
        const a = locate(r.blocks, r.quote, {}, { max, margin });
        const ok = !!a && a.section === r.truth.section && a.block === r.truth.block && Math.min(a.endOffset ?? 0, r.truth.end) - Math.max(a.offset, r.truth.start) >= 0.7 * (r.truth.end - r.truth.start);
        // a removed passage placed anywhere is wrong; a rewritten one attached at its own place is acceptable (it is
        // shown as changed), anywhere else is wrong
        if (NEG.includes(r.kind)) { neg++; if (a && (r.kind === "deleted" || !ok)) { negPlaced++; misses.push(`WRONG ${r.kind} ${r.book}: ${JSON.stringify(r.quote)} got ${JSON.stringify(a.exact)} at ${a.section}/${a.block} truth ${r.truth.section}/${r.truth.block}`); } else if (a) negAtTruth++; }
        else { pos++; if (ok) posOk++; else if (misses.length < 8) misses.push(`${r.kind} ${r.book}: ${JSON.stringify(r.quote.slice(0, 90))} got ${a ? JSON.stringify(a.exact.slice(0, 60)) : "nothing"}`); }
      }
      return { pos, posOk, neg, negPlaced, negAtTruth, misses };
    };
    // the full sweep is slow; run it with CALIBRATE=1 when changing the matcher
    if (process.env.CALIBRATE) for (const max of [0.1, 0.15, 0.2, 0.25, 0.3, 0.35]) for (const margin of [0.04, 0.08]) {
      const r = evalAt(max, margin); sweep.push(`max ${max} margin ${margin}: placed ${r.posOk}/${r.pos} changed, wrongly placed ${r.negPlaced}/${r.neg} removed or rewritten, ${r.negAtTruth} rewritten attached at their own place`);
    }
    console.log(sweep.join("\n"));
    const chosen = evalAt(0.2, 0.08);
    console.log("misses at the chosen thresholds:", chosen.misses);
    expect(chosen.pos).toBeGreaterThan(80);
    expect(chosen.posOk / chosen.pos).toBeGreaterThanOrEqual(0.95);
    expect(chosen.negPlaced).toBe(0);
  }, 300_000);
});

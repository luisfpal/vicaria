import { describe, it, expect } from "vitest";
import { bm25, contextFor, readSoFar, splitCites, terms, cite } from "../src/ai/retrieve";
import type { Passage } from "../src/core/types";

const P = (section: number, b0: number, text: string, chapter = `Book ${section}`): Passage => ({ id: `${section}:${b0}`, section, b0, b1: b0 + 1, chapter, text, notes: [] });
const book = [
  P(1, 0, "From my grandfather Verus I learned good morals and the government of my temper."),
  P(1, 2, "From my mother, piety and beneficence, and abstinence not only from evil deeds."),
  P(2, 0, "Begin the morning by saying to thyself, I shall meet with the busybody, the ungrateful, arrogant."),
  P(2, 3, "Death is such as generation is, a mystery of nature; the anger of others cannot harm me."),
  P(3, 0, "Revenge is not the answer; the best way of avenging thyself is not to become like the wrong doer."),
];

describe("retrieval", () => {
  it("folds accents and drops common words", () => {
    expect(terms("¿Qué dijo Marco sobre la ira?")).toEqual(["que", "dijo", "marco", "sobre", "ira"].filter(w => w !== "que"));
  });
  it("ranks the passage that answers first", () => {
    expect(bm25(book, "what did he learn from his grandfather?")[0].p.id).toBe("1:0");
    expect(bm25(book, "how to take revenge")[0].p.id).toBe("3:0");
    expect(bm25(book, "zzz")).toEqual([]);
  });
  it("never sends what the reader has not read, unless asked for the whole book", () => {
    const upTo = { section: 2, block: 0 };
    expect(readSoFar(book, upTo).map(p => p.id)).toEqual(["1:0", "1:2", "2:0"]);
    const ctx = contextFor(book, "revenge and anger", { mode: "book", upTo });
    expect(ctx.some(p => p.section === 3 || p.id === "2:3")).toBe(false);
    expect(contextFor(book, "revenge", { mode: "book", upTo, whole: true }).some(p => p.id === "3:0")).toBe(true);
  });
  it("chapter mode sends the chapter read so far, in book order", () => {
    const ctx = contextFor(book, "anything", { mode: "chapter", upTo: { section: 2, block: 9 } });
    expect(ctx.map(p => p.id)).toEqual(["2:0", "2:3"]);
  });
  it("a selection brings its passage", () => {
    const ctx = contextFor(book, "what does this mean", { mode: "chapter", upTo: { section: 3, block: 0 }, selection: { section: 1, block: 3, text: "piety and beneficence" } });
    expect(ctx[0].id).toBe("1:0"); expect(ctx.map(p => p.id)).toContain("1:2");
  });
  it("keeps only citations of passages that were sent", () => {
    const sent = new Set(book.slice(0, 2).map(cite));
    expect(splitCites("He learned morals [1.0]. Also piety [1.2, 9.9]. Made up [7.1].", sent)).toEqual([
      { t: "text", s: "He learned morals " }, { t: "cite", ids: ["1.0"] }, { t: "text", s: ". Also piety " }, { t: "cite", ids: ["1.2"] }, { t: "text", s: ". Made up " }, { t: "text", s: "." }]);
  });
  it("passages found by meaning go to the model even when no word of the question is in them", () => {
    // a Spanish question about an English book: BM25 finds nothing, the on-device ranking finds the passage
    const q = "¿Cómo vengarse de quien te ofende?";
    expect(bm25(book, q)).toEqual([]);
    const sent = contextFor(book, q, { mode: "book", whole: true }, ["3:0", "2:3"]);
    expect(sent.map(p => p.id)).toEqual(["2:3", "3:0"]);
    // ids outside what the reader has read stay out (no spoilers through the meaning ranking either)
    const sofar = contextFor(book, q, { mode: "book", upTo: { section: 2, block: 3 } }, ["3:0", "2:3"]);
    expect(sofar.map(p => p.id)).not.toContain("3:0");
  });
});

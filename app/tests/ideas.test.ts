import { describe, it, expect } from "vitest";
import { bookStats, ideaBooks, search, rows, offsets, visibleRange, graphOf, communities, NO_TOPIC, ROW_BOOK, ROW_HEAD, type IdeaBook } from "../src/core/ideas";
import type { Mark } from "../src/core/marks";
import type { LibraryBook } from "../src/core/read";

const mk = (book: string, tags: string[] = [], gone = false): Mark => ({ id: Math.random().toString(36), book, conflicts: [], tags, tagOps: {}, made: 0, edited: 0, gone });
const lb = (id: string, title: string, author: string): LibraryBook => ({ id, title, author, words: 1000 } as LibraryBook);

function synth(n: number): IdeaBook[] {
  const lib: LibraryBook[] = [], marks: Mark[] = [];
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(16, "0");
    lib.push(lb(id, `The ${["river", "stone", "glass"][i % 3]} of ${i}`, `Author${i % 150} Name${i % 150}`));
    marks.push(mk(id, [`topic${i % 12}`, `topic${i % 12}-b`]), mk(id, [`topic${i % 12}`]));
  }
  return ideaBooks(lib, bookStats(marks));
}

describe("book stats", () => {
  it("counts live marks and orders tags by use, ties alphabetical", () => {
    const s = bookStats([mk("a", ["x", "y"]), mk("a", ["y"]), mk("a", ["z"], true), mk("b")]);
    expect(s.a).toEqual({ n: 2, tags: ["y", "x"] });
    expect(s.b).toEqual({ n: 1, tags: [] });
  });
  it("a book with no marks has no topic", () => {
    const [b] = ideaBooks([lb("a", "T", "A")], {});
    expect(b.topic).toBe(NO_TOPIC); expect(b.marks).toBe(0);
  });
});

describe("search", () => {
  const bs = synth(1000);
  it("needs every word, ignores accents and case, looks at tags", () => {
    expect(search(ideaBooks([lb("a", "El Árbol", "José Pérez")], {}), "arbol jose")).toHaveLength(1);
    expect(search(bs, "river topic0").every(b => b.title.includes("river") && b.tags.includes("topic0"))).toBe(true);
    expect(search(bs, "  ")).toBe(bs);
    expect(search(bs, "zzzz")).toHaveLength(0);
  });
  it("answers in well under 100 ms at 1,000 books", () => {
    const t = performance.now(); for (let i = 0; i < 20; i++) search(bs, "glass topic5");
    expect((performance.now() - t) / 20).toBeLessThan(20);
  });
});

describe("rows", () => {
  const bs = ideaBooks([lb("1", "The Zebra", "Ann Zed"), lb("2", "A Apple", "Bo Abe"), lb("3", "Mid", "Cy Abe")], { "1": { n: 1, tags: ["b"] }, "2": { n: 1, tags: ["a"] } });
  it("by title ignores a leading article", () => expect(rows(bs, "title").map(r => "book" in r && r.book.id)).toEqual(["2", "3", "1"]));
  it("by author sorts headings by last name; by topic puts books with no topic last", () => {
    expect(rows(bs, "author").filter(r => "head" in r).map(r => "head" in r && r.head)).toEqual(["Bo Abe", "Cy Abe", "Ann Zed"]);
    expect(rows(bs, "topic").filter(r => "head" in r).map(r => "head" in r && r.head)).toEqual(["a", "b", NO_TOPIC]);
  });
});

describe("virtual list", () => {
  const rs = rows(synth(1000), "topic"), { top, total } = offsets(rs);
  it("offsets add up", () => {
    const heads = rs.filter(r => "head" in r).length;
    expect(total).toBe(heads * ROW_HEAD + (rs.length - heads) * ROW_BOOK);
  });
  it("the window covers the screen and never the whole list", () => {
    for (const y of [0, 5000, 31000, total - 700]) {
      const [a, b] = visibleRange(top, y, y + 700);
      expect(top[a]).toBeLessThanOrEqual(y); expect(top[b]).toBeGreaterThanOrEqual(Math.min(total, y + 700));
      expect(b - a).toBeLessThan(40);
    }
    expect(visibleRange(top, 1e9, 1e9 + 700)[1]).toBe(rs.length);
  });
});

describe("graph", () => {
  it("joins books that share a tag or an author, never more than a few edges per book and shared thing", () => {
    const bs = synth(1000), g = graphOf(bs);
    expect(g.edges.length).toBeLessThan(1000 * 2 * 4);
    expect(g.edges.every(([a, b, w]) => a < b && w >= 1)).toBe(true);
  });
  it("clusters follow the topics and are named by their tag", () => {
    const g = graphOf(synth(240));
    expect(g.clusters.length).toBeLessThan(40);
    expect(g.clusters.reduce((s, c) => s + c.size, 0)).toBe(240);
    for (let t = 0; t < 12; t++) { const names = new Set(g.cluster.filter((_, i) => i % 12 === t)); expect(names.size).toBeLessThanOrEqual(2); }
  });
  it("is the same every time", () => {
    const bs = synth(300);
    expect(graphOf(bs)).toEqual(graphOf(bs));
  });
  it("two groups with no edge between them stay apart", () => {
    const c = communities(6, [[0, 1, 1], [1, 2, 1], [0, 2, 1], [3, 4, 1], [4, 5, 1], [3, 5, 1]]);
    expect(c[0]).toBe(c[1]); expect(c[3]).toBe(c[4]); expect(c[0]).not.toBe(c[3]);
  });
  it("a library with no tags and no authors is nodes with no edges", () => {
    const g = graphOf(ideaBooks([lb("a", "A", ""), lb("b", "B", "")], {}));
    expect(g.edges).toEqual([]); expect(g.cluster).toHaveLength(2);
  });
});

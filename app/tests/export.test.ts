import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { exportFiles, markdownFor, webAnnotations, chapterAt, type ExportBook } from "../src/core/export";
import type { Mark } from "../src/core/marks";

const book: ExportBook = { id: "b1", title: "Meditations", author: "Marcus Aurelius", sha256: "ab".repeat(32), toc: [{ title: "Book I", section: 0, block: 0 }, { title: "Book II", section: 1, block: 0 }] };
const at = (section: number, block: number, exact: string) => ({ section, block, offset: 0, exact, prefix: "", suffix: "" });
const mark = (id: string, o: Partial<Mark>): Mark => ({ id, book: "b1", conflicts: [], tags: [], tagOps: {}, made: 1e12, edited: 1e12, gone: false, ...o });

describe("export of every facet", () => {
  it("keeps loved, styles, sticky notes, cards, questions and lost marks in both formats", () => {
    const ms = [
      mark("s", { at: at(0, 1, "ruled by reason"), color: "yellow", style: "strike", loved: true, sticky: { side: "l", tint: "pink" }, note: "margin" }),
      mark("k", { at: at(1, 0, ""), card: { chapter: 1, text: "Book II in short" } }),
      mark("q", { at: at(0, 2, "the whole"), ask: { q: "What is the whole?", a: "Nature.", model: "deepseek-chat", cites: [] } }),
      mark("l", { lost: at(0, 9, "words no longer here"), color: "blue", note: "kept" }),
    ];
    const md = markdownFor(book, ms);
    expect(md).toContain("Chapter card: Book II in short");
    expect(md).toContain("Question: What is the whole?\n\nAnswer (deepseek-chat): Nature.");
    expect(md).toContain("## Not found in this edition\n\n> words no longer here\n\nkept");
    const items = webAnnotations([book], ms).first.items;
    const json = (id: string) => JSON.stringify(items.find(i => i.id.endsWith(id)));
    for (const v of ["strike", "loved", "sticky note", "margin"]) expect(json(":s")).toContain(`"${v}"`);
    expect(json(":k")).toContain('"purpose":"describing"');
    expect(json(":q")).toContain('"purpose":"questioning"'); expect(json(":q")).toContain('"generator":"deepseek-chat"');
    expect(json(":l")).toContain('"exact":"words no longer here"'); expect(json(":l")).not.toContain("FragmentSelector");
  });
});

describe("export", () => {
  const marks = [
    mark("a", { at: at(0, 2, "a benevolent disposition"), color: "green", tags: ["virtue ethics"], loved: true }),
    mark("b", { at: at(1, 1, "line one\nline two"), color: "pink", style: "underline", note: "Why?" }),
    mark("c", { at: at(1, 0, ""), bookmark: { name: "Start of Book II" } }),
    mark("d", { at: at(0, 1, "gone one"), color: "blue", gone: true }),
    mark("e", { note: "lost note" }),
    mark("f", { at: at(0, 3, "x"), note: "mine", conflicts: [{ op: "o", text: "theirs", t: 1 }] as never }),
  ];
  it("writes chapters, labels, styles, tags, loved, bookmarks, conflicts and unplaced notes", () => {
    const md = markdownFor(book, marks, { green: "Insight" });
    expect(md).toContain("# Meditations\n*Marcus Aurelius*");
    expect(md).toContain("## Bookmarks\n\n- Start of Book II");
    expect(md).toContain("## Places I loved\n\n- a benevolent disposition");
    expect(md).toContain("*Insight · loved · #virtue-ethics*");
    expect(md).toContain("> line one\n> line two\n\n*Question · underline*\n\nWhy?");
    expect(md).toContain("Other version of the note: theirs");
    expect(md).toContain("## Not found in this edition\n\n> lost note");
    expect(md).not.toContain("gone one");
    expect(md.indexOf("## Book I")).toBeLessThan(md.indexOf("## Book II"));
  });
  it("makes W3C Web Annotations", () => {
    const w = webAnnotations([book], marks);
    expect(w.total).toBe(5);
    const a = w.first.items.find(i => i.id.endsWith(":a"))!;
    expect(a).toMatchObject({ type: "Annotation", motivation: "highlighting", target: { source: `urn:sha256:${book.sha256}` } });
    expect(JSON.stringify(a)).toContain('"TextQuoteSelector"');
    expect(w.first.items.find(i => i.id.endsWith(":c"))!.motivation).toBe("bookmarking");
  });
  it("gives every book its own file name", () => {
    const b2 = { ...book, id: "b2" }, b3 = { ...book, id: "b3", title: 'a/b:c*?"<>|', author: "" };
    const f = exportFiles([book, b2, b3], [mark("x", { at: at(0, 0, "t"), color: "yellow" }), mark("y", { book: "b2", at: at(0, 0, "t"), color: "yellow" }), mark("z", { book: "b3", at: at(0, 0, "t"), color: "yellow" })]);
    expect(Object.keys(f).sort()).toEqual(["Meditations - Marcus Aurelius (b2).md", "Meditations - Marcus Aurelius.md", "a b c.md", "annotations.jsonld"].sort());
  });
  it("chapterAt picks the last heading at or before the place", () => {
    expect(chapterAt(book, 0, 5)).toBe("Book I"); expect(chapterAt(book, 1, 0)).toBe("Book II"); expect(chapterAt({ ...book, toc: [] }, 3, 3)).toBe("");
  });
  it("never throws and always keeps every visible note (fuzz)", () => {
    const arb = fc.record({ id: fc.string({ minLength: 1, maxLength: 6 }), exact: fc.string({ maxLength: 40 }), note: fc.option(fc.string({ maxLength: 60 }).filter(s => s.trim().length > 0), { nil: undefined }), placed: fc.boolean(), gone: fc.boolean(), section: fc.nat(3), block: fc.nat(9), tag: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }) });
    fc.assert(fc.property(fc.array(arb, { maxLength: 30 }), xs => {
      const ms = xs.map((x, i) => mark(`${x.id}${i}`, { at: x.placed ? at(x.section, x.block, x.exact) : undefined, note: x.note, gone: x.gone, color: "yellow", tags: x.tag ? [x.tag] : [] }));
      const f = exportFiles([book], ms);
      const md = f["Meditations - Marcus Aurelius.md"] ?? "";
      for (const m of ms) if (!m.gone && m.note) expect(md).toContain(m.note.split(/\r\n?|\n/)[0]);
      const w = JSON.parse(f["annotations.jsonld"]);
      expect(w.total).toBe(ms.filter(m => !m.gone).length);
    }), { numRuns: 300 });
  });
});

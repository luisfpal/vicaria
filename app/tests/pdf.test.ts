import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePdf, isPdf, blocksOf } from "../src/core/pdf";

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const lib = () => import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<typeof import("pdfjs-dist")>;

describe("PDF import", () => {
  it("knows a PDF by its first bytes", () => {
    expect(isPdf(fx("ledger.pdf"))).toBe(true);
    expect(isPdf(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(false);
  });
  it("reads chapters from the outline, keeps every block on one page, and finds the words", async () => {
    const { doc } = await parsePdf(fx("ledger.pdf"), "ab".repeat(32), 1, "ledger.pdf", await lib());
    expect(doc.meta.title).toBe("The Steward's Ledger"); expect(doc.meta.format).toBe("pdf");
    expect(doc.sections.map(s => s.title)).toEqual(["Chapter One: The Ledger", "Chapter Two: Two Columns", "Chapter Three: The Reckoning"]);
    expect(doc.toc.map(t => [t.title, t.section, t.depth])).toEqual([["Chapter One: The Ledger", 0, 0], ["A short section", 0, 1], ["Chapter Two: Two Columns", 1, 0], ["Chapter Three: The Reckoning", 2, 0]]);
    // an outline entry points at the block with its heading, not just its page
    for (const t of doc.toc) expect(doc.sections[t.section].blocks[t.block]).toBe(t.title);
    for (const s of doc.sections) {
      const el = s.html;
      expect((el.match(/data-b="/g) || []).length).toBe(s.blocks.length);
      // the text in each block's html is its plain text
      s.blocks.forEach((t, b) => {
        const m = el.match(new RegExp(`data-b="${b}"[^>]*>(.*?)</p>`));
        const txt = (m?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
        expect(txt).toBe(t);
      });
    }
    const two = doc.sections[1].blocks;
    // the left column comes before the right one, paragraph by paragraph
    const i1 = two.findIndex(t => t.includes("paragraph 1.")), i8 = two.findIndex(t => t.includes("paragraph 8."));
    expect(i1).toBeGreaterThan(0); expect(i8).toBeGreaterThan(i1);
    expect(two.some(t => /^Column text, paragraph 1\. The steward .* twice\.$/.test(t))).toBe(true);
    expect(doc.sections[2].blocks.join(" ")).toContain("settle every account before the frost");
    expect(doc.passages.length).toBeGreaterThan(2);
    expect(doc.passages.every(p => p.text.trim())).toBe(true);
  }, 30000);
  it("a scanned PDF still has its pages, with an empty block on each", async () => {
    const { doc } = await parsePdf(fx("scan.pdf"), "cd".repeat(32), 1, "scan.pdf", await lib());
    expect(doc.sections.length).toBe(1); expect(doc.sections[0].title).toBe("Pages 1 to 2");
    expect(doc.sections[0].blocks).toEqual(["", ""]);
    expect((doc.sections[0].html.match(/class="pdfpage"/g) || []).length).toBe(2);
    expect(doc.passages).toEqual([]);
  }, 30000);
  it("a broken file is reported plainly", async () => {
    await expect(parsePdf(new TextEncoder().encode("%PDF-1.4 nothing here"), "ef".repeat(32), 1, "x.pdf", await lib())).rejects.toThrow("this PDF could not be read");
  });
  it("splits columns and type sizes into blocks", () => {
    const it = (str: string, x: number, y: number, size = 12) => ({ str, x, y, size, w: 50, asc: 0.8 });
    const b = blocksOf([it("Title", 40, 50, 22), it("line one", 40, 80), it("line two", 40, 94), it("far below", 40, 140), it("right col", 220, 80)], 0);
    expect(b.map(x => x.text)).toEqual(["Title", "line one line two", "far below", "right col"]);
  });
});

it("without an outline, the contents come from large headings", async () => {
  const { headings } = await import("../src/core/pdf");
  const blk = (text: string, size: number) => ({ page: 0, items: [{ str: text, x: 0, y: 0, size, w: 1, asc: .8 }], text, x0: 0, y0: 0, x1: 1, y1: 1 });
  const long = "word ".repeat(60);
  const pages = [{ w: 400, h: 600, blocks: [blk("Chapter 1", 22), blk(long, 11), blk(long, 11)] }, { w: 400, h: 600, blocks: [blk(long, 11), blk("Chapter 2", 22), blk(long, 11), blk("12", 30)] }];
  const toc = headings(pages, new Map([[0, 0], [1, 0]]), new Map([[0, 0], [1, 3]]));
  expect(toc?.map(t => [t.title, t.block])).toEqual([["Chapter 1", 0], ["Chapter 2", 4]]);
});

it("a right-to-left PDF reads right to left, in reading order", async () => {
  const { doc } = await parsePdf(fx("hebrew.pdf"), "aa".repeat(32), 1, "", await lib());
  expect(doc.meta.dir).toBe("rtl");
  expect(doc.toc[0].title).toBe("פרק ראשון");
  const b = doc.sections[0].blocks;
  expect(b[0]).toBe("פרק ראשון");
  expect(b[1].startsWith("פסקה 1")).toBe(true);
  expect(b[1]).toContain("השומר של אחוזה קטנה");
  expect(doc.sections[0].html).toContain('dir="rtl"');
}, 30000);

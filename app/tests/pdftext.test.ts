import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePdf } from "../src/core/pdf";
import { pdfTextHtml } from "../src/ui/pdftext";
const lib = () => import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<typeof import("pdfjs-dist")>;
const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

it("the text view keeps every block with its text, and finds the headings", async () => {
  const { doc } = await parsePdf(fx("ledger.pdf"), "ab".repeat(32), 1, "", await lib());
  const s = doc.sections[0], html = pdfTextHtml(s.html);
  const got = [...html.matchAll(/<(p|h2|h3) data-b="(\d+)">(.*?)<\/\1>/g)].map(m => [m[1], +m[2], m[3]] as const);
  expect(got.map(g => g[1])).toEqual(s.blocks.map((_, i) => i));
  got.forEach(([, b, t]) => expect(t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")).toBe(s.blocks[b]));
  expect(got.find(g => g[2] === "Chapter One: The Ledger")?.[0]).toBe("h2");
  expect(got.find(g => g[2] === "A short section")?.[0]).toBe("h3");
  expect(got.filter(g => g[0] !== "p").length).toBe(2);
}, 30000);
it("a scan says why there is no text", async () => {
  const { doc } = await parsePdf(fx("scan.pdf"), "cd".repeat(32), 1, "", await lib());
  expect(pdfTextHtml(doc.sections[0].html)).toContain("These pages are pictures");
}, 30000);

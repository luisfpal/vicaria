// How far a reader is through a book, as a fraction kept on this device beside the last-opened time. It is counted in
// blocks (paragraphs), which follow the text closely and are already in the book's head, so the library needs no scan of
// the log. A fixed-layout book (PDF) has one block per page or none, and falls back to counting sections.
export function fraction(blocks: number[], section: number, block: number): number {
  const total = blocks.reduce((n, b) => n + b, 0);
  if (!blocks.length) return 0;
  const f = total > 0
    ? (blocks.slice(0, Math.max(0, section)).reduce((n, b) => n + b, 0) + Math.min(Math.max(0, block), blocks[section] ?? 0)) / total
    : section / Math.max(1, blocks.length - 1);
  return Math.min(1, Math.max(0, f));
}
// shown as a bar from 2% (a first glance at the cover is not reading), full at 97% (the last pages are often notes and licences)
export const shown = (f: number | undefined): number => f === undefined || f < 0.02 ? 0 : f >= 0.97 ? 1 : f;

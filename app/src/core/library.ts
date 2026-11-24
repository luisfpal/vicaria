// Importing and reading books from storage. Import runs in a worker; reads are cheap and incremental:
// opening a book loads its head (meta, toc, notes) and one section, never the whole book.
import { PARSER_VERSION, type BookDoc } from "./types";
import { get, tx, bookRange } from "./idb";
import { parseEpub, sha256 } from "./epub";
const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
import { saveOriginal, readOriginal } from "./originals";

import { type Head, type LibraryBook, listBooks } from "./read";
export * from "./read";

export async function importBytes(bytes: Uint8Array, opts: { addedAt?: number; name?: string } = {}): Promise<LibraryBook> {
  const { doc, images } = isPdf(bytes)
    ? await (await import("./pdf")).parsePdf(bytes, await sha256(bytes), opts.addedAt ?? Date.now(), opts.name)
    : await parseEpub(bytes, opts.addedAt ?? Date.now());
  const existing = await get<LibraryBook>("books", doc.meta.id);
  const storage = await saveOriginal(doc.meta.sha256, bytes);
  const book: LibraryBook = { ...doc.meta, addedAt: existing?.addedAt ?? doc.meta.addedAt, v: PARSER_VERSION, words: doc.stats.words, sections: doc.sections.length, storage };
  await store(doc, images, book);
  return book;
}

async function store(doc: BookDoc, images: Record<string, Uint8Array>, book: LibraryBook) {
  const id = doc.meta.id;
  const { sections, passages, ...rest } = doc;
  const head: Head = { ...rest, meta: { ...rest.meta, addedAt: book.addedAt }, sectionInfo: sections.map(s => ({ idx: s.idx, title: s.title, kind: s.kind, linear: s.linear, blocks: s.blocks.length, fixed: s.fixed })) };
  await tx(["books", "heads", "sections", "passages", "images"], t => {
    t.objectStore("sections").delete(bookRange(id));
    t.objectStore("images").delete(bookRange(id));
    t.objectStore("heads").put(head);
    for (const s of sections) t.objectStore("sections").put(s, [id, s.idx]);
    t.objectStore("passages").put(passages, id);
    for (const [p, b] of Object.entries(images)) t.objectStore("images").put(new Blob([b as BlobPart], { type: doc.images[p] || "application/octet-stream" }), [id, p]);
    t.objectStore("books").put(book);
  });
}

export async function reparseIfStale(book: LibraryBook): Promise<LibraryBook> {
  if (book.v >= PARSER_VERSION) return book;
  const blob = await readOriginal(book.sha256);
  if (!blob) return book;
  return importBytes(new Uint8Array(await blob.arrayBuffer()), { addedAt: book.addedAt });
}


export { removeBook } from "./library-remove";
export { readOriginal };

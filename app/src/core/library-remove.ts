// Removing a book touches only storage, so the page can do it without loading the importer.
import { tx, bookRange } from "./idb";
import { deleteOriginal } from "./originals";
import type { LibraryBook } from "./read";

export async function removeBook(book: LibraryBook, opts: { keepOriginal?: boolean } = {}) {
  await tx(["books", "heads", "sections", "passages", "images"], t => {
    for (const s of ["sections", "images"] as const) t.objectStore(s).delete(bookRange(book.id));
    t.objectStore("heads").delete(book.id); t.objectStore("passages").delete(book.id); t.objectStore("books").delete(book.id);
  });
  if (!opts.keepOriginal) await deleteOriginal(book.sha256);
}

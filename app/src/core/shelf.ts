// Removing and restoring books, as operations so paired devices do the same (0.x format: "shelf" with
// { book, state: "trash" | "shelf" }; for each book the newest one wins). A removed book keeps its original file for
// 30 days in Recently removed, so Restore brings it back with its marks (marks are never deleted with a book).
import { get, put } from "./idb";
import { addOp, allOps, newer, resolver, type Resolver } from "./ops";
import { removeBook } from "./library-remove";
import { readOriginal, deleteOriginal } from "./originals";
import type { LibraryBook } from "./read";
import type { Op } from "./types";
import { oldKeys } from "../sync/legacy-snap";

export const KEEP_DAYS = 30;
export interface Trashed { id: string; title: string; author: string; sha256: string; at: number }
export type ShelfState = "trash" | "shelf";

// newest shelf state per book (0.x keys mapped to book ids through alias ops)
export function shelfStates(ops: Op[], r: Resolver = resolver(ops)): Map<string, { state: ShelfState; op: Op }> {
  const out = new Map<string, { state: ShelfState; op: Op }>();
  for (const o of ops) {
    if (o.k !== "shelf" || (o.v.state !== "trash" && o.v.state !== "shelf")) continue;
    const b = r.bookOf(o); if (!b) continue;
    const c = out.get(b); if (!c || newer(o, c.op)) out.set(b, { state: o.v.state, op: o });
  }
  return out;
}
// What this device should do to match the newest states: remove books that were removed elsewhere, restore books it
// still has in Recently removed. Books it never had are left to sync, which fetches them.
export function shelfPlan(states: Map<string, { state: ShelfState }>, here: Set<string>, trashed: Set<string>): { remove: string[]; restore: string[] } {
  const remove: string[] = [], restore: string[] = [];
  for (const [b, { state }] of states) {
    if (state === "trash" && here.has(b)) remove.push(b);
    else if (state === "shelf" && !here.has(b) && trashed.has(b)) restore.push(b);
  }
  return { remove: remove.sort(), restore: restore.sort() };
}

export const trashList = async () => ((await get<Trashed[]>("kv", "trash")) ?? []).sort((a, b) => b.at - a.at);
const setTrash = (l: Trashed[]) => put("kv", l, "trash");

// remove locally (record=false when applying another device's operation)
// the key a shelf op names: the 0.x key for a book that came from 0.x, so 0.x devices follow too (both map to the
// same book here through the alias)
async function shelfKey(id: string) { return oldKeys(await allOps()).get(id) ?? id; }
export async function trashBook(book: LibraryBook, record = true) {
  if (record) await addOp("shelf", { book: await shelfKey(book.id), state: "trash" });
  await removeBook(book, { keepOriginal: true });
  const l = (await trashList()).filter(t => t.id !== book.id);
  await setTrash([{ id: book.id, title: book.title, author: book.author, sha256: book.sha256, at: Date.now() }, ...l]);
}
export async function restoreBook(id: string, importBytes: (b: Uint8Array) => Promise<LibraryBook>, record = true): Promise<LibraryBook | null> {
  const l = await trashList(), t = l.find(x => x.id === id); if (!t) return null;
  const blob = await readOriginal(t.sha256); if (!blob) { await setTrash(l.filter(x => x.id !== id)); return null; }
  // the decision is recorded first: if the import stops halfway, the next start sees "shelf" and finishes it from
  // the kept original (shelfPlan), instead of seeing "trash" and removing the book again
  if (record) await addOp("shelf", { book: await shelfKey(id), state: "shelf" });
  const book = await importBytes(new Uint8Array(await blob.arrayBuffer()));
  if (book.id !== id) console.warn("restored book has another id", id, book.id); // ids come from the content hash
  await setTrash((await trashList()).filter(x => x.id !== id));
  return book;
}
export async function deleteForever(id: string) {
  const l = await trashList(), t = l.find(x => x.id === id); if (!t) return;
  await deleteOriginal(t.sha256); await setTrash(l.filter(x => x.id !== id));
}
export async function purgeTrash(now = Date.now()) {
  for (const t of await trashList()) if (now - t.at > KEEP_DAYS * 86400_000) await deleteForever(t.id);
}
// a newly added book: tell paired devices it is on the shelf (not for re-imports of a book already here)
export async function recordAdded(book: LibraryBook, wasHere: boolean) {
  if (!wasHere) await addOp("shelf", { book: book.id, state: "shelf" });
  const l = await trashList(); if (l.some(t => t.id === book.id)) await setTrash(l.filter(t => t.id !== book.id));
}

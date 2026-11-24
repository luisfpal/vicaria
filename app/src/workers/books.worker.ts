// Heavy work off the page: import, re-import, search inside a book, backup and restore.
import { serve, progress } from "./rpc";
import { importBytes, listBooks, reparseIfStale, section, head, readOriginal } from "../core/library";
import { allOps, mergeOps, anchorsMap, resolver, clean, compact } from "../core/ops";
import { foldMarks } from "../core/marks";
import { bookStats } from "../core/ideas";
import { sourceOf } from "../wiser/source";
import { shelfStates, shelfPlan, trashBook, restoreBook, deleteForever, trashList, purgeTrash, recordAdded } from "../core/shelf";
import { exportFiles, type ExportBook, type Labels } from "../core/export";
import { migrate } from "../core/migrate";
import { legacyStamp, readLegacy, migrateLegacy, relocateStale, reanchorAll } from "../core/legacy";
import { get, put } from "../core/idb";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import type { Op } from "../core/types";
import type { LibraryBook } from "../core/read";

async function added(bytes: Uint8Array, name?: string) {
  const before = new Set((await listBooks()).map(b => b.id));
  const b = await importBytes(bytes, { name }); await recordAdded(b, before.has(b.id)); return b;
}

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

serve({
  async init() { await migrate(); return true; },
  // Moves the 0.x library on this device, if there is one and it changed since the last move. The 0.x database is
  // only read. Returns null when there was nothing to do.
  async legacy() {
    await migrate();
    const stamp = await legacyStamp(); if (stamp == null) return null;
    if ((await get<number>("kv", "legacyStamp")) === stamp) return null;
    const first = !(await get("kv", "legacy"));
    const files = await readLegacy(); if (!files) return null;
    const report = await migrateLegacy(files, b => importBytes(b), p => progress({ step: "legacy", ...p }));
    await put("kv", stamp, "legacyStamp");
    return { first, report };
  },
  // Marks across the library for the Places page: bookmarks, loved places and notes, newest first.
  async marksAcross() {
    const ops = await allOps();
    const ms = foldMarks(ops, undefined, resolver(ops, await anchorsMap())).filter(m => !m.gone && m.at && (m.bookmark || m.loved || m.note));
    const titles = new Map((await listBooks()).map(b => [b.id, b.title]));
    return ms.filter(m => titles.has(m.book)).map(m => ({ id: m.id, book: m.book, title: titles.get(m.book)!, at: { section: m.at!.section, block: m.at!.block }, exact: (m.at!.exact || "").slice(0, 300), note: (m.note || "").slice(0, 600), name: m.bookmark?.name, color: m.color, loved: !!m.loved, bookmark: !!m.bookmark, tags: m.tags, edited: m.edited }))
      .sort((a, b) => b.edited - a.edited);
  },
  // Marks and tags per book for the Ideas page.
  async ideas() {
    const ops = await allOps();
    return bookStats(foldMarks(ops, undefined, resolver(ops, await anchorsMap())));
  },
  // What Wiser may draw from: highlights, notes, tags and clusters, clipped (src/wiser/source.ts).
  async wiserSource() {
    const ops = await allOps();
    return sourceOf(foldMarks(ops, undefined, resolver(ops, await anchorsMap())), await listBooks());
  },
  async compact() { return compact(); },
  async trash(id: string) { const b = await get<LibraryBook>("books", id); if (b) await trashBook(b); return listBooks(); },
  async restoreBook(id: string) { const b = await restoreBook(id, importBytes); return { book: b, books: await listBooks() }; },
  async deleteForever(id: string) { await deleteForever(id); return trashList(); },
  async trashList() { await purgeTrash(); return trashList(); },
  // make this device match the newest remove and restore of every book (after ops arrive from another device)
  async applyShelf() {
    const ops = await allOps();
    const here = new Set((await listBooks()).map(b => b.id)), trashed = new Set((await trashList()).map(t => t.id));
    const plan = shelfPlan(shelfStates(ops), here, trashed);
    for (const id of plan.remove) { const b = await get<LibraryBook>("books", id); if (b) await trashBook(b, false); }
    for (const id of plan.restore) await restoreBook(id, importBytes, false);
    return plan;
  },
  // after changes arrived from another device: find 0.x quotes and re-read anchors, follow removals and restores
  async afterSync() {
    await reanchorAll(); await relocateStale();
    const ops = await allOps();
    const here = new Set((await listBooks()).map(b => b.id)), trashed = new Set((await trashList()).map(t => t.id));
    const plan = shelfPlan(shelfStates(ops), here, trashed);
    for (const id of plan.remove) { const b = await get<LibraryBook>("books", id); if (b) await trashBook(b, false); }
    for (const id of plan.restore) await restoreBook(id, importBytes, false);
    return listBooks();
  },
  async legacyReport() { return (await get("kv", "legacy")) || null; },
  async importFile(bytes: ArrayBuffer, name?: string) { await migrate(); return added(new Uint8Array(bytes), name); },
  async importUrl(url: string) {
    await migrate();
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download failed (${r.status})`);
    return added(new Uint8Array(await r.arrayBuffer()));
  },
  async refresh() {
    const out = [];
    let reread = false;
    for (const b of await listBooks()) { const n = await reparseIfStale(b); reread ||= n !== b; out.push(n); }
    if (reread) await relocateStale(); // marks made against the old reading of these books
    // quotes from 0.x not yet placed: a placing that was cut short (the app closed, a page reload) resumes here,
    // since nothing else would start it again until another change arrives. Not awaited: the shelf need not wait,
    // and an open book redraws when the anchors land.
    void reanchorAll().catch(() => {});
    return out;
  },
  async search(bookId: string, q: string, limit = 200) {
    const h = await head(bookId); if (!h) return [];
    const needle = fold(q.trim()); if (needle.length < 2) return [];
    const hits: { section: number; block: number; offset: number; before: string; match: string; after: string; title: string }[] = [];
    for (const info of h.sectionInfo) {
      const s = await section(bookId, info.idx); if (!s) continue;
      const title = h.toc.filter(t => t.section <= info.idx).pop()?.title || info.title;
      s.blocks.forEach((t, b) => {
        const f = fold(t); let i = f.indexOf(needle);
        while (i >= 0 && hits.length < limit) {
          hits.push({ section: info.idx, block: b, offset: i, before: t.slice(Math.max(0, i - 50), i), match: t.slice(i, i + needle.length), after: t.slice(i + needle.length, i + needle.length + 70), title });
          i = f.indexOf(needle, i + needle.length);
        }
      });
      if (hits.length >= limit) break;
    }
    return hits;
  },
  async backup() {
    const books = await listBooks();
    const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
    let n = 0;
    for (const b of books) {
      const blob = await readOriginal(b.sha256);
      if (blob) files[`books/${b.sha256}.epub`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      progress({ step: "backup", done: ++n, total: books.length });
    }
    files["ops.jsonl"] = strToU8((await allOps()).map(o => clean(o)).filter(Boolean).map(o => JSON.stringify(o)).join("\n")); // only ops that would be accepted back
    files["manifest.json"] = strToU8(JSON.stringify({ format: "vicaria-backup", version: 1, created: new Date().toISOString(), books: books.map(b => ({ id: b.id, sha256: b.sha256, title: b.title, author: b.author })) }, null, 1));
    return new Blob([zipSync(files as never) as BlobPart], { type: "application/zip" });
  },
  async restore(bytes: ArrayBuffer) {
    await migrate();
    const files = unzipSync(new Uint8Array(bytes));
    const man = files["manifest.json"] && JSON.parse(strFromU8(files["manifest.json"]));
    if (man?.format !== "vicaria-backup") throw new Error("This is not a Vicaria backup file.");
    const books = Object.keys(files).filter(k => k.startsWith("books/") && k.endsWith(".epub"));
    let n = 0;
    for (const k of books) { await importBytes(files[k]); progress({ step: "restore", done: ++n, total: books.length }); }
    const ops = files["ops.jsonl"] ? strFromU8(files["ops.jsonl"]).split("\n").filter(Boolean).map(l => JSON.parse(l) as Op) : [];
    const added = (await mergeOps(ops)).length;
    await relocateStale();
    await compact();
    return { books: books.length, ops: added };
  },
  async markdown(labels: Labels = {}) {
    const ops = await allOps();
    const marks = foldMarks(ops, undefined, resolver(ops, await anchorsMap()));
    const list: ExportBook[] = [];
    for (const b of await listBooks()) list.push({ id: b.id, title: b.title, author: b.author, sha256: b.sha256, toc: (await head(b.id))?.toc ?? [] });
    const files = Object.fromEntries(Object.entries(exportFiles(list, marks, labels)).map(([k, v]) => [k, strToU8(v)]));
    return new Blob([zipSync(files, { level: 1 }) as BlobPart], { type: "application/zip" });
  },
});

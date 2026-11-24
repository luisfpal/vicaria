// Original EPUB files, stored once by SHA-256. OPFS when the browser has it, IndexedDB otherwise.
import { get, put, del } from "./idb";

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle("originals", { create: true });
  } catch { return null; }
}

// one write per file at a time: two writers of the same file would truncate under each other
const writing = new Map<string, Promise<unknown>>();
export function saveOriginal(sha: string, bytes: Uint8Array): Promise<"opfs" | "idb"> {
  const run = (writing.get(sha) ?? Promise.resolve()).catch(() => {}).then(() => writeOriginal(sha, bytes));
  writing.set(sha, run); run.finally(() => { if (writing.get(sha) === run) writing.delete(sha); }).catch(() => {});
  return run;
}
async function writeOriginal(sha: string, bytes: Uint8Array): Promise<"opfs" | "idb"> {
  const d = await dir();
  if (d) {
    // files are named by their SHA-256, so one of the right size is this file: never rewrite it (a rewrite truncates
    // first, and a reader or a peer fetching the book at that moment would get an empty or partial file)
    try { if ((await (await d.getFileHandle(`${sha}.epub`)).getFile()).size === bytes.length) return "opfs"; } catch { /* not there yet */ }
    try {
      const fh = await d.getFileHandle(`${sha}.epub`, { create: true });
      const h = fh as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<{ write(b: BufferSource, o?: { at: number }): number; truncate(n: number): void; flush(): void; close(): void }> };
      if (typeof h.createSyncAccessHandle === "function" && typeof (globalThis as { document?: unknown }).document === "undefined") {
        const a = await h.createSyncAccessHandle(); a.truncate(0); a.write(bytes as BufferSource, { at: 0 }); a.flush(); a.close();
      } else {
        const w = await fh.createWritable(); await w.write(bytes as BufferSource); await w.close();
      }
      return "opfs";
    } catch { /* fall through to IndexedDB */ }
  }
  await put("originals", new Blob([bytes as BlobPart], { type: "application/epub+zip" }), sha);
  return "idb";
}

export async function readOriginal(sha: string): Promise<Blob | null> {
  const d = await dir();
  if (d) { try { const f = await (await d.getFileHandle(`${sha}.epub`)).getFile(); if (f.size) return f; } catch { /* not in OPFS */ } }
  return (await get<Blob>("originals", sha)) || null;
}

export async function deleteOriginal(sha: string) {
  const d = await dir();
  if (d) { try { await d.removeEntry(`${sha}.epub`); } catch { /* absent */ } }
  await del("originals", sha);
}

// Model files in the origin private file system, directory "models". A file counts as downloaded once a marker
// "<name>.ok" sits next to it. Writing uses sync access handles, which every current browser has in workers.
import { nameOf, type Store } from "./downloads";

const dir = () => navigator.storage.getDirectory().then(r => r.getDirectoryHandle("models", { create: true }));
async function handle(name: string, create = false): Promise<FileSystemFileHandle | null> {
  try { return await (await dir()).getFileHandle(name, { create }); } catch { return null; }
}
type Sync = { write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void; getSize(): number };
async function withSync<T>(name: string, f: (h: Sync) => T): Promise<T> {
  const h = await handle(name, true) as FileSystemFileHandle & { createSyncAccessHandle(): Promise<Sync> };
  const s = await h.createSyncAccessHandle();
  try { return f(s); } finally { s.flush(); s.close(); }
}
export const opfsStore: Store = {
  async size(name) { const h = await handle(name); return h ? (await h.getFile()).size : 0; },
  write: (name, at, bytes) => withSync(name, s => { s.write(bytes, { at }); }),
  truncate: (name, n) => withSync(name, s => s.truncate(n)),
  async remove(name) { const d = await dir(); for (const n of [name, name + ".ok"]) await d.removeEntry(n).catch(() => {}); },
  async isDone(name) { return !!(await handle(name + ".ok")); },
  async markDone(name, done) { if (done) await handle(name + ".ok", true); else await (await dir()).removeEntry(name + ".ok").catch(() => {}); },
};
// A downloaded model file, from any context (page or worker); undefined until it is complete
export async function modelFile(url: string): Promise<File | undefined> {
  const n = nameOf(url);
  if (!(await handle(n + ".ok"))) return undefined;
  return (await handle(n))?.getFile() ?? undefined;
}
export async function usedBytes(): Promise<number> {
  let n = 0; const d = await dir() as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };
  for await (const h of d.values()) if (h.kind === "file") n += (await (h as FileSystemFileHandle).getFile()).size;
  return n;
}

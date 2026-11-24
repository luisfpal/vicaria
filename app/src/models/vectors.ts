// Passage vectors per book, in the private file system ("vectors/<book>"): one byte per dimension (the vectors are
// unit length, so each value times 127 fits a byte; ranking is unchanged in the eval), plus the passage ids in order.
// Written as it goes, so embedding a book resumes where it stopped.
export const DIM = 768;
const dir = () => navigator.storage.getDirectory().then(r => r.getDirectoryHandle("vectors", { create: true }));
const safe = (book: string) => book.replace(/[^\w.-]+/g, "_");

export interface BookVectors { ids: string[]; v: Int8Array }
export async function readVectors(book: string): Promise<BookVectors> {
  try {
    const d = await dir();
    const ids = JSON.parse(await (await (await d.getFileHandle(`${safe(book)}.json`)).getFile()).text()) as string[];
    const v = new Int8Array(await (await (await d.getFileHandle(`${safe(book)}.i8`)).getFile()).arrayBuffer());
    const n = Math.min(ids.length, Math.floor(v.length / DIM));
    return { ids: ids.slice(0, n), v: v.subarray(0, n * DIM) };
  } catch { return { ids: [], v: new Int8Array(0) }; }
}
export const quantize = (f: Float32Array) => Int8Array.from(f, x => Math.max(-127, Math.min(127, Math.round(x * 127))));

type Sync = { write(b: ArrayBufferView, o: { at: number }): number; flush(): void; close(): void; truncate(n: number): void };
// append vectors (worker only: sync access handles); ids file rewritten after the bytes, so ids never run ahead
export async function appendVectors(book: string, have: BookVectors, ids: string[], vecs: Int8Array[]): Promise<BookVectors> {
  const d = await dir();
  const h = await d.getFileHandle(`${safe(book)}.i8`, { create: true }) as FileSystemFileHandle & { createSyncAccessHandle(): Promise<Sync> };
  const s = await h.createSyncAccessHandle();
  const add = new Int8Array(vecs.length * DIM); vecs.forEach((x, i) => add.set(x, i * DIM));
  try { s.truncate(have.ids.length * DIM); s.write(add, { at: have.ids.length * DIM }); } finally { s.flush(); s.close(); }
  const all = [...have.ids, ...ids];
  const jh = await d.getFileHandle(`${safe(book)}.json`, { create: true }) as FileSystemFileHandle & { createSyncAccessHandle(): Promise<Sync> };
  const js = await jh.createSyncAccessHandle(); const b = new TextEncoder().encode(JSON.stringify(all));
  try { js.truncate(0); js.write(b, { at: 0 }); } finally { js.flush(); js.close(); }
  const v = new Int8Array(have.v.length + add.length); v.set(have.v); v.set(add, have.v.length);
  return { ids: all, v };
}
export async function removeVectors(book: string) { const d = await dir(); for (const e of [".i8", ".json"]) await d.removeEntry(safe(book) + e).catch(() => {}); }

// passages by meaning: dot product of the query with each stored vector, best first
export function nearest(q: Float32Array, bv: BookVectors, k: number, allow?: Set<string>): { id: string; score: number }[] {
  const out: { id: string; score: number }[] = [];
  for (let i = 0; i < bv.ids.length; i++) {
    if (allow && !allow.has(bv.ids[i])) continue;
    let d = 0; const o = i * DIM; for (let j = 0; j < DIM; j++) d += q[j] * bv.v[o + j];
    out.push({ id: bv.ids[i], score: d / 127 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

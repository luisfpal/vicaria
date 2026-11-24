// The sync store over this device's database: the op log, the original book files, and chunks of books still
// arriving (kept in "partials" as [sha256, chunk number] so a cut transfer resumes).
import type { SyncStore, BookHave } from "./protocol";
import { allOps, mergeOps, device } from "../core/ops";
import { getAll, getAllKeys, put, del, get } from "../core/idb";
import { listBooks } from "../core/read";
import { readOriginal } from "../core/originals";
import { shelfStates } from "../core/shelf";
import type { Op } from "../core/types";

const range = (sha: string) => IDBKeyRange.bound([sha], [sha, []]);
export async function idbStore(lib: string, addBook: (bytes: Uint8Array) => Promise<void>): Promise<SyncStore> {
  const dev = await device();
  // newest op time per book: books being read now come first
  const recent = (ops: Op[]) => { const m = new Map<string, number>(); for (const o of ops) { const b = (typeof o.v.book === "string" ? o.v.book : o.b) ?? ""; if ((m.get(b) ?? 0) < o.t) m.set(b, o.t); } return m; };
  return {
    lib, dev,
    ops: allOps,
    merge: mergeOps,
    async books(): Promise<BookHave[]> {
      const ops = await allOps(), t = recent(ops);
      return (await listBooks()).map(b => ({ sha: b.sha256, size: b.size, t: t.get(b.id) }));
    },
    async wants(offered) {
      const here = new Set((await listBooks()).map(b => b.sha256));
      const ops = await allOps(), states = shelfStates(ops), t = recent(ops);
      const trashed = new Set(((await get<{ sha256: string }[]>("kv", "trash")) ?? []).map(x => x.sha256));
      return offered
        .filter(b => typeof b.sha === "string" && /^[0-9a-f]{64}$/.test(b.sha) && !here.has(b.sha) && !trashed.has(b.sha) && states.get(b.sha.slice(0, 16))?.state !== "trash")
        .sort((a, b) => (t.get(b.sha.slice(0, 16)) ?? b.t ?? 0) - (t.get(a.sha.slice(0, 16)) ?? a.t ?? 0) || a.size - b.size)
        .map(b => b.sha);
    },
    async readOriginal(sha) { const b = await readOriginal(sha); return b ? new Uint8Array(await b.arrayBuffer()) : null; },
    async partials(sha) { return ((await getAllKeys("partials", range(sha))) as [string, number][]).map(k => k[1]).sort((a, b) => a - b); },
    async putPartial(sha, i, bytes) { await put("partials", bytes, [sha, i]); },
    async assemble(sha, n) {
      const parts = (await getAll<Uint8Array>("partials", range(sha)));
      const keys = (await getAllKeys("partials", range(sha))) as [string, number][];
      if (keys.length !== n || keys.some((k, i) => k[1] !== i)) return null;
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      return out;
    },
    async dropPartials(sha) { await del("partials", range(sha)); },
    async addBook(_sha, bytes) { await addBook(bytes); },
    async sha256(bytes) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map(b => b.toString(16).padStart(2, "0")).join(""); },
  };
}

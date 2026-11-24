// A small promise wrapper over IndexedDB. Works on the main thread and in workers.
export const DB_NAME = "vicaria";
import { MIGRATIONS, TEST_STORES, runMigrations } from "./migrations";
export const DB_VERSION = MIGRATIONS.length; // one numbered migration per version (docs/MIGRATIONS.md)
export const STORES = ["books", "heads", "sections", "passages", "images", "originals", "ops", "kv", "anchors", "partials", "segs", "opids"] as const;
export type StoreName = typeof STORES[number];

let dbp: Promise<IDBDatabase> | null = null;
// What happened the last time this context opened the database (shown by the app when an upgrade failed)
export const openState: { upgraded?: { from: number; to: number }; failed?: { from: number; to: number; error: string }; newer?: number; unusable?: string[] } = {};

// Open at DB_VERSION, running the numbered migrations. Before they run, the records a reader cannot get back
// (ops, settings, the book list) are read in the same upgrade transaction and saved to a snapshot file afterwards.
// If the upgrade fails, the browser keeps the old version and records; the app then opens it as it is and keeps
// working (changes are additive, so the current code can use an older structure it knows) and retries next launch.
// An older build that meets a newer database opens it as it is too.
export function db(): Promise<IDBDatabase> {
  return dbp ??= openAt(DB_VERSION).catch(async (e: Error & { name?: string }) => {
    const cur = await openAt(undefined);
    if (e.name === "VersionError") openState.newer = cur.version;
    else openState.failed = { from: cur.version, to: DB_VERSION, error: openState.failed?.error ?? e.message };
    // a structure this code cannot work with: the app goes back to the previous build (updates.ts) or, if there is
    // none, offers to save the notes; nothing is written meanwhile
    const missing = [...STORES, ...TEST_STORES].filter(s => !cur.objectStoreNames.contains(s));
    if (missing.length) openState.unusable = missing;
    return cur;
  });
}
// tests: forget the open connection so the next call opens again
export async function resetDb() { const p = dbp; dbp = null; for (const k of Object.keys(openState)) delete (openState as Record<string, unknown>)[k]; try { (await p)?.close(); } catch { /* never opened */ } }
function openAt(version: number | undefined): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    let snap: Promise<Snapshot> | null = null;
    r.onupgradeneeded = e => {
      const d = r.result, t = r.transaction!, from = e.oldVersion, to = e.newVersion ?? DB_VERSION;
      const migrate = () => { try { runMigrations(d, t, from, to); openState.upgraded = { from, to }; } catch (err) { openState.failed = { from, to, error: (err as Error).message }; t.abort(); } };
      if (from === 0) { migrate(); return; }
      // read first, then migrate in the last read's callback, so the snapshot shows the library as it was
      const names = (["ops", "segs", "kv", "books"] as const).filter(n => d.objectStoreNames.contains(n));
      const out: Snapshot = { from, to, at: Date.now(), ops: [], segs: [], kv: [], books: [] };
      let left = names.length;
      snap = new Promise(res => {
        if (!left) { res(out); migrate(); return; }
        for (const n of names) {
          const s = t.objectStore(n);
          if (n === "kv") { const ks = s.getAllKeys(), vs = s.getAll(); vs.onsuccess = () => { out.kv = (ks.result as IDBValidKey[]).map((k, i) => [k, vs.result[i]]); if (!--left) { res(out); migrate(); } }; }
          else { const q = s.getAll(); q.onsuccess = () => { (out as unknown as Record<string, unknown[]>)[n] = q.result; if (!--left) { res(out); migrate(); } }; }
        }
      });
    };
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbp = null; }; if (snap) snap.then(saveSnapshot).catch(() => {}); ok(r.result); };
    r.onerror = () => { if (snap) snap.then(saveSnapshot).catch(() => {}); bad(r.error ?? new Error("open failed")); };
    r.onblocked = () => bad(new Error("storage is busy in another tab"));
  });
}

// ---- snapshots taken before an upgrade (OPFS, the last three) ----
export interface Snapshot { from: number; to: number; at: number; ops: unknown[]; segs: unknown[]; kv: [IDBValidKey, unknown][]; books: unknown[] }
const KEEP = 3;
async function snapDir(): Promise<FileSystemDirectoryHandle | null> {
  try { return await (await navigator.storage.getDirectory()).getDirectoryHandle("snapshots", { create: true }); } catch { return null; }
}
export async function saveSnapshot(s: Snapshot): Promise<string | null> {
  if (!s.ops.length && !s.segs.length && !s.kv.length) return null;
  const d = await snapDir(); if (!d) return null;
  const name = `v${s.from}-to-v${s.to}-${s.at}.json`;
  const w = await (await d.getFileHandle(name, { create: true })).createWritable(); await w.write(JSON.stringify(s)); await w.close();
  const all: string[] = []; for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) all.push(k);
  for (const old of all.filter(n => n.endsWith(".json")).sort((a, b) => +b.split("-").pop()!.slice(0, -5) - +a.split("-").pop()!.slice(0, -5)).slice(KEEP)) await d.removeEntry(old).catch(() => {});
  return name;
}
export async function listSnapshots(): Promise<string[]> {
  const d = await snapDir(); if (!d) return [];
  const all: string[] = []; for await (const k of (d as unknown as { keys(): AsyncIterable<string> }).keys()) if (k.endsWith(".json")) all.push(k);
  return all.sort().reverse();
}
export async function readSnapshot(name: string): Promise<Snapshot | null> {
  const d = await snapDir(); if (!d) return null;
  try { return JSON.parse(await (await (await d.getFileHandle(name)).getFile()).text()); } catch { return null; }
}
const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return req((await db()).transaction(store).objectStore(store).get(key));
}
export async function getAll<T>(store: StoreName, range?: IDBKeyRange): Promise<T[]> {
  return req((await db()).transaction(store).objectStore(store).getAll(range));
}
export async function getAllByIndex<T>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
  return req((await db()).transaction(store).objectStore(store).index(index).getAll(key));
}
export async function getAllKeys(store: StoreName, range?: IDBKeyRange): Promise<IDBValidKey[]> {
  return req((await db()).transaction(store).objectStore(store).getAllKeys(range));
}
export async function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const tx = (await db()).transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  return done(tx);
}
export async function del(store: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
  const tx = (await db()).transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  return done(tx);
}
export function done(tx: IDBTransaction) { return new Promise<void>((ok, bad) => { tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error); tx.onabort = () => bad(tx.error || new Error("aborted")); }); }
export async function tx(stores: StoreName[], fn: (t: IDBTransaction) => void): Promise<void> {
  const t = (await db()).transaction(stores, "readwrite");
  fn(t);
  return done(t);
}
export const bookRange = (id: string) => IDBKeyRange.bound([id], [id, []]);

// Several reads in one transaction, so a compaction running at the same time can never be seen half done.
export async function readTogether<T extends unknown[]>(stores: StoreName[], reads: (t: IDBTransaction) => { [K in keyof T]: IDBRequest<T[K]> }): Promise<T> {
  const t = (await db()).transaction(stores);
  return Promise.all(reads(t).map(r => req(r))) as Promise<T>;
}

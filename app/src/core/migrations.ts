// IndexedDB structure, one numbered step per version (docs/MIGRATIONS.md). Step n takes the database from version n - 1
// to n inside the browser's upgrade transaction: if a step throws, the browser undoes the whole upgrade and the
// database keeps its old version and every record. Steps are idempotent and additive: they check before they create
// and never delete or rename what an older release reads.
type Step = (d: IDBDatabase, t: IDBTransaction) => void;
const store = (d: IDBDatabase, name: string, o?: IDBObjectStoreParameters) => d.objectStoreNames.contains(name) ? null : d.createObjectStore(name, o);

export const MIGRATIONS: Step[] = [
  // 1: books and their derived parts, original files, the op log
  d => {
    store(d, "books", { keyPath: "id" });
    store(d, "heads", { keyPath: "meta.id" });
    store(d, "sections");   // [bookId, idx]
    store(d, "passages");   // bookId
    store(d, "images");     // [bookId, path]
    store(d, "originals");  // sha256 (when OPFS is missing)
    store(d, "ops", { keyPath: "id" })?.createIndex("t", "t");
  },
  // 2: settings and state, re-found places of 0.x marks (derived), chunks of books still arriving
  d => { store(d, "kv"); store(d, "anchors"); store(d, "partials"); },
  // 3: ops are found by book ("bk": v.book, or the 0.x key b), so opening a book never reads the whole log
  (_d, t) => {
    const ops = t.objectStore("ops");
    if (ops.indexNames.contains("bk")) return;
    ops.createIndex("bk", "bk");
    ops.openCursor().onsuccess = e => {
      const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result; if (!c) return;
      const o = c.value as { v?: { book?: unknown }; b?: unknown; bk?: unknown };
      const bk = typeof o.v?.book === "string" ? o.v.book : typeof o.b === "string" ? o.b : undefined;
      if (bk !== undefined && o.bk !== bk) c.update({ ...o, bk });
      c.continue();
    };
  },
  // 4: ops of a book packed into segments of up to 2,000 ("opids": which ops are packed, so a merge never adds one twice)
  d => { store(d, "segs", { keyPath: "id" })?.createIndex("bk", "bk"); store(d, "opids"); },
];

// test hook: an extra step that throws, or one that succeeds, to check rollback and upgrades in a real browser
// (only in builds made with VITE_TEST_MIGRATION; normal builds never have it)
const extra = import.meta.env?.VITE_TEST_MIGRATION as string | undefined;
// Both builds need the store the step makes, so after the failure the library is unusable for that build.
if (extra === "fail") MIGRATIONS.push(d => { store(d, "test_extra"); throw new Error("test: this migration fails on purpose"); });
if (extra === "ok") MIGRATIONS.push(d => { store(d, "test_extra"); });
export const TEST_STORES: string[] = extra === "fail" || extra === "ok" ? ["test_extra"] : [];

export function runMigrations(d: IDBDatabase, t: IDBTransaction, from: number, to = MIGRATIONS.length) {
  for (let v = from + 1; v <= to; v++) MIGRATIONS[v - 1](d, t);
}

// The structure of an open database, for schema.json and its check in CI
export interface Schema { version: number; stores: Record<string, { keyPath: string | string[] | null; autoIncrement: boolean; indexes: Record<string, { keyPath: string | string[]; unique: boolean; multiEntry: boolean }> }> }
export function schemaOf(d: IDBDatabase): Schema {
  const t = d.transaction([...d.objectStoreNames]);
  const stores: Schema["stores"] = {};
  for (const name of [...d.objectStoreNames].sort()) {
    const s = t.objectStore(name), indexes: Schema["stores"][string]["indexes"] = {};
    for (const i of [...s.indexNames].sort()) { const x = s.index(i); indexes[i] = { keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry }; }
    stores[name] = { keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes };
  }
  return { version: d.version, stores };
}

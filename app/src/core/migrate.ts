// Versioned user data. Each migration runs once, in order, and is recorded in kv "schema".
import { SCHEMA_VERSION } from "./types";
import { get, put } from "./idb";

export type Migration = { to: number; run: () => Promise<void> };
export const MIGRATIONS: Migration[] = [
  { to: 1, run: async () => { /* first schema: stores are created by idb.ts */ } },
];

export async function migrate(list: Migration[] = MIGRATIONS, target = SCHEMA_VERSION): Promise<number> {
  let v = (await get<number>("kv", "schema")) || 0;
  if (v > target) throw new Error(`This library was made by a newer Vicaria (data version ${v}). Update the app to open it.`);
  for (const m of list.filter(m => m.to > v && m.to <= target).sort((a, b) => a.to - b.to)) {
    await m.run();
    v = m.to;
    await put("kv", v, "schema");
  }
  return v;
}

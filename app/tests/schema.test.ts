// The IndexedDB structure built from code must match schema.json, and DB_VERSION must equal the number of
// migration steps (docs/MIGRATIONS.md). To accept a reviewed change: WRITE_SCHEMA=1 npx vitest run tests/schema.test.ts
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { db, DB_VERSION, resetDb } from "../src/core/idb";
import { MIGRATIONS, schemaOf, type Schema } from "../src/core/migrations";

const FILE = new URL("../schema.json", import.meta.url);

describe("stored data structure", () => {
  it("has one migration step per version", () => { expect(DB_VERSION).toBe(MIGRATIONS.length); });
  it("matches schema.json (a change needs a version bump, a migration step and a reviewed schema.json)", async () => {
    await resetDb(); indexedDB.deleteDatabase("vicaria");
    const now = schemaOf(await db());
    if (process.env.WRITE_SCHEMA) writeFileSync(FILE, JSON.stringify(now, null, 1) + "\n");
    expect(existsSync(FILE)).toBe(true);
    const saved: Schema = JSON.parse(readFileSync(FILE, "utf8"));
    // never remove: every store and index of the committed schema must still exist (older releases read them)
    for (const [name, st] of Object.entries(saved.stores)) {
      expect(now.stores[name], `store ${name} was removed`).toBeDefined();
      for (const i of Object.keys(st.indexes)) expect(now.stores[name].indexes[i], `index ${name}.${i} was removed`).toBeDefined();
    }
    if (JSON.stringify(now.stores) !== JSON.stringify(saved.stores)) expect(now.version, "the structure changed: bump DB_VERSION with a new migration step").toBeGreaterThan(saved.version);
    expect(now).toEqual(saved);
  });
});

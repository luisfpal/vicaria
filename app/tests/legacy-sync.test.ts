// Old and new devices in one library: the real 0.x sync code (Python, book_reader/sync.py) exports a snapshot, 1.0
// reads it, adds its own changes, and sends a snapshot back that 0.x imports. Ops that cross keep their exact bytes.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toLegacy, fromLegacy } from "../src/sync/legacy-snap";
import { clean } from "../src/core/ops";
import type { Op } from "../src/core/types";

const PY = new URL("./py/zero.py", import.meta.url).pathname;
const BOOK = new URL("../../tests/corpus/meditations-se.epub", import.meta.url).pathname;
const zero = (dir: string, cmd: string, input?: unknown, extra: string[] = []) => JSON.parse(execFileSync("python3", [PY, dir, cmd, ...extra], { input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8" }));
const LIB = "cp-0123456789abcdef";
const card = async (key: string, name: string, text: string): Promise<Op> => ({ id: `card.${key}${name}`.replace(/[^a-z0-9.]/g, ""), dev: "card", t: 0, k: "card", v: { name, text }, b: key });
const line = (o: unknown) => JSON.stringify(o); // Python writes compact JSON too (separators=(",", ":"), ensure_ascii=False)

describe("old and new devices", () => {
  it("swap snapshots with the real 0.x code, byte for byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vic0-"));
    const { book } = zero(dir, "setup", undefined, [BOOK]);
    const exp0 = zero(dir, "export");
    // 1.0 reads 0.x's snapshot
    const got = (await fromLegacy({ v: 1, dev: "dev-old1", sent: 1, data: exp0 }, LIB, card))!;
    expect(got.ops.map(o => o.id).sort()).toEqual(["dev-old1.1700000000000000001", "dev-old1.1700000000000000002", "dev-old1.1700000000000000003"]);
    expect(got.ops.find(o => o.k === "pos")!.b).toBe(book);
    expect(got.have.map(h => h.id)).toContain(book);
    // what 1.0 holds: those, an alias for the book, a 1.0 mark and position (not for 0.x), 0.x-format changes 1.0 made
    const newId = "aaaabbbbccccdddd";
    const mine: Op[] = [
      ...got.ops,
      clean({ id: "dnew1.1", dev: "dnew1", t: 1700000001000, c: 0, k: "alias", v: { old: book, book: newId, sha256: newId.repeat(4) } })!,
      clean({ id: "dnew1.2", dev: "dnew1", t: 1700000002000, c: 0, k: "mark", v: { id: "m1", book: newId, set: { color: "green" } } })!,
      clean({ id: "dnew1.3", dev: "dnew1", t: 1700000003000, k: "pos", v: { book: newId, section: 4, block: 2 } })!,
      clean({ id: "dnew1.4", dev: "dnew1", t: 1700000004000, k: "reader", v: { theme: "dark", size: 20 } })!,
      clean({ id: "dnew1.5", dev: "dnew1", t: 1700000005000, k: "shelf", v: { book, state: "shelf" } })!,
    ];
    const snap = toLegacy(mine, LIB, "dnew1", [{ id: newId, title: "Meditations" }]);
    expect(snap.data.have).toEqual([{ id: book, title: "Meditations" }]);
    const back = zero(dir, "import", snap.data);
    expect(back.result.skipped_books).toEqual([]);
    const exp1 = back.export;
    // everything 0.x had is unchanged; 1.0's 0.x-format ops arrived with the same bytes; 1.0-only ops stayed out
    const lines0 = new Set([...exp1.books[book], ...exp1.reader].map(line));
    for (const o of [...exp0.books[book], ...exp0.reader]) expect(lines0.has(line(o))).toBe(true);
    for (const id of ["dnew1.4", "dnew1.5"]) { const o = mine.find(x => x.id === id)!; expect(lines0.has(line(clean(o)))).toBe(true); }
    const ids1 = new Set([...exp1.books[book], ...exp1.reader].map((o: Op) => o.id));
    for (const id of ["dnew1.1", "dnew1.2", "dnew1.3"]) expect(ids1.has(id)).toBe(false);
    // and 1.0 reading 0.x's ops again gets the same bytes it holds
    const again = (await fromLegacy({ v: 1, dev: "dev-old1", sent: 2, data: exp1 }, LIB, card))!;
    const held = new Map(mine.map(o => [o.id, line(clean(o))]));
    for (const o of again.ops) if (held.has(o.id)) expect(line(clean(o))).toBe(held.get(o.id));
  }, 60_000);
  it("ignores a snapshot from another library", async () => {
    expect(await fromLegacy({ v: 1, dev: "x", sent: 1, data: { library: "cp-other", books: {}, reader: [] } }, LIB, card)).toBeNull();
  });
});

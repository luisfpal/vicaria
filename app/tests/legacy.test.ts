import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readLegacy, migrateLegacy } from "../src/core/legacy";
import { importBytes, listBooks, head } from "../src/core/library";
import { allOps, anchorsMap, highlights, position, resolver } from "../src/core/ops";

const FIX = new URL("../../tests/fixtures/legacy-0.x/", import.meta.url).pathname;
const CORPUS = new URL("../../tests/corpus/", import.meta.url).pathname;

// Writes the 0.x fixture into an IDBFS-shaped database "/data", as the 0.x app left it.
async function plantLegacy() {
  const dump = JSON.parse(readFileSync(FIX + "idbfs.json", "utf8"));
  await new Promise<void>((ok, bad) => {
    const r = indexedDB.open("/data", dump.version);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore("FILE_DATA"); s.createIndex("timestamp", "timestamp"); };
    r.onsuccess = () => {
      const t = r.result.transaction("FILE_DATA", "readwrite"), s = t.objectStore("FILE_DATA");
      for (const row of dump.stores[0].rows) {
        const v: Record<string, unknown> = { timestamp: new Date(row.timestamp), mode: row.mode };
        if (row.corpus) v.contents = new Uint8Array(readFileSync(CORPUS + row.corpus));
        else if (row.b64) v.contents = new Int8Array(Buffer.from(row.b64, "base64"));
        s.put(v, row.key);
      }
      t.oncomplete = () => { r.result.close(); ok(); }; t.onerror = () => bad(t.error);
    };
    r.onerror = () => bad(r.error);
  });
}

describe("moving a 0.x library", () => {
  it("finds nothing when there is no 0.x library, and creates nothing", async () => {
    expect(await readLegacy()).toBeNull();
    expect((await indexedDB.databases()).some(d => d.name === "/data")).toBe(false);
  });
  it("moves every book, honors removals, keeps cards and pending changes, and re-finds at least 99% of highlights", async () => {
    await plantLegacy();
    const files = (await readLegacy())!;
    const expected = JSON.parse(readFileSync(FIX + "expected.json", "utf8"));
    const rep = await migrateLegacy(files, b => importBytes(b));
    expect(rep.books.length).toBe(5);
    expect(rep.failed).toEqual([]);
    const want = Object.values(expected.books as Record<string, { highlights: unknown[] }>).reduce((n, b) => n + b.highlights.length, 0);
    expect(rep.highlights.total).toBe(want);
    console.log(`highlights placed ${rep.highlights.placed}/${rep.highlights.total}; missed: ${JSON.stringify(rep.highlights.missed)}`);
    expect(rep.highlights.placed / rep.highlights.total).toBeGreaterThanOrEqual(0.99);
    expect(rep.cards).toBe(2);
    expect(rep.pending).toBe(1);
    expect(rep.reader).toMatchObject({ theme: "sepia" });
    // every placed highlight's text is the quote 0.x stored (whitespace aside)
    const ops = await allOps(), res = resolver(ops, await anchorsMap());
    // the quote's words appear in the anchored text in order (0.x left math out of its quotes; the new text keeps it)
    const inOrder = (q: string, t: string) => { let at = 0; const tt = t.normalize("NFC"); for (const w of q.normalize("NFC").split(/\s+/).filter(Boolean)) { const i = tt.indexOf(w, at); if (i < 0) return false; at = i + w.length; } return true; };
    let same = 0, n = 0;
    for (const b of rep.books) {
      const hs = highlights(ops, b.id, res);
      const exp = expected.books[b.old].highlights as { id: string; quote: string }[];
      for (const h of hs) { const e = exp.find(x => x.id === h.id); if (!e) continue; n++; if (inOrder(e.quote, h.anchor.exact)) same++; }
      expect(position(ops, b.id, res)).toBeTruthy();
    }
    console.log(`exact text match ${same}/${n}`);
    expect(same / n).toBeGreaterThanOrEqual(0.97);
    // running it again changes nothing
    const before = (await allOps()).length;
    const again = await migrateLegacy(files, b => importBytes(b));
    expect((await allOps()).length).toBe(before);
    expect(again.highlights.placed).toBe(rep.highlights.placed);
    expect((await listBooks()).length).toBe(5);
    expect(await head(rep.books[0].id)).toBeTruthy();
  }, 60000);
});

describe("block text matches what the browser shows", () => {
  it("turns CRLF and CR into LF like the HTML parser, so offsets match the page", async () => {
    const { blockTexts, locate } = await import("../src/core/reanchor");
    const bs = blockTexts(0, '<p data-b="0">one\r\ntwo\rthree <math><mi>x</mi></math> four</p>');
    expect(bs[0].text).toBe("one\ntwo\nthree x four");
    const a = locate(bs, "two three four")!;
    expect(a.offset).toBe(4);
    expect(bs[0].text.slice(a.offset, a.endOffset)).toBe("two\nthree x four");
  });
});

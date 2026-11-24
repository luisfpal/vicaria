import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import fc from "fast-check";
import { unzipSync, zipSync } from "fflate";
import { cleanAuthor, parseEpub, EpubError } from "../src/core/epub";
import type { BookDoc } from "../src/core/types";
import { makeEpub } from "./fixtures";

const CORPUS = new URL("../../tests/corpus/", import.meta.url).pathname;
const books = readdirSync(CORPUS).filter(f => f.endsWith(".epub")).sort();
const docs = new Map<string, { doc: BookDoc; ms: number }>();
async function load(f: string) {
  if (!docs.has(f)) { const t0 = performance.now(); const { doc } = await parseEpub(new Uint8Array(readFileSync(CORPUS + f)), 0); docs.set(f, { doc, ms: performance.now() - t0 }); }
  return docs.get(f)!;
}

describe("corpus", () => {
  it.each(books)("%s: summary snapshot", async f => {
    const { doc } = await load(f);
    const s = doc.stats;
    expect({ title: doc.meta.title, author: doc.meta.author, language: doc.meta.language, dir: doc.meta.dir, vertical: doc.meta.vertical, start: doc.meta.start,
      toc: doc.toc.slice(0, 5).map(t => `${t.depth}:${t.title}@${t.section}.${t.block}`), sections: s.sections, notes: s.notes, noterefs: s.noterefs,
      resolved: s.resolved, math: s.math, firstPassages: doc.passages.slice(0, 3).map(p => `${p.id} [${p.chapter}] ${p.text.slice(0, 60)}`) }).toMatchSnapshot();
  });
  it.each(books)("%s: every note reference resolves or is reported", async f => {
    const { doc } = await load(f);
    const s = doc.stats;
    expect(s.resolved + s.unresolved.length).toBe(s.noterefs);
    for (const sec of doc.sections) for (const m of sec.html.matchAll(/data-note="([^"]+)"/g)) expect(doc.notes[m[1]], m[1]).toBeTruthy();
  });
  it.each(books)("%s: output is safe and blocks are consistent", async f => {
    const { doc } = await load(f);
    for (const sec of doc.sections) {
      expect(sec.html).not.toMatch(/<script|\son[a-z]+\s*=|javascript:/i);
      const bs = [...sec.html.matchAll(/data-b="(\d+)"/g)].map(m => +m[1]);
      if (!sec.fixed) expect(bs).toEqual(bs.map((_, i) => i));
      if (!sec.fixed) expect(bs.length).toBe(sec.blocks.length);
    }
    for (const p of doc.passages) expect(p.b1).toBeGreaterThanOrEqual(p.b0);
  });
  it.each(books.filter(b => !b.includes("kusamakura")))("%s: imports in under 2 s", async f => {
    // the first parse runs cold and beside 30 other test files: it has a looser budget of its own, and a miss of the
    // 2 s budget is measured once more before it counts
    let { ms } = await load(f);
    expect(ms, "cold parse").toBeLessThan(4000);
    if (ms >= 2000) { const t0 = performance.now(); await parseEpub(new Uint8Array(readFileSync(CORPUS + f)), 0); ms = Math.min(ms, performance.now() - t0); }
    expect(ms).toBeLessThan(2000);
  });
  it("Meditations: all 122 notes resolve and pop over with their text", async () => {
    const { doc } = await load("meditations-se.epub");
    expect(doc.stats.noterefs).toBe(122);
    expect(doc.stats.resolved).toBe(122);
    const n = Object.values(doc.notes)[0];
    expect(n.html.length).toBeGreaterThan(20);
    expect(n.html).not.toMatch(/backlink|↩/);
  });
  it("linear algebra: MathML survives", async () => {
    const { doc } = await load("idpf-linear-algebra.epub");
    expect(doc.stats.math).toBeGreaterThan(10000);
    expect(doc.sections.some(s => s.html.includes('<math xmlns="http://www.w3.org/1998/Math/MathML"'))).toBe(true);
  });
  it("Arabic sample is right to left, Japanese sample is vertical", async () => {
    expect((await load("idpf-regime-anticancer-arabic.epub")).doc.meta.dir).toBe("rtl");
    if (existsSync(CORPUS + "idpf-kusamakura-japanese-vertical-writing.epub")) expect((await load("idpf-kusamakura-japanese-vertical-writing.epub")).doc.meta.vertical).toBe(true);
  });
  it("Gutenberg books open at chapter one, and the license is left out of passages", async () => {
    const art = (await load("pg132.epub")).doc, q = (await load("pg2000.epub")).doc;
    expect(art.sections[art.meta.start].blocks[art.meta.startBlock ?? 0]).toMatch(/^Chapter I\b/);
    expect(q.sections[q.meta.start].blocks[q.meta.startBlock ?? 0]).toMatch(/^Capítulo primero/);
    for (const d of [art, q]) {
      expect(d.passages.some(p => /PROJECT GUTENBERG|Project Gutenberg License|gutenberg\.org\/license/i.test(p.text) && /START OF|END OF|FULL PROJECT/i.test(p.text))).toBe(false);
      expect(d.sections.at(-1)!.kind).toBe("back");
    }
    expect(art.meta.author).toBe("Sunzi");
  });
  it("fixed layout pages are kept as sandboxable pages", async () => {
    const { doc } = await load("idpf-sous-le-vent.epub");
    expect(doc.sections.every(s => s.fixed)).toBe(true);
    expect(doc.meta.start).toBe(0);
  });
});

describe("fixtures", () => {
  it("Standard Ebooks style m:math with alttext", async () => {
    const { doc } = await parseEpub(makeEpub({ "a.xhtml": `<p>Area is <m:math alttext="pi r squared"><m:mi>π</m:mi><m:msup><m:mi>r</m:mi><m:mn>2</m:mn></m:msup></m:math> exactly.</p>` }));
    expect(doc.stats.math).toBe(1);
    expect(doc.sections[0].html).toContain("<msup><mi>r</mi><mn>2</mn></msup>");
    expect(doc.sections[0].blocks[0]).toContain("pi r squared");
    expect(doc.stats.noterefs).toBe(0); // the superscript 2 is math, never a footnote
  });
  it("Gutenberg style bracket footnotes become notes", async () => {
    const { doc } = await parseEpub(makeEpub({ "a.xhtml": `<p>Text<a href="#fn1" id="r1">[1]</a> more text<sup><a href="#fn2">2</a></sup>.</p><p>x</p><div class="footnotes"><p><a id="fn1" href="#r1">[1]</a> First note.</p><p id="fn2"><a href="#r1">2</a> Second note.</p></div>` }));
    expect(doc.stats.noterefs).toBe(2);
    expect(doc.stats.resolved).toBe(2);
    const html = Object.values(doc.notes).map(n => n.html).join(" ");
    expect(html).toContain("First note.");
    expect(html).toContain("Second note.");
  });
  it("superscripts without links stay typography", async () => {
    const { doc } = await parseEpub(makeEpub({ "a.xhtml": `<p>E = mc<sup>2</sup> and the 1<sup>st</sup> day.</p>` }));
    expect(doc.stats.noterefs).toBe(0);
    expect(doc.sections[0].html).toContain("<sup>2</sup>");
  });
  it("EPUB 3 aside footnotes are hidden in the flow and shown as notes", async () => {
    const { doc } = await parseEpub(makeEpub({ "a.xhtml": `<p>Claim<a epub:type="noteref" href="#n1">1</a>.</p><aside epub:type="footnote" id="n1"><p>The source.</p></aside>` }));
    expect(doc.stats.resolved).toBe(1);
    expect(doc.sections[0].html).toMatch(/<aside[^>]*hidden/);
    expect(Object.values(doc.notes)[0].html).toContain("The source.");
  });
  it("scripts, handlers and javascript links are removed", async () => {
    const { doc } = await parseEpub(makeEpub({ "a.xhtml": `<p onclick="alert(1)">Hi<script>alert(2)</script> <a href="javascript:alert(3)">x</a><img src="x.png" onerror="alert(4)"/></p>` }));
    expect(doc.sections[0].html).not.toMatch(/alert|onclick|onerror|script/);
  });
  it("DRM-locked files are refused with a plain message", async () => {
    const bytes = makeEpub({ "a.xhtml": "<p>x</p>" }, { extra: { "META-INF/encryption.xml": `<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>` } });
    await expect(parseEpub(bytes)).rejects.toThrow(/DRM/);
  });
});

describe("author names", () => {
  it("catalog forms read as names", () => {
    const cases: [string, string][] = [["active 6th century B.C. Sunzi", "Sunzi"], ["Dickens, Charles, 1812-1870", "Charles Dickens"], ["Cervantes Saavedra, Miguel de", "Miguel de Cervantes Saavedra"],
      ["Plato (427? BC-347? BC)", "Plato"], ["Laozi, active 6th century B.C.", "Laozi"], ["Martin Luther King, Jr.", "Martin Luther King, Jr."], ["Pr David Khayat, Nathalie Hutter-Lardeau", "Pr David Khayat, Nathalie Hutter-Lardeau"], ["Marcus Aurelius", "Marcus Aurelius"]];
    for (const [a, b] of cases) expect(cleanAuthor(a)).toBe(b);
  });
});

describe("author roles", () => {
  const withOpf = (creators: string) => {
    const z = unzipSync(makeEpub({ "ch1.xhtml": "<p>Text</p>" })), opf = new TextDecoder().decode(z["OEBPS/content.opf"]);
    z["OEBPS/content.opf"] = new TextEncoder().encode(opf.replace("<dc:creator>Test Author</dc:creator>", creators));
    return zipSync(z);
  };
  const role = (id: string, r: string) => `<meta property="role" refines="#${id}" scheme="marc:relators">${r}</meta>`;
  it("an author who also has other roles (Standard Ebooks lists aut, ann, ill) is still the author", async () => {
    const { doc } = await parseEpub(withOpf(`<dc:creator id="author">Charles Darwin</dc:creator>${role("author", "ann")}${role("author", "aut")}${role("author", "ill")}`));
    expect(doc.meta.author).toBe("Charles Darwin");
  });
  it("a creator whose only roles are not author (an illustrator listed as creator) is left out", async () => {
    const { doc } = await parseEpub(withOpf(`<dc:creator id="a">Jane Writer</dc:creator>${role("a", "aut")}<dc:creator id="i">Ivy Drawer</dc:creator>${role("i", "ill")}`));
    expect(doc.meta.author).toBe("Jane Writer");
  });
});

describe("fuzz", () => {
  const seed = new Uint8Array(readFileSync(CORPUS + "meditations-se.epub"));
  const entries = unzipSync(seed);
  const names = Object.keys(entries);
  const ok = (e: unknown) => e instanceof EpubError;
  it("random byte damage never crashes the importer", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.nat(seed.length - 1), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 40 }), async muts => {
      const b = seed.slice(); for (const [i, v] of muts) b[i] = v;
      try { await parseEpub(b); } catch (e) { if (!ok(e)) throw e; }
    }), { numRuns: 60 });
  }, 120000);
  it("missing or garbled entries never crash the importer", async () => {
    await fc.assert(fc.asyncProperty(fc.subarray(names), fc.subarray(names), fc.string(), async (drop, garble, junk) => {
      const files: Record<string, Uint8Array> = {};
      for (const n of names) if (!drop.includes(n)) files[n] = garble.includes(n) ? new TextEncoder().encode(junk + "<<<&&&" + junk) : entries[n];
      try { await parseEpub(zipSync(files)); } catch (e) { if (!ok(e)) throw e; }
    }), { numRuns: 80 });
  }, 120000);
  it("not a zip at all", async () => {
    await expect(parseEpub(new TextEncoder().encode("hello"))).rejects.toThrow(EpubError);
  });
});

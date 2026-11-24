import { readFileSync, readdirSync } from "node:fs";
import { parseEpub } from "../src/core/epub";
const dir = process.argv[2] || "../tests/corpus";
for (const f of readdirSync(dir).filter(f => f.endsWith(".epub")).sort()) {
  const bytes = new Uint8Array(readFileSync(`${dir}/${f}`));
  const t0 = performance.now();
  try {
    const { doc } = await parseEpub(bytes);
    const ms = Math.round(performance.now() - t0);
    const s = doc.stats;
    console.log(f.padEnd(48), `${ms}ms`, JSON.stringify({ title: doc.meta.title.slice(0, 30), lang: doc.meta.language, dir: doc.meta.dir, vert: doc.meta.vertical, start: doc.meta.start, toc: doc.toc.length, sec: s.sections, blocks: s.blocks, words: s.words, refs: s.noterefs, resolved: s.resolved, notes: s.notes, unres: s.unresolved.length, math: s.math, img: s.images, links: s.links, passages: doc.passages.length }));
  } catch (e) { console.log(f, "ERROR", (e as Error).message, (e as Error).stack?.split("\n")[1]); }
}

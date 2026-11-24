// After vite build: write sw.js with the exact file list and a content hash, plus 404.html for GitHub Pages routes.
import { readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

const DIST = process.env.VIC_DIST ? process.env.VIC_DIST.replace(/\/?$/, "/") : new URL("../dist/", import.meta.url).pathname;
const BASE = (process.env.VIC_BASE || "/").replace(/\/$/, "");
const SKIP = /(^|\/)(sw\.js|404\.html)$|^classics\/|^\.vite\//; // the classic is fetched once, on first run
const files = [];
const walk = d => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(relative(DIST, p)); } };
walk(DIST);
// Code only some answers need (math, diagrams) is not downloaded with the app: it is fetched the first time an answer
// uses it and kept from then on (sw.js caches it). Found from Vite's manifest: what only mermaid or katex pull in.
const lazyOnly = (() => {
  let m; try { m = JSON.parse(readFileSync(join(DIST, ".vite/manifest.json"), "utf8")); } catch { return new Set(); }
  const heavy = k => /node_modules\/(mermaid|katex|@mermaid-js|cytoscape|elkjs|pdfjs-dist)/.test(m[k].src || k);
  const walk = (roots, skipHeavy) => { const seen = new Set(), st = [...roots]; while (st.length) { const k = st.pop(); if (seen.has(k) || !m[k]) continue; if (skipHeavy && heavy(k)) continue; seen.add(k); st.push(...(m[k].imports || []), ...(m[k].dynamicImports || [])); } return seen; };
  const core = walk(Object.keys(m).filter(k => m[k].isEntry), true), lazy = walk(Object.keys(m).filter(heavy), false);
  const out = f => [m[f].file, ...(m[f].css || []), ...(m[f].assets || [])];
  const coreFiles = new Set([...core].flatMap(out));
  return new Set([...lazy].flatMap(out).filter(f => !coreFiles.has(f)));
})();
// PDF.js (the reader's copy, the books worker's copy and its own worker) is fetched the first time a PDF is added
// or opened. Worker chunks are not in the manifest, so these go by name.
const pdfOnly = f => /^assets\/pdf(view|\.worker[^/]*)?-[^/]+$/.test(f);
// The neural voice's runtime (ONNX Runtime's WebAssembly, espeak-ng's glue, the voice worker) is fetched once the
// voice has downloaded, when the page warms it up, so it is cached before the reader goes offline.
const voiceOnly = f => /^assets\/(voice\.worker|embed\.worker|whisper\.worker|ort-wasm[^/]*|piper-phonemize)-[^/]+$/.test(f);
// A page opened on a book: the reader's files (a chunk of their own, so the library's first script stays small) start
// downloading with the first script instead of after it runs.
(() => {
  let m; try { m = JSON.parse(readFileSync(join(DIST, ".vite/manifest.json"), "utf8")); } catch { return; }
  const k = Object.keys(m).find(x => /src\/ui\/reader\.tsx$/.test(x)); if (!k) return;
  const reach = (key, set) => { if (set.has(key) || !m[key]) return set; set.add(key); for (const i of m[key].imports || []) reach(i, set); return set; };
  const entry = new Set(); for (const e of Object.keys(m).filter(x => m[x].isEntry)) reach(e, entry);
  const pre = [...reach(k, new Set())].filter(x => !entry.has(x)).map(x => `${BASE}/${m[x].file}`);
  const tag = `<script>if(/\\/book\\/[0-9a-f]{16}/.test(location.pathname))for(const f of ${JSON.stringify(pre)}){const l=document.createElement("link");l.rel="modulepreload";l.href=f;document.head.append(l)}</script>`;
  const p = join(DIST, "index.html"); writeFileSync(p, readFileSync(p, "utf8").replace("</head>", tag + "</head>"));
})();
const keep = files.filter(f => !SKIP.test(f) && !lazyOnly.has(f) && !pdfOnly(f) && !voiceOnly(f) && !/(^|\/)KaTeX_[^/]+$/.test(f));
const h = createHash("sha256");
for (const f of keep) h.update(f).update(readFileSync(join(DIST, f)));
const version = h.digest("hex").slice(0, 12);
const tpl = readFileSync(new URL("./sw.template.js", import.meta.url), "utf8");
// version.txt is cached with the build, so a page can ask which build it runs (also after a step back)
writeFileSync(join(DIST, "version.txt"), version + "\n");
writeFileSync(join(DIST, "sw.js"), tpl.replace("__VERSION__", version).replace("__BASE__", BASE).replace("__FILES__", JSON.stringify([...keep, "version.txt"].map(f => `${BASE}/${f}`))));
copyFileSync(join(DIST, "index.html"), join(DIST, "404.html"));
console.log(`sw.js version ${version}, ${keep.length} files cached, ${files.length - keep.length} fetched when first needed`);

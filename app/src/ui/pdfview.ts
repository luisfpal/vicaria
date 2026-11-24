// Draws the pages of a PDF section as they come near the screen. PDF.js is loaded only here, so it costs nothing
// until a PDF is opened. The invisible text over each page is stretched to the width of the printed words, so a
// selection covers what the reader sees.
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { readOriginal } from "../core/originals";

const docs = new Map<string, Promise<PDFDocumentProxy>>();
async function open(sha: string): Promise<PDFDocumentProxy> {
  let d = docs.get(sha);
  if (!d) {
    d = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const blob = await readOriginal(sha); if (!blob) throw new Error("The original PDF is not on this device.");
      return pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), verbosity: 0 }).promise;
    })();
    d.catch(() => docs.delete(sha));
    docs.set(sha, d);
  }
  return d;
}

// Type sizes are in page units, so the stretch is the same at any width: measured once (all reads, then all writes)
function fitText(root: HTMLElement) {
  const spans = [...root.querySelectorAll<HTMLElement>(".pl span[data-w]")];
  for (const s of spans) s.style.transform = "";
  const ws = spans.map(s => [s.getBoundingClientRect().width, +s.dataset.w! / 100 * (s.closest<HTMLElement>(".pdfpage")?.clientWidth || 0)]);
  spans.forEach((s, i) => { const [have, want] = ws[i]; if (have > 0 && want > 0) s.style.transform = `scaleX(${(want / have).toFixed(4)})`; });
}

export function attachPdf(root: HTMLElement, sha: string): () => void {
  let alive = true;
  const drawn = new WeakMap<HTMLElement, number>(); // page -> width it was drawn at
  const tasks = new Set<{ cancel(): void }>();
  const draw = async (pg: HTMLElement) => {
    const w = pg.clientWidth; if (!w || drawn.get(pg) === w) return;
    drawn.set(pg, w);
    try {
      const doc = await open(sha); if (!alive) return;
      const page = await doc.getPage(+pg.dataset.page! + 1); if (!alive) return;
      const vp1 = page.getViewport({ scale: 1 });
      const dpr = Math.min(devicePixelRatio || 1, 2), vp = page.getViewport({ scale: w * dpr / vp1.width });
      const old = pg.querySelector("canvas")!;
      const c = document.createElement("canvas"); c.setAttribute("aria-hidden", "true");
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const t = page.render({ canvas: c, canvasContext: c.getContext("2d")!, viewport: vp }); tasks.add(t);
      await t.promise; tasks.delete(t);
      if (alive) { old.replaceWith(c); pg.classList.add("drawn"); }
    } catch (e) { if ((e as Error)?.name !== "RenderingCancelledException") { drawn.delete(pg); pg.classList.add("failed"); } }
  };
  const pages = [...root.querySelectorAll<HTMLElement>(".pdfpage")];
  const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) draw(e.target as HTMLElement); }, { rootMargin: "1200px 0px" });
  for (const p of pages) io.observe(p);
  // fonts can arrive after the first layout, so fit again once they are in; a new width redraws the pages near
  fitText(root); document.fonts?.ready.then(() => alive && fitText(root));
  // a page drawn at another width (the window, or the text size zooming pages) is drawn again when near the screen
  const ro = new ResizeObserver(es => { for (const e of es) { const p = e.target as HTMLElement, r = p.getBoundingClientRect(); if (drawn.has(p) && r.bottom > -1200 && r.top < innerHeight + 1200) draw(p); } });
  for (const p of pages) ro.observe(p);
  return () => { alive = false; io.disconnect(); ro.disconnect(); for (const t of tasks) t.cancel(); };
}

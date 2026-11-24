// The book graph, drawn with sigma.js (WebGL). Loaded only when the Graph view opens, so it never counts toward the
// first paint. Books start around their cluster, ForceAtlas2 settles them in slices that give the page back to the
// browser between each, and labels follow sigma's zoom rule: a name shows once its dot is big enough on screen.
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import type { GraphData, IdeaBook } from "../core/ideas";

export interface GraphHandle {
  destroy(): void;
  /** books to keep bright (null: all); everything else fades */
  show(ids: Set<string> | null): void;
  select(id: string | null): void;
  zoomTo(id: string): void;
  ms: { layout: number };
}
const hex = (h: number, s: number, l: number) => {
  const a = s * Math.min(l, 1 - l), f = (n: number) => { const k = (n + h / 30) % 12, c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(255 * c).toString(16).padStart(2, "0"); };
  return `#${f(0)}${f(8)}${f(4)}`;
};
export const clusterColor = (i: number, dark: boolean) => hex((i * 137.508) % 360, 0.62, dark ? 0.62 : 0.45);

export async function drawGraph(parent: HTMLElement, books: IdeaBook[], data: GraphData, on: { pick(id: string | null): void }, dark: boolean): Promise<GraphHandle> {
  const t0 = performance.now();
  // its own element: a draw that is cancelled while it lays out can never clear the next one's canvases
  const el = document.createElement("div"); el.style.cssText = "position:absolute;inset:0"; parent.appendChild(el);
  const g = new Graph({ type: "undirected" });
  const n = books.length, ring = Math.max(1, Math.sqrt(n)) * 2.2;
  // start each book near its cluster's place on a spiral, in a fixed pseudo-random jitter: the same library settles the same way
  data.ids.forEach((id, i) => {
    const c = data.cluster[i], a = c * 2.399963, r = ring * Math.sqrt((c + 0.5) / Math.max(1, data.clusters.length));
    const j = ((i * 2654435761) >>> 0) / 4294967296, k = ((i * 40503) % 65521) / 65521;
    g.addNode(id, { x: r * Math.cos(a) + (j - 0.5) * ring * 0.25, y: r * Math.sin(a) + (k - 0.5) * ring * 0.25, size: (n > 300 ? 3.5 : 2.5) + Math.min(7, Math.sqrt(books[i].marks) * 0.8), color: clusterColor(c, dark), label: books[i].title, cluster: c });
  });
  const a = n > 300 ? 0.07 : 0.15, edgeColor = dark ? `rgba(200,200,215,${a})` : `rgba(60,60,80,${a + 0.02})`;
  for (const [a, b, w] of data.edges) g.addEdge(data.ids[a], data.ids[b], { size: Math.min(2, 0.3 + w * 0.3), color: edgeColor });

  let live = true;
  const sigma = new Sigma(g, el, { styles: { nodes: { color: { attribute: "color" }, size: { attribute: "size" }, label: { attribute: "label" }, labelColor: dark ? "#e8e2d6" : "#1d1a16", labelVisibility: { attribute: "forceLabel", then: "visible", else: "auto" } } }, settings: { labelDensity: 0.7, labelGridCellSize: 90, labelRenderedSizeThreshold: 6, hideEdgesOnMove: true, minCameraRatio: 0.03, maxCameraRatio: 8, enableEdgeEvents: false } });
  const t1 = performance.now();
  // layout in slices of iterations so scrolling, typing and taps stay live while it settles
  // the layout runs on a copy sigma does not watch: every change to the drawn graph makes sigma draw a frame, and
  // drawing 1,000 books after each slice cost more than the layout itself. The drawn graph takes the positions a few
  // times a second, and once at the end.
  const work = g.copy();
  const settings = { ...forceAtlas2.inferSettings(g), barnesHutOptimize: n > 150, slowDown: 2 + Math.log(n + 1) };
  const total = n > 400 ? 120 : 200, slice = 8;
  await new Promise<void>(done => {
    let it = 0, drawn = performance.now();
    const step = () => {
      if (!live) return done();
      forceAtlas2.assign(work, { iterations: slice, settings });
      it += slice;
      if (it >= total || performance.now() - drawn > 300) {
        g.updateEachNodeAttributes((id, a) => { a.x = work.getNodeAttribute(id, "x"); a.y = work.getNodeAttribute(id, "y"); return a; }, { attributes: ["x", "y"] });
        drawn = performance.now();
      }
      if (it >= total) done(); else setTimeout(step, 0);
    };
    step();
  });
  const layout = performance.now() - t1 + (t1 - t0);

  let sel: string | null = null, shown: Set<string> | null = null;
  const paint = () => {
    g.forEachNode((id, a) => {
      const dim = (shown && !shown.has(id)) || false;
      g.setNodeAttribute(id, "color", dim ? (dark ? "#3a3a44" : "#dcdce2") : clusterColor(a.cluster as number, dark));
      g.setNodeAttribute(id, "zIndex", id === sel ? 3 : dim ? 0 : 1);
      g.setNodeAttribute(id, "forceLabel", id === sel);
    });
    sigma.refresh();
  };
  sigma.on("clickNode", ({ node }) => { sel = node; paint(); on.pick(node); });
  sigma.on("clickStage", () => { if (sel) { sel = null; paint(); on.pick(null); } });
  return {
    ms: { layout },
    destroy() { live = false; sigma.kill(); el.remove(); },
    show(ids) { shown = ids; paint(); },
    select(id) { sel = id; paint(); },
    zoomTo(id) { const p = sigma.getNodeDisplayData(id); if (p) sigma.getCamera().animate({ x: p.x, y: p.y, ratio: 0.25 }, { duration: 300 }); },
  };
}

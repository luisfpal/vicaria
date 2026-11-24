// Ideas: every book in one place, as a searchable list (only the rows on screen exist) or as a graph of how books
// relate through the tags and authors you gave them. Search and grouping work the same in both.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { books, go, library, use, BASE, mark } from "./state";
import { ideaBooks, search, rows, offsets, visibleRange, graphOf, NO_TOPIC, ROW_BOOK, ROW_HEAD, type BookStat, type GroupBy, type IdeaBook, type GraphData } from "../core/ideas";
import type { GraphHandle } from "./graph";
import { t } from "../core/i18n";

type View = "list" | "graph";
const dark = () => document.documentElement.dataset.theme === "dark";
// NO_TOPIC is the model's own name for a group; what the reader sees comes from the catalog
const groupName = (h: string) => h === NO_TOPIC ? t("ideas.noTopic") : h;

export function Ideas() {
  const lib = use(library);
  const [stats, setStats] = useState<Record<string, BookStat> | null>(null);
  const [view, setView] = useState<View>((sessionStorage.getItem("vic:ideas") as View) || "list");
  const [by, setBy] = useState<GroupBy>((localStorage.getItem("vic:ideasby") as GroupBy) || "topic");
  const [q, setQ] = useState("");
  useEffect(() => { books.call<Record<string, BookStat>>("ideas").then(s => { setStats(s); mark("vic:ideas"); }).catch(() => setStats({})); }, [lib.length]);
  useEffect(() => sessionStorage.setItem("vic:ideas", view), [view]);
  useEffect(() => localStorage.setItem("vic:ideasby", by), [by]);
  const all = useMemo(() => ideaBooks(lib, stats ?? {}), [lib, stats]);
  const found = useMemo(() => search(all, q), [all, q]);

  return (
    <section class="page ideas">
      <h1>{t("ideas.title")}</h1>
      <div class="lib-tools">
        <input type="search" placeholder={t("ideas.search", { n: all.length })} aria-label={t("ideas.searchLabel")} value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
        {view === "list" && <select aria-label={t("ideas.groupBy")} value={by} onChange={e => setBy((e.target as HTMLSelectElement).value as GroupBy)}>
          <option value="topic">{t("ideas.byTopic")}</option><option value="author">{t("ideas.byAuthor")}</option><option value="title">{t("ideas.byTitle")}</option>
        </select>}
        <div class="seg" role="tablist">
          {(["list", "graph"] as View[]).map(v => <button key={v} role="tab" aria-selected={view === v} class={`chip ${view === v ? "on" : ""}`} onClick={() => setView(v)}>{v === "list" ? t("ideas.list") : t("ideas.graph")}</button>)}
        </div>
      </div>
      {!all.length && <p class="muted">{t("ideas.empty")}</p>}
      {all.length > 0 && stats && (view === "list" ? <VList bs={found} by={by} /> : <GraphView all={all} found={found} q={q} />)}
      {q && !found.length && <p class="muted">{t("ideas.noMatch", { q })}</p>}
    </section>
  );
}

// A long list as a window: rows are placed by their offset, and only the ones crossing the screen are made.
function VList({ bs, by }: { bs: IdeaBook[]; by: GroupBy }) {
  const box = useRef<HTMLDivElement>(null);
  const rs = useMemo(() => rows(bs, by), [bs, by]);
  const { top, total } = useMemo(() => offsets(rs), [rs]);
  const [range, setRange] = useState<[number, number]>([0, 30]);
  useEffect(() => {
    let raf = 0;
    const calc = () => {
      raf = 0; const el = box.current; if (!el) return;
      const y = -el.getBoundingClientRect().top;
      const r = visibleRange(top, y, y + innerHeight);
      setRange(p => p[0] === r[0] && p[1] === r[1] ? p : r);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(calc); };
    calc();
    addEventListener("scroll", on, { passive: true }); addEventListener("resize", on);
    return () => { removeEventListener("scroll", on); removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, [top]);
  return (
    <div class="vlist" ref={box} style={{ height: total + "px" }} data-rows={rs.length}>
      {rs.slice(range[0], range[1]).map((r, k) => {
        const i = range[0] + k, style = { top: top[i] + "px", height: ("head" in r ? ROW_HEAD : ROW_BOOK) + "px" };
        return "head" in r
          ? <div key={"h" + r.head} class="vrow head" style={style}>{groupName(r.head)}<span class="m">{r.n}</span></div>
          : <a key={r.book.id} class="vrow" style={style} href={`${BASE}/book/${r.book.id}`} onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); go(`/book/${r.book.id}`); }}>
              <span class="tx"><span class="t">{r.book.title}</span><span class="a">{r.book.author}{r.book.tags.length ? " · " + r.book.tags.slice(0, 3).join(", ") : ""}</span></span>
              {r.book.marks > 0 && <span class="m">{t("ideas.markCount", { n: r.book.marks })}</span>}
            </a>;
      })}
    </div>
  );
}

function GraphView({ all, found, q }: { all: IdeaBook[]; found: IdeaBook[]; q: string }) {
  const el = useRef<HTMLDivElement>(null);
  const h = useRef<GraphHandle | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [pick, setPick] = useState<string | null>(null);
  const [cl, setCl] = useState<number | null>(null);
  const data: GraphData = useMemo(() => graphOf(all), [all]);
  const byId = useMemo(() => new Map(all.map(b => [b.id, b])), [all]);
  // the graph is drawn again only when what it shows changes (a book, a mark count or a tag), not when the list is re-read
  const sig = useMemo(() => all.map(b => `${b.id}:${b.marks}:${b.tags.join("|")}`).join(","), [all]);
  const cur = useRef({ all, data }); cur.current = { all, data };
  useEffect(() => {
    let dead = false; setState("loading");
    import("./graph").then(m => m.drawGraph(el.current!, cur.current.all, cur.current.data, { pick: setPick }, dark())).then(x => {
      if (dead) { x.destroy(); return; }
      h.current = x; el.current!.dataset.layoutMs = String(Math.round(x.ms.layout)); setState("ready"); mark("vic:graph");
    }).catch(e => { console.warn("graph", e); if (!dead) setState("failed"); });
    return () => { dead = true; h.current?.destroy(); h.current = null; };
  }, [sig]);
  // what stays bright: the search result, narrowed to the chosen cluster
  useEffect(() => {
    if (state !== "ready") return;
    const ids = new Set<string>();
    const inCl = cl === null ? null : new Set(data.ids.filter((_, i) => data.cluster[i] === cl));
    if (!q.trim() && !inCl) { h.current!.show(null); return; }
    for (const b of found) if (!inCl || inCl.has(b.id)) ids.add(b.id);
    h.current!.show(ids);
  }, [state, found, q, cl, data]);
  const sel = pick ? byId.get(pick) : null;
  return (
    <>
      <div class="legend" aria-label={t("ideas.groupsLabel")}>
        {data.clusters.slice(0, 8).map((c, i) => <button key={i} class={`chip ${cl === i ? "on" : ""}`} onClick={() => setCl(cl === i ? null : i)}><i style={{ background: legendColor(i) }} />{groupName(c.name)} <small>{c.size}</small></button>)}
      </div>
      <div class="graphbox">
        <div class="sg" ref={el} role="img" aria-label={t("ideas.graphLabel", { n: all.length })} />
        {state !== "ready" && <div class="wait">{state === "failed" ? t("ideas.graphFailed") : t("ideas.graphLaying")}</div>}
      </div>
      {sel && <div class="pick"><b>{sel.title}</b><span class="muted">{sel.author}</span>
        <a class="btn" href={`${BASE}/book/${sel.id}`} onClick={e => { e.preventDefault(); go(`/book/${sel.id}`); }}>{t("ideas.open")}</a></div>}
      <p class="muted hint">{t("ideas.graphHint")}</p>
    </>
  );
}
const legendColor = (i: number) => { return `hsl(${(i * 137.508) % 360} 62% ${dark() ? 62 : 45}%)`; };

import { useState, useRef, useEffect } from "preact/hooks";
import { Cover } from "./covers";
import { importUrl, importFiles } from "./importer";
import { toast, fold } from "./state";
import { t } from "../core/i18n";

const SE = "https://standardebooks.org";
const GD = "https://gutendex.com/books/";
const CLASSICS: [string, string, string][] = [
  ["marcus-aurelius/meditations/george-long", "Meditations", "Marcus Aurelius"],
  ["seneca/moral-letters-to-lucilius/richard-m-gummere", "Moral Letters to Lucilius", "Seneca"],
  ["laozi/tao-te-ching/james-legge", "Tao Te Ching", "Laozi"],
  ["sun-tzu/the-art-of-war/lionel-giles", "The Art of War", "Sun Tzu"],
  ["hermann-hesse/siddhartha/various-translators", "Siddhartha", "Hermann Hesse"],
  ["jane-austen/pride-and-prejudice", "Pride and Prejudice", "Jane Austen"],
  ["mary-shelley/frankenstein", "Frankenstein", "Mary Shelley"],
  ["homer/the-odyssey/william-cullen-bryant", "The Odyssey", "Homer"],
];
type Item = { src: "se" | "pg"; key: string; title: string; author: string; img: string | null };

const norm = (s: string) => fold(s || "").replace(/[^a-z0-9]+/g, " ").trim();
function relevance(q: string, title: string, author: string) {
  const Q = norm(q), T = norm(title).replace(/^(the|a|an) /, ""), A = norm(author), ws = Q.split(" ").filter(Boolean);
  const tw = new Set(norm(title).split(" ")), aw = new Set(A.split(" "));
  let s = T === Q.replace(/^(the|a|an) /, "") ? 100 : T.startsWith(Q) ? 60 : 0;
  s += 40 * ws.filter(w => tw.has(w)).length / ws.length + 30 * ws.filter(w => aw.has(w)).length / ws.length;
  if (A && (A === Q || A.includes(Q))) s += 50;
  return s;
}
const ranked = (q: string, xs: Item[]) => xs.map((x, i) => [relevance(q, x.title, x.author) - i * 0.01, x] as const).sort((a, b) => b[0] - a[0]).map(x => x[1]);

async function fromSE(q: string): Promise<Item[]> {
  const html = await (await fetch(`${SE}/ebooks?query=${encodeURIComponent(q)}&per-page=24`)).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll('li[typeof="schema:Book"]')].filter(li => li.querySelector("img")).map(li => ({
    src: "se" as const, key: (li.getAttribute("about") || "").replace(/^\/ebooks\//, ""), title: li.querySelector('[property="schema:name"]')?.textContent?.trim() || "",
    author: li.querySelector(".author [property='schema:name']")?.textContent?.trim() || "", img: SE + li.querySelector("img")!.getAttribute("src") })).filter(x => x.key && x.title);
}
async function fromGutenberg(q: string): Promise<Item[]> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${GD}?search=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(75000) });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      return (j.results || []).filter((b: { copyright: boolean; formats: Record<string, string> }) => !b.copyright && Object.keys(b.formats || {}).some(k => k.includes("epub"))).map((b: { id: number; title: string; authors: { name: string }[]; formats: Record<string, string> }) => ({
        src: "pg" as const, key: String(b.id), title: (b.title || "").split(/[:;]/)[0].trim(), author: (b.authors || []).map(a => a.name.split(", ").reverse().join(" ")).join(", "), img: b.formats["image/jpeg"] || null }));
    } catch (e) { if (i >= 1) throw e; }
  }
}
const seUrl = (path: string) => `${SE}/ebooks/${path}/downloads/${path.replace(/\//g, "_")}.epub?source=download`;

function Card({ x }: { x: Item }) {
  const [state, setState] = useState<"idle" | "busy" | "gstep">("idle");
  const pick = useRef<HTMLInputElement>(null);
  const add = async () => {
    if (x.src === "pg") {
      // Project Gutenberg sends no CORS headers, so a web page cannot read its files: the browser downloads the
      // EPUB in the same tap and the next tap adds it. No server of ours sits in the middle.
      const a = document.createElement("a"); a.href = `https://www.gutenberg.org/ebooks/${x.key}.epub3.images`; a.target = "_blank"; a.rel = "noopener"; a.click();
      setState("gstep"); return;
    }
    setState("busy");
    try { await importUrl(seUrl(x.key), x.title); } catch (e) { setState("idle"); toast(t("discover.couldNotAdd", { title: x.title, error: (e as Error).message })); }
  };
  return (
    <div class="dcard">
      <Cover title={x.title} author={x.author} />
      {x.img && <img class="dimg" src={x.img} alt="" loading="lazy" referrerpolicy="no-referrer" onLoad={e => (e.target as HTMLImageElement).classList.add("ok")} onError={e => (e.target as HTMLImageElement).remove()} />}
      <b>{x.title}</b><span>{x.author}</span>
      {state === "gstep" ? (
        <div class="gstep"><small>{t("discover.gutenbergDownloading")}</small><button class="btn" onClick={() => pick.current?.click()}>{t("discover.addDownloaded")}</button>
          <input ref={pick} type="file" accept=".epub,application/epub+zip,.pdf,application/pdf" hidden onChange={e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) importFiles([f]); }} /></div>
      ) : <button class="btn" disabled={state === "busy"} onClick={add}>{state === "busy" ? t("discover.adding") : t("discover.add")}</button>}
    </div>
  );
}

export function Discover() {
  const [q, setQ] = useState("");
  const [se, setSe] = useState<Item[] | "loading" | "error" | null>(null);
  const [pg, setPg] = useState<Item[] | "loading" | "error" | null>(null);
  const no = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const run = async (query: string) => {
    const n = ++no.current; setSe("loading"); setPg("loading");
    let have = new Set<string>();
    const key = (x: Item) => norm(x.title) + "|" + norm(x.author).split(" ").pop();
    const seP = fromSE(query).then(l => { if (n !== no.current) return; const r = ranked(query, l); have = new Set(r.map(key)); setSe(r); }).catch(() => n === no.current && setSe("error"));
    try { const l = await fromGutenberg(query); await seP; if (n === no.current) setPg(ranked(query, l).filter(x => !have.has(key(x))).slice(0, 12)); }
    catch { if (n === no.current) setPg("error"); }
  };
  return (
    <section class="page discover">
      <h1>{t("discover.title")}</h1>
      <p class="muted">{t("discover.intro")}</p>
      <form onSubmit={e => { e.preventDefault(); if (q.trim()) run(q.trim()); }}>
        <input ref={input} type="search" enterkeyhint="search" placeholder={t("discover.searchPlaceholder")} aria-label={t("discover.searchLabel")} value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />
      </form>
      {se === null ? (
        <><p class="muted">{t("discover.startWithClassic")}</p><div class="dgrid">{CLASSICS.map(([p, title, a]) => <Card key={p} x={{ src: "se", key: p, title, author: a, img: `${SE}/ebooks/${p}/downloads/cover-thumbnail.jpg` }} />)}</div></>
      ) : (
        <>
          {se === "loading" ? <p class="muted">{t("discover.searchingSE")}</p> : se === "error" ? <p class="muted">{t("discover.seError")}</p> : se.length ? <><h3 class="src">{t("discover.sourceSE")}</h3><div class="dgrid">{se.map(x => <Card key={x.key} x={x} />)}</div></> : <p class="muted">{t("discover.noneSE")}</p>}
          <h3 class="src">{t("discover.sourcePG")}</h3>
          {pg === "loading" ? <p class="muted">{t("discover.searchingPG")}</p> : pg === "error" ? <p class="muted">{t("discover.pgError")} <button class="btn ghost" onClick={() => run(q.trim())}>{t("discover.tryAgain")}</button></p> : pg && pg.length ? <div class="dgrid">{pg.map(x => <Card key={x.key} x={x} />)}</div> : <p class="muted">{t("discover.nonePG")}</p>}
        </>
      )}
    </section>
  );
}

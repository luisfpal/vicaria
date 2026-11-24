// Places: bookmarks, loved places and notes from every book, in one list.
import { useEffect, useState } from "preact/hooks";
import { books, go, library, use } from "./state";
import { t } from "../core/i18n";

interface Place { id: string; book: string; title: string; at: { section: number; block: number }; exact: string; note: string; name?: string; color?: string; loved: boolean; bookmark: boolean; tags: string[]; edited: number }
type Tab = "bookmarks" | "loved" | "notes";
export function Places() {
  const [all, setAll] = useState<Place[] | null>(null);
  const [tab, setTab] = useState<Tab>((sessionStorage.getItem("vic:places") as Tab) || "bookmarks");
  const [q, setQ] = useState("");
  const lib = use(library);
  useEffect(() => { books.call<Place[]>("marksAcross").then(setAll).catch(() => setAll([])); }, [lib.length]);
  useEffect(() => sessionStorage.setItem("vic:places", tab), [tab]);
  const ql = q.trim().toLowerCase();
  const list = (all || []).filter(p => tab === "bookmarks" ? p.bookmark : tab === "loved" ? p.loved : !!p.note)
    .filter(p => !ql || [p.title, p.exact, p.note, p.name || "", ...p.tags].some(s => s.toLowerCase().includes(ql)));
  const n = (t: Tab) => (all || []).filter(p => t === "bookmarks" ? p.bookmark : t === "loved" ? p.loved : !!p.note).length;
  return (
    <section class="page places">
      <h1>{t("places.title")}</h1>
      <div class="row fchips" role="tablist">
        {(["bookmarks", "loved", "notes"] as Tab[]).map(x => <button key={x} role="tab" aria-selected={tab === x} class={`chip ${tab === x ? "on" : ""}`} onClick={() => setTab(x)}>{{ bookmarks: t("places.bookmarks"), loved: t("places.loved"), notes: t("places.notes") }[x]} <small>{n(x)}</small></button>)}
      </div>
      {(all?.length || 0) > 8 && <input type="search" placeholder={t("places.search")} aria-label={t("places.search")} value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />}
      {all && !list.length && <p class="muted">{tab === "bookmarks" ? t("places.emptyBookmarks") : tab === "loved" ? t("places.emptyLoved") : t("places.emptyNotes")}</p>}
      <ul class="hits plist">{list.map(p => (
        <li key={p.id}><button class="link" onClick={() => go(`/book/${p.book}?s=${p.at.section}&b=${p.at.block}`)}>
          <small>{p.title}{p.loved ? " · ♥" : ""}</small>
          {p.bookmark ? <span class="bm">{p.name || p.exact.slice(0, 80)}</span> : <span class={`q ${p.color || "none"}`}>{p.exact}</span>}
          {p.note && <em>{p.note}</em>}
        </button></li>))}</ul>
    </section>
  );
}

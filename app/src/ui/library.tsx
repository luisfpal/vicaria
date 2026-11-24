import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { library, lastOpened, progress, use, go, fold, mark, BASE } from "./state";
import { Cover } from "./covers";
import { shown } from "../core/progress";
import { prefetchBook } from "./bookcache";
import { SetupCard } from "./setupcard";
import { dayOf } from "../wiser/budget";
import type { FunctionComponent } from "preact";
import { importFiles, ensureClassic, CLASSIC } from "./importer";
import { t, tparts } from "../core/i18n";

// Today's thought: due once a day, on the first open. The card is its own file, fetched only then (and never when the
// reader turned it off), so the library's first paint does not wait for it.
const thoughtDue = () => { try { return localStorage.getItem("vic:wiser:seen") !== dayOf() && localStorage.getItem("vic:wiser:off") !== "1"; } catch { return false; } };

export function Library() {
  const [Card, setCard] = useState<FunctionComponent | null>(null);
  useEffect(() => {
    if (!thoughtDue()) return;
    const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback || ((f: () => void) => setTimeout(f, 300));
    idle(() => { if (thoughtDue()) import("./wiser-card").then(m => setCard(() => m.DailyCard)).catch(() => {}); });
  }, []);
  const bs = use(library);
  const opened = use(lastOpened), prog = use(progress);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "title" | "author" | "added">((localStorage.getItem("vic:sort") as never) || "recent");
  const file = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const f = fold(q.trim());
    const xs = f ? bs.filter(b => fold(b.title + " " + b.author).includes(f)) : bs.slice();
    const key = { recent: (b: typeof bs[0]) => -(opened[b.id] || b.addedAt), title: (b: typeof bs[0]) => fold(b.title).replace(/^(the|a|an) /, ""), author: (b: typeof bs[0]) => fold(b.author.split(" ").pop() || ""), added: (b: typeof bs[0]) => -b.addedAt }[sort];
    return xs.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
  }, [bs, q, sort, opened]);
  useEffect(() => { mark("vic:library"); }, []);
  const hint = tparts("library.hint", "discover");
  const empty = !bs.length && localStorage.getItem("vic:classic") !== "done";

  return (
    <section class="page library">
      <div class="lib-tools">
        {bs.length > 6 && <input type="search" placeholder={t("library.search", { n: bs.length })} aria-label={t("library.searchLabel")} value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />}
        {bs.length > 1 && <select aria-label={t("library.sort")} value={sort} onChange={e => { const v = (e.target as HTMLSelectElement).value as typeof sort; setSort(v); localStorage.setItem("vic:sort", v); }}>
          <option value="recent">{t("library.sortRecent")}</option><option value="title">{t("library.sortTitle")}</option><option value="author">{t("library.sortAuthor")}</option><option value="added">{t("library.sortAdded")}</option>
        </select>}
        <button class="btn" onClick={() => file.current?.click()}>{t("library.add")}</button>
        <input ref={file} type="file" accept=".epub,application/epub+zip,.pdf,application/pdf" multiple hidden onChange={e => { const fs = [...((e.target as HTMLInputElement).files || [])]; if (fs.length) importFiles(fs); (e.target as HTMLInputElement).value = ""; }} />
      </div>
      <SetupCard />
      {Card && <Card />}
      <div class="shelf" data-count={list.length}>
        {empty && (
          <a class="book-card" href={BASE + "/"} onClick={async e => { e.preventDefault(); const b = await ensureClassic(); const id = b?.id || localStorage.getItem("vic:classic-id"); if (id) go(`/book/${id}`); }}>
            <Cover title={CLASSIC.title} author={CLASSIC.author} />
            <span class="t">{CLASSIC.title}</span><span class="a">{CLASSIC.author}</span>
          </a>
        )}
        {list.map(b => (
          <a class="book-card" key={b.id} href={`${BASE}/book/${b.id}`} onPointerEnter={() => prefetchBook(b.id, b.start)} onPointerDown={() => prefetchBook(b.id, b.start)} onFocus={() => prefetchBook(b.id, b.start)} onClick={e => { e.preventDefault(); prefetchBook(b.id, b.start); go(`/book/${b.id}`); }}>
            <Cover id={b.id} cover={b.cover} title={b.title} author={b.author} />
            <span class="t">{b.title}</span><span class="a">{b.author}</span>
            {shown(prog[b.id]) > 0 && <span class="prog" role="img" aria-label={t("library.progress", { n: Math.round(shown(prog[b.id]) * 100) })}><i style={{ width: `${shown(prog[b.id]) * 100}%` }} /></span>}
          </a>
        ))}
      </div>
      {!list.length && q && <p class="muted">{t("library.noMatch", { q })}</p>}
      <p class="muted hint">{hint[0]}<a href={BASE + "/discover"} onClick={e => { e.preventDefault(); go("/discover"); }}>{t("library.discover")}</a>{hint[1]}{" "}<a href={BASE + "/wiser"} onClick={e => { e.preventDefault(); go("/wiser"); }}>{t("wiser.link")}</a>.</p>
    </section>
  );
}

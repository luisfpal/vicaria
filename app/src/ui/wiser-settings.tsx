// Settings > Thoughts and lessons: the card, the reminder, and what shapes a lesson (people, tone, length, topics, and
// for advanced readers the prompt template). Saved as one "wiser" op, so it follows the reader to every device.
import { useEffect, useState } from "preact/hooks";
import { library, use } from "./state";
import { readAll, putPrefs, DEFAULT_PREFS, TONES, LENGTHS, type Prefs } from "../wiser/data";
import { DEFAULT_TEMPLATE, SLOTS } from "../wiser/prompts";
import * as notify from "../wiser/notify";
import { t } from "../core/i18n";

export function WiserSettings() {
  const bs = use(library);
  const [p, setP] = useState<Prefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const [name, setName] = useState("");
  const [off, setOff] = useState(() => localStorage.getItem("vic:wiser:off") === "1");
  const [time, setTime] = useState(() => notify.timeSet() ?? "08:00");
  const [on, setOn] = useState(() => !!notify.timeSet());
  const [msg, setMsg] = useState("");
  useEffect(() => { readAll().then(a => { setP(a.prefs); setReady(true); }).catch(() => setReady(true)); }, []);
  // the block above grows when it is drawn: scroll again to the part of Settings a link pointed at
  useEffect(() => { const id = location.hash.slice(1); if (ready && id) document.getElementById(id)?.scrollIntoView(); }, [ready]);
  const save = (x: Partial<Prefs>) => { const n = { ...p, ...x }; setP(n); void putPrefs(n); };
  const add = (who: string) => { const w = who.trim().slice(0, 80); if (w && !p.people.some(x => x.toLowerCase() === w.toLowerCase()) && p.people.length < 40) save({ people: [...p.people, w] }); setName(""); };
  const suggest = [...new Set(bs.map(b => b.author).filter(Boolean))].filter(a => !p.people.some(x => x.toLowerCase() === a.toLowerCase())).slice(0, 8);
  const toneLabel = { plain: t("wiser.set.tonePlain"), warm: t("wiser.set.toneWarm"), blunt: t("wiser.set.toneBlunt") }, lenLabel = { short: t("wiser.set.short"), medium: t("wiser.set.medium"), long: t("wiser.set.long") };
  async function toggleNotify(v: boolean) {
    if (!v) { notify.disable(); setOn(false); setMsg(""); return; }
    const r = await notify.enable(time); setOn(r === "on"); setMsg(r === "denied" ? t("wiser.set.notifyDenied") : r === "unsupported" ? t("wiser.set.notifyNo") : "");
  }
  return (
    <>
      <h2 id="wiser">{t("wiser.set.heading")}</h2>
      <p class="muted">{t("wiser.set.body")}</p>
      <label class="row"><input type="checkbox" checked={!off} onChange={e => { const v = !(e.target as HTMLInputElement).checked; setOff(v); if (v) localStorage.setItem("vic:wiser:off", "1"); else localStorage.removeItem("vic:wiser:off"); }} /> {t("wiser.set.daily")}</label>
      {notify.supported()
        ? <div class="wnotify"><label class="row"><input type="checkbox" checked={on} onChange={e => toggleNotify((e.target as HTMLInputElement).checked)} /> {t("wiser.set.notify")}
            <label class="row">{t("wiser.set.notifyAt")} <input type="time" value={time} onInput={e => { const v = (e.target as HTMLInputElement).value; if (notify.validTime(v)) { setTime(v); if (on) { localStorage.setItem(notify.KEY, v); notify.start(); } } }} /></label></label>
          <p class="muted small">{t("wiser.set.notifyBody")}</p>{msg && <p class="muted small" role="status">{msg}</p>}</div>
        : <p class="muted small">{t("wiser.set.notifyNo")}</p>}
      {ready && <div class="wprefs">
        <h3>{t("wiser.set.people")}</h3>
        <div class="row chips">{p.people.map(x => <span class="chip on" key={x}>{x}<button class="icon" aria-label={t("wiser.set.remove", { name: x })} onClick={() => save({ people: p.people.filter(y => y !== x) })}>×</button></span>)}</div>
        <form class="row" onSubmit={e => { e.preventDefault(); add(name); }}>
          <input type="text" value={name} maxLength={80} placeholder={t("wiser.set.addPerson")} aria-label={t("wiser.set.addPerson")} onInput={e => setName((e.target as HTMLInputElement).value)} />
          <button class="btn ghost" disabled={!name.trim()}>{t("wiser.set.add")}</button>
        </form>
        {suggest.length > 0 && <div class="row chips"><span class="muted small">{t("wiser.set.suggest")}</span>{suggest.map(a => <button class="chip" key={a} onClick={() => add(a)}>+ {a}</button>)}</div>}
        <label class="row"><input type="checkbox" checked={p.outside} onChange={e => save({ outside: (e.target as HTMLInputElement).checked })} /> {t("wiser.set.outside")}</label>
        <div class="row">
          <label class="row">{t("wiser.set.tone")} <select value={p.tone} onChange={e => save({ tone: (e.target as HTMLSelectElement).value as Prefs["tone"] })}>{TONES.map(x => <option key={x} value={x}>{toneLabel[x]}</option>)}</select></label>
          <label class="row">{t("wiser.set.length")} <select value={p.length} onChange={e => save({ length: (e.target as HTMLSelectElement).value as Prefs["length"] })}>{LENGTHS.map(x => <option key={x} value={x}>{lenLabel[x]}</option>)}</select></label>
        </div>
        <label class="field">{t("wiser.set.topics")}<input type="text" defaultValue={p.topics.join(", ")} onBlur={e => save({ topics: (e.target as HTMLInputElement).value.split(",").map(s => s.trim()).filter(Boolean).slice(0, 20) })} /></label>
        <details class="wtemplate"><summary>{t("wiser.set.template")}</summary>
          <p class="muted small">{t("wiser.set.templateBody")} {SLOTS.map(s => `{${s}}`).join(" ")}</p>
          <textarea rows={8} spellcheck={false} aria-label={t("wiser.set.template")} key={p.template} defaultValue={p.template || DEFAULT_TEMPLATE}
            onBlur={e => { const v = (e.target as HTMLTextAreaElement).value.trim(); save({ template: v === DEFAULT_TEMPLATE ? "" : v.slice(0, 4000) }); }} />
          <button class="link" onClick={() => save({ template: "" })}>{t("wiser.set.templateReset")}</button>
        </details>
      </div>}
    </>
  );
}

// The Wiser screen: today's thought, lessons (written for the reader with a key, bundled without), saved thoughts, and a
// lesson with its follow-up chat. Ask's machinery does the talking (Turn records, chat storage, streaming, rendering).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { route, use, go, toast, BASE } from "./state";
import { getToday, loadBundled, loadSource } from "./wiser-data";
import { ThoughtView } from "./wiser-card";
import { activeRoute, stream, AiError } from "../ai/providers";
import { renderAnswer } from "../ai/render";
import type { Turn } from "../ai/ask";
import { busy } from "../core/busy";
import { onOp } from "../core/ops";
import { foldLessons, foldThoughts, foldPrefs, putLesson, putThought, searchLessons, type Lesson, type Thought, type Prefs } from "../wiser/data";
import { makeLesson, LimitError, UnreadableError, chatMessages, loadThread, saveThread, needsSummary, foldThread, summarize } from "../wiser/lesson";
import type { Today } from "../wiser/today";
import { t, lang } from "../core/i18n";

interface All { lessons: Lesson[]; thoughts: Thought[]; prefs: Prefs; starter: Lesson[] }
async function load(): Promise<All> {
  const { allOps } = await import("../core/ops"), ops = await allOps(), lessons = foldLessons(ops);
  const kept = new Set(lessons.map(l => l.id));
  const starter = (await loadBundled()).lessons.map((b): Lesson => ({ id: `b-${b.id}`, title: b.title, body: b.body, people: b.people, models: b.models, summary: b.summary, topics: [], lang, src: "bundled", made: 0 })).filter(l => !kept.has(l.id));
  return { lessons, thoughts: foldThoughts(ops), prefs: foldPrefs(ops), starter };
}
function useAll() {
  const [all, set] = useState<All | null>(null);
  useEffect(() => {
    let live = true, timer = 0;
    const run = () => load().then(a => { if (live) set(a); }).catch(() => {});
    run();
    const off = onOp(o => { if (o.k === "lesson" || o.k === "thought" || o.k === "wiser") { clearTimeout(timer); timer = window.setTimeout(run, 50); } });
    return () => { live = false; off(); clearTimeout(timer); };
  }, []);
  return all;
}

export function Wiser() {
  const r = use(route), id = r.match(/^\/wiser\/([\w-]+)/)?.[1];
  const all = useAll();
  if (!all) return <section class="page wiser" />;
  return id ? <LessonView id={id} all={all} /> : <Home all={all} />;
}

function Home({ all }: { all: All }) {
  const ai = activeRoute();
  const [today, setToday] = useState<Today | null>(null);
  const [topic, setTopic] = useState("");
  const [q, setQ] = useState("");
  const [writing, setWriting] = useState(false);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => { getToday().then(setToday).catch(() => {}); }, []);
  const shown = useMemo(() => searchLessons(all.lessons, q), [all.lessons, q]);
  async function write() {
    if (!ai || writing) return;
    const done = busy("lesson"), ac = new AbortController(); stop.current = ac; setWriting(true);
    try { const l = await makeLesson({ prefs: all.prefs, lessons: all.lessons, load: loadSource, lang, ai, topic: topic.trim() || undefined, signal: ac.signal }); setTopic(""); go(`/wiser/${l.id}`); }
    catch (e) { toast(e instanceof LimitError ? t("wiser.limit") : e instanceof UnreadableError ? t("wiser.unreadable") : e instanceof AiError ? (e.kind === "cancelled" ? "" : e.message) : t("chat.somethingWrong")); }
    finally { setWriting(false); stop.current = null; done(); }
  }
  const row = (l: Lesson) => <li key={l.id}><a class="lrow" href={`${BASE}/wiser/${l.id}`} onClick={e => { e.preventDefault(); go(`/wiser/${l.id}`); }}><b>{l.fav ? "♥ " : ""}{l.title}</b><span class="muted small">{[...l.people, ...l.models].join(" · ")}</span></a></li>;
  return (
    <section class="page wiser">
      <h1>{t("wiser.title")}</h1>
      <p class="muted">{t("wiser.intro")}</p>
      <h2>{t("wiser.today")}</h2>
      {today ? <div class="wisercard plain"><ThoughtView today={today} /></div> : <p class="muted">{t("wiser.thinking")}</p>}
      <h2>{t("wiser.lessons")}</h2>
      {ai ? <>
        <p class="muted">{t("wiser.lessonsBody")}</p>
        <form class="row" onSubmit={e => { e.preventDefault(); write(); }}>
          <input type="text" class="grow" placeholder={t("wiser.topic")} aria-label={t("wiser.topic")} value={topic} maxLength={60} onInput={e => setTopic((e.target as HTMLInputElement).value)} disabled={writing} />
          {writing ? <button type="button" class="btn ghost" onClick={() => stop.current?.abort()}>{t("chat.stop")}</button> : <button class="btn">{t("wiser.write")}</button>}
        </form>
        {writing && <p class="muted small" role="status">{t("wiser.writing")}</p>}
      </> : <p class="muted">{t("wiser.noAi")} <button class="link" onClick={() => go("/settings#ai")}>{t("wiser.addKey")}</button></p>}
      {all.lessons.length > 0 && <>
        <h3>{t("wiser.yours")}</h3>
        {all.lessons.length > 5 && <input type="search" placeholder={t("wiser.search")} aria-label={t("wiser.search")} value={q} onInput={e => setQ((e.target as HTMLInputElement).value)} />}
        <ul class="lessons">{shown.map(row)}</ul>
        {!shown.length && <p class="muted">{t("wiser.noMatch", { q })}</p>}
      </>}
      {(!ai || !all.lessons.length) && all.starter.length > 0 && <>
        <h3>{t("wiser.starter")}</h3>
        <ul class="lessons">{all.starter.map(row)}</ul>
      </>}
      <h2>{t("wiser.savedThoughts")}</h2>
      {all.thoughts.length ? <ul class="saved">{all.thoughts.map(th => <li key={th.id}><blockquote class="wtext">{th.text}</blockquote><span class="muted small">{[th.by, th.from].filter(Boolean).join(" · ")}</span>
        <button class="link danger" onClick={() => putThought({ ...th, gone: true })}>{t("wiser.unsave")}</button></li>)}</ul> : <p class="muted">{t("wiser.noSaved")}</p>}
      <p><button class="link" onClick={() => go("/settings#wiser")}>{t("wiser.customize")}</button></p>
    </section>
  );
}

function LessonView({ id, all }: { id: string; all: All }) {
  const l = all.lessons.find(x => x.id === id) ?? all.starter.find(x => x.id === id);
  if (!l) return <section class="page wiser"><p class="muted">{t("wiser.none")}</p><button class="link" onClick={() => go("/wiser")}>{t("wiser.back")}</button></section>;
  const kept = all.lessons.some(x => x.id === l.id);
  return (
    <section class="page wiser lesson">
      <p><button class="link" onClick={() => go("/wiser")}>← {t("wiser.back")}</button></p>
      <h1>{l.title}</h1>
      <p class="muted small">{[l.people.length ? t("wiser.people", { list: l.people.join(", ") }) : "", l.models.length ? t("wiser.models", { list: l.models.join(", ") }) : ""].filter(Boolean).join(" · ")}</p>
      <div class="answer lessonbody" lang={l.lang} dangerouslySetInnerHTML={{ __html: renderAnswer(l.body) }} />
      <div class="row">
        {kept ? <button class={`btn ghost ${l.fav ? "on" : ""}`} aria-pressed={!!l.fav} onClick={() => putLesson({ ...l, fav: !l.fav, made: l.made })}>♥ {l.fav ? t("wiser.unfav") : t("wiser.fav")}</button>
          : <button class="btn ghost" onClick={() => putLesson({ ...l, made: Date.now() })}>{t("wiser.keep")}</button>}
        <span class="grow" />
        {kept && <button class="link danger" onClick={() => { putLesson({ ...l, gone: true }); go("/wiser", true); toast(t("wiser.deleted"), { action: { label: t("wiser.undo"), run: () => { putLesson(l); } } }); }}>{t("wiser.delete")}</button>}
      </div>
      <LessonChat lesson={l} />
    </section>
  );
}

function LessonChat({ lesson }: { lesson: Lesson }) {
  const ai = activeRoute();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [live, setLive] = useState<string | null>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => { loadThread(lesson.id).then(setTurns).catch(() => {}); }, [lesson.id]);
  if (!ai) return <div class="ask empty"><h2>{t("wiser.chatLabel")}</h2><p class="muted">{t("wiser.chatNoKey")}</p><button class="btn" onClick={() => go("/settings#ai")}>{t("chat.openSettings")}</button></div>;
  async function send() {
    const text = q.trim(); if (!text || live !== null || !ai) return;
    const done = busy("ask"), ac = new AbortController(); stop.current = ac;
    const user: Turn = { role: "user", text, at: Date.now() }, now = [...turns, user];
    setTurns(now); setQ(""); setLive("");
    try {
      const res = await stream(ai.route, ai.key, chatMessages(lesson, turns, text, lang), { signal: ac.signal, maxTokens: 1200, onText: (_d, all) => setLive(all) });
      let next: Turn[] = [...now, { role: "assistant", text: res.text, at: Date.now() }];
      if (needsSummary(next)) next = foldThread(next, await summarize(ai.route, ai.key, next).catch(() => "")).filter(x => !x.summary || x.text);
      setTurns(next); setLive(null); await saveThread(lesson.id, next);
    } catch (e) {
      const next: Turn[] = [...now, { role: "assistant", text: "", at: Date.now(), error: e instanceof AiError ? e.message : t("chat.somethingWrong"), errorKind: e instanceof AiError ? e.kind : "provider" }];
      setTurns(next); setLive(null); await saveThread(lesson.id, next);
    } finally { setLive(null); stop.current = null; done(); }
  }
  return (
    <div class="ask lessonchat">
      <h2>{t("wiser.chatLabel")}</h2>
      <div class="turns" aria-live="polite">
        {turns.map((turn, i) => turn.role === "user" ? <div key={i} class="turn me"><p>{turn.text}</p></div>
          : <div key={i} class="turn ai">{turn.text && <div class="answer" dangerouslySetInnerHTML={{ __html: renderAnswer(turn.text) }} />}{turn.error && <p class="err">{turn.error}</p>}</div>)}
        {live !== null && <div class="turn ai">{live ? <div class="answer" dangerouslySetInnerHTML={{ __html: renderAnswer(live) }} /> : <p class="muted thinking">{t("wiser.thinking")}</p>}</div>}
      </div>
      <form class="askbox" onSubmit={e => { e.preventDefault(); send(); }}>
        <textarea rows={2} value={q} placeholder={t("wiser.chatPlaceholder")} aria-label={t("wiser.chatLabel")} onInput={e => setQ((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
        <div class="row">
          <span class="grow" />
          {turns.length > 0 && live === null && <button type="button" class="link" onClick={async () => { setTurns([]); await saveThread(lesson.id, []); }}>{t("wiser.clearChat")}</button>}
          {live !== null ? <button type="button" class="btn ghost" onClick={() => stop.current?.abort()}>{t("chat.stop")}</button> : <button class="btn" disabled={!q.trim()}>{t("wiser.ask")}</button>}
        </div>
      </form>
    </div>
  );
}

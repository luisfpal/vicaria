// Writing a lesson, and the follow-up chat on it. The chat is Ask's: the same Turn records, the same storage under the
// key chat:lesson:<id> and the same streaming call. A long thread folds its older part into one summary turn.
import { stream, type Route, type Msg } from "../ai/providers";
import { loadChat, saveChat, type Turn } from "../ai/ask";
import { LESSON_MAX_OUT, SUMMARY_MAX_OUT, estimate, room, spent, loadSpend, saveSpend, dayOf } from "./budget";
import { lessonMessages, parseLesson, LANG_NAME } from "./prompts";
import { sample, spread, rng, type Source } from "./pick";
import { memoryFor, putLesson, type Lesson, type Prefs } from "./data";

export class LimitError extends Error { constructor() { super("daily limit"); } }
export class UnreadableError extends Error { constructor() { super("unreadable"); } }
export interface LessonDeps {
  prefs: Prefs; lessons: Lesson[]; load: () => Promise<Source>; lang: string; ai: { route: Route; key: string };
  topic?: string; people?: string[]; now?: number; signal?: AbortSignal; fetch?: typeof fetch;
}
const chars = (ms: Msg[]) => ms.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);

export async function makeLesson(d: LessonDeps): Promise<Lesson> {
  const now = d.now ?? Date.now(), day = dayOf(now), src = await d.load();
  const items = spread(sample(src.items, {}, 4, now, rng(`lesson${now}`)));
  const msgs = lessonMessages({ prefs: d.prefs, lang: d.lang, library: src.books, memory: memoryFor(d.lessons), items, topic: d.topic, people: d.people });
  const need = estimate(chars(msgs)) + LESSON_MAX_OUT;
  if (!room(loadSpend(), day, need)) throw new LimitError();
  const r = await stream(d.ai.route, d.ai.key, msgs, { json: true, maxTokens: LESSON_MAX_OUT, signal: d.signal, fetch: d.fetch });
  saveSpend(spent(loadSpend(), day, r.usage ? r.usage.input + r.usage.output : need));
  const p = parseLesson(r.text); if (!p) throw new UnreadableError();
  const lesson: Lesson = { id: `les-${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`, ...p, topics: d.topic ? [d.topic] : d.prefs.topics.slice(0, 4), lang: d.lang, src: "ai", made: now };
  await putLesson(lesson);
  return lesson;
}

// ---- follow-up chat ----
export const lessonChatKey = (id: string) => `chat:lesson:${id}`;
export const THREAD_MAX = 20, THREAD_KEEP = 8;
const HISTORY = 12;
export function chatMessages(l: Lesson, turns: Turn[], question: string, lang: string): Msg[] {
  const sys = [`You are a teacher talking with one reader about this lesson you wrote. Answer in ${LANG_NAME[lang] ?? "English"}.`,
    "Stay with the lesson's model and the people in it. Plain, exact sentences, no filler, no flattery, no em dashes. Say \"paraphrase\" when you paraphrase and never invent a quotation. Math in LaTeX.",
    `Lesson: ${l.title}\n${l.body}`].join("\n\n");
  const past: Msg[] = turns.filter(t => !t.error && t.text).slice(-HISTORY).map(t => ({ role: t.role, content: t.summary ? `(Summary of the earlier conversation) ${t.text}` : t.text }));
  return [{ role: "system", content: sys }, ...past, { role: "user", content: question }];
}
export const needsSummary = (turns: Turn[]) => turns.length > THREAD_MAX;
// Fold everything but the newest THREAD_KEEP turns into one summary turn; `summary` is what the model said about them.
export function foldThread(turns: Turn[], summary: string): Turn[] {
  const cut = Math.max(0, turns.length - THREAD_KEEP);
  return cut ? [{ role: "assistant", text: summary, at: turns[cut - 1].at, summary: true }, ...turns.slice(cut)] : turns;
}
export async function summarize(route: Route, key: string, turns: Turn[], f?: typeof fetch): Promise<string> {
  const cut = Math.max(0, turns.length - THREAD_KEEP);
  const text = turns.slice(0, cut).filter(t => !t.error && t.text).map(t => `${t.role === "user" ? "Reader" : "Teacher"}: ${t.text.slice(0, 600)}`).join("\n");
  const r = await stream(route, key, [{ role: "system", content: "Summarize this conversation in under 120 words: what the reader asked, what was settled, what is still open. Plain sentences." }, { role: "user", content: text }], { maxTokens: SUMMARY_MAX_OUT, fetch: f });
  saveSpend(spent(loadSpend(), dayOf(), r.usage ? r.usage.input + r.usage.output : estimate(text.length) + SUMMARY_MAX_OUT));
  return r.text.trim();
}
export const loadThread = (id: string) => loadChat(lessonChatKey(id));
export const saveThread = (id: string, turns: Turn[]) => saveChat(lessonChatKey(id), turns);

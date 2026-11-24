// What the two features keep, as ops of the log (docs/design/wiser.md): saved thoughts ("thought"), lessons with their
// memory ("lesson") and the reader's customisation ("wiser"). Each op carries a whole record; the newest op per id wins
// (the log's own order), so devices merge without a rule of their own. A device that does not know these kinds stores
// and forwards them (docs/MIGRATIONS.md), so no database step is needed. Everything here is pure except the writers.
import type { Op } from "../core/types";
import { newer } from "../core/ops";

export type ThoughtSrc = "ai" | "mine" | "ideas" | "bundled";
export interface Thought { id: string; text: string; act?: string; by?: string; from?: string; src: ThoughtSrc; day: string; made: number; gone?: boolean }
export interface Lesson { id: string; title: string; body: string; people: string[]; models: string[]; summary: string; topics: string[]; lang: string; src: "ai" | "bundled"; made: number; fav?: boolean; gone?: boolean }
export const TONES = ["plain", "warm", "blunt"] as const;
export const LENGTHS = ["short", "medium", "long"] as const;
export type Tone = typeof TONES[number];
export type Length = typeof LENGTHS[number];
export interface Prefs { people: string[]; outside: boolean; tone: Tone; length: Length; topics: string[]; template: string }
export const DEFAULT_PREFS: Prefs = { people: [], outside: true, tone: "plain", length: "medium", topics: [], template: "" };
export interface BundledThought { id: string; by: string; work: string; text: string; act: string }
export interface BundledLesson { id: string; title: string; people: string[]; models: string[]; summary: string; body: string }

const str = (x: unknown, max: number) => typeof x === "string" ? x.slice(0, max) : "";
const strs = (x: unknown, n: number, max: number) => Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()).map(s => s.trim().slice(0, max)).slice(0, n) : [];
const num = (x: unknown, d: number) => typeof x === "number" && Number.isFinite(x) ? x : d;
const SRC_T = ["ai", "mine", "ideas", "bundled"];

export function cleanThought(v: Record<string, unknown>, t = 0): Thought | null {
  const id = str(v.id, 80), text = str(v.text, 1200);
  if (!id || !text) return null;
  return { id, text, ...(v.act ? { act: str(v.act, 400) } : {}), ...(v.by ? { by: str(v.by, 120) } : {}), ...(v.from ? { from: str(v.from, 300) } : {}),
    src: SRC_T.includes(v.src as string) ? v.src as ThoughtSrc : "mine", day: str(v.day, 10), made: num(v.made, t), ...(v.gone === true ? { gone: true } : {}) };
}
export function cleanLesson(v: Record<string, unknown>, t = 0): Lesson | null {
  const id = str(v.id, 80), title = str(v.title, 200), body = str(v.body, 8000);
  if (!id || !title || !body) return null;
  return { id, title, body, people: strs(v.people, 8, 80), models: strs(v.models, 8, 80), summary: str(v.summary, 600), topics: strs(v.topics, 8, 60), lang: str(v.lang, 5) || "en",
    src: v.src === "bundled" ? "bundled" : "ai", made: num(v.made, t), ...(v.fav === true ? { fav: true } : {}), ...(v.gone === true ? { gone: true } : {}) };
}
export function cleanPrefs(v: Record<string, unknown>): Prefs {
  return { people: strs(v.people, 40, 80), outside: v.outside !== false, tone: TONES.includes(v.tone as Tone) ? v.tone as Tone : "plain",
    length: LENGTHS.includes(v.length as Length) ? v.length as Length : "medium", topics: strs(v.topics, 20, 60), template: str(v.template, 4000) };
}

// the newest op of each record id
function newest(ops: Op[], k: string): Op[] {
  const cur = new Map<string, Op>();
  for (const o of ops) { if (o.k !== k) continue; const id = k === "wiser" ? "" : String(o.v.id); const c = cur.get(id); if (!c || newer(o, c)) cur.set(id, o); }
  return [...cur.values()];
}
export const foldThoughts = (ops: Op[]): Thought[] => newest(ops, "thought").map(o => cleanThought(o.v, o.t)).filter((x): x is Thought => !!x && !x.gone).sort((a, b) => b.made - a.made || (a.id < b.id ? -1 : 1));
export const foldLessons = (ops: Op[]): Lesson[] => newest(ops, "lesson").map(o => cleanLesson(o.v, o.t)).filter((x): x is Lesson => !!x && !x.gone).sort((a, b) => b.made - a.made || (a.id < b.id ? -1 : 1));
export function foldPrefs(ops: Op[]): Prefs { const o = newest(ops, "wiser")[0]; return o ? cleanPrefs(o.v) : { ...DEFAULT_PREFS }; }

// Lessons are found by any word of title, people, models, topics and summary (accents and case ignored).
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function searchLessons(ls: Lesson[], q: string): Lesson[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return ls;
  return ls.filter(l => { const k = fold([l.title, l.summary, ...l.people, ...l.models, ...l.topics].join(" ")); return words.every(w => k.includes(w)); });
}
// what the next lesson must not repeat and may build on: the newest titles with their summaries
export function memoryFor(ls: Lesson[], n = 12): { title: string; people: string[]; models: string[]; summary: string }[] {
  return ls.slice(0, n).map(l => ({ title: l.title, people: l.people, models: l.models, summary: l.summary }));
}

// ---- writers ----
const write = async (k: "thought" | "lesson" | "wiser", v: Record<string, unknown>) => (await import("../core/ops")).addOp(k, v);
export const putThought = (t: Thought) => write("thought", { ...t });
export const putLesson = (l: Lesson) => write("lesson", { ...l });
export const putPrefs = (p: Prefs) => write("wiser", { ...p });
export async function readAll() { const { allOps } = await import("../core/ops"); const ops = await allOps(); return { thoughts: foldThoughts(ops), lessons: foldLessons(ops), prefs: foldPrefs(ops) }; }

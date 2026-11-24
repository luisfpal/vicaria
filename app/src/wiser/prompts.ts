// The words that go to the model. The thought prompt and the lesson blueprint (structure, quality rules and the JSON the
// app reads) are fixed here; only the voice template, people, tone, length and topics come from Settings. Pure.
import type { Msg } from "../ai/providers";
import type { Cand } from "./pick";
import type { Length, Prefs, Tone } from "./data";

export const LANG_NAME: Record<string, string> = { en: "English", es: "Spanish" };
export const ITEM_CHARS = 280, MAX_ITEMS = 6, MAX_TAGS = 4;
const clip = (s: string, n: number) => s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";

export const THOUGHT_RULES = [
  "You write one short thought for a reader, so that they go to bed a little wiser than they woke up.",
  "- One or two sentences, at most 45 words.",
  "- Name a real friction point the reader may be living (avoidance, overwhelm, perfectionism, comparison, guilt, a decision put off), give one concrete action they can do in under an hour (start it with a verb), and the reframe that shows why that action matters more than it looks. The three may share a sentence.",
  "- Connect at least two of the reader's items below when you can (different books, or a highlight and a tag). Never quote more than six words in a row and never invent a quotation or attribute words to anyone.",
  "- No platitudes (\"believe in yourself\", \"you've got this\"), no flattery, no em dashes, no emoji, no hashtags.",
  "- The idea matters, not who said it: name a book or a person only if it makes the thought clearer.",
];
export function thoughtMessages(items: Cand[], tags: string[], recent: string[], lang: string): Msg[] {
  const sys = [...THOUGHT_RULES, `- Write in ${LANG_NAME[lang] ?? "English"}.`, "Reply with JSON only: {\"text\": \"the thought\", \"uses\": [numbers of the items you used]}."].join("\n");
  const lines = items.slice(0, MAX_ITEMS).map((c, i) => `[${i + 1}] (${clip(c.title, 80)}${c.author ? `, ${clip(c.author, 60)}` : ""}) "${clip(c.text, ITEM_CHARS)}"${c.note ? ` Reader's note: ${clip(c.note, 160)}` : ""}`);
  const user = [lines.length ? `The reader's highlights and notes:\n${lines.join("\n")}` : "", tags.length ? `Topics the reader tags: ${tags.slice(0, MAX_TAGS).join(", ")}` : "", recent.length ? `Do not repeat these recent thoughts: ${recent.slice(0, 3).map(r => clip(r, 120)).join(" | ")}` : ""].filter(Boolean).join("\n\n");
  return [{ role: "system", content: sys }, { role: "user", content: user || "No highlights yet. Write a thought about reading." }];
}
function jsonOf(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; }
}
export function parseThought(raw: string): { text: string; uses: number[] } | null {
  const j = jsonOf(raw);
  const text = typeof j?.text === "string" ? j.text.trim() : j ? "" : raw.trim();
  if (!text || text.length > 600) return null;
  return { text, uses: Array.isArray(j?.uses) ? (j!.uses as unknown[]).filter((n): n is number => Number.isInteger(n)) : [] };
}

// ---- lessons ----
export const TONE_WORDS: Record<Tone, string> = { plain: "plain and exact, like a good teacher talking to an adult", warm: "warm and encouraging, never sugary", blunt: "blunt and brisk, no cushioning" };
export const LENGTH_WORDS: Record<Length, [number, number]> = { short: [150, 200], medium: [200, 260], long: [250, 300] };
export const DEFAULT_TEMPLATE = [
  "You are a teacher who explains one mental model through the people who found it. You write a lesson for one reader.",
  "Voice: {tone}.",
  "People to draw from: {people}",
  "Topics the reader cares about: {topics}",
  "Length: about {length} words.",
  "{avoid}",
].join("\n");
export const SLOTS = ["tone", "people", "topics", "length", "avoid"] as const;
// The fixed part. Never editable: it is what makes lessons the same quality for everyone and what the app parses.
export const BLUEPRINT = [
  "Structure of the lesson (the body is markdown, four short paragraphs, each opening with a bold lead-in in the lesson's language):",
  "1. The idea: one sentence a smart newcomer would follow.",
  "2. Where it comes from: the person, the situation and what they actually did.",
  "3. Why it holds: the first principles, step by step, with no jargon left undefined.",
  "4. A concrete case with real numbers, then one move the reader can make today.",
  "Quality rules: start from first principles, not slogans; be concrete (names, numbers, a scene); no filler, no flattery, no platitudes; no em dashes; never invent a quotation, and say \"paraphrase\" when you paraphrase; end with the hard part honestly (a limit of the model).",
  "Reply with JSON only: {\"title\": \"...\", \"body\": \"...\", \"people\": [\"...\"], \"models\": [\"...\"], \"summary\": \"one or two sentences\"}.",
].join("\n");
export function fill(tpl: string, slots: Record<(typeof SLOTS)[number], string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (slots as Record<string, string>)[k] ?? m);
}
export interface LessonInput {
  prefs: Prefs; lang: string; library: { author: string; title: string }[];
  memory: { title: string; people: string[]; models: string[]; summary: string }[];
  items: Cand[]; topic?: string; people?: string[];
}
export function lessonMessages(i: LessonInput): Msg[] {
  const [lo, hi] = LENGTH_WORDS[i.prefs.length];
  const authors = [...new Set(i.library.map(b => b.author).filter(Boolean))].slice(0, 30);
  const chosen = i.people?.length ? i.people : i.prefs.people;
  const people = (chosen.length ? `${chosen.join(", ")}.` : "your choice.") + (i.prefs.outside || !chosen.length ? ` Include one or two people the reader has not read yet, so they meet new models${authors.length ? ` (the reader has read: ${authors.join(", ")})` : ""}.` : ` Stay with these people.`);
  const topics = (i.topic ? [i.topic] : i.prefs.topics).join(", ") || "any that fits";
  const avoid = i.memory.length ? `Earlier lessons for this reader (do not repeat a model; you may build on one):\n${i.memory.map(m => `- ${m.title} (${m.models.join(", ")}; ${m.people.join(", ")}): ${m.summary}`).join("\n")}` : "";
  const tpl = i.prefs.template.trim() || DEFAULT_TEMPLATE;
  const sys = [fill(tpl, { tone: TONE_WORDS[i.prefs.tone], people, topics, length: `${lo} to ${hi}`, avoid }), BLUEPRINT, `Write the lesson in ${LANG_NAME[i.lang] ?? "English"}.`].join("\n\n");
  const mats = i.items.slice(0, MAX_ITEMS).map((c, n) => `[${n + 1}] (${clip(c.title, 80)}${c.author ? `, ${clip(c.author, 60)}` : ""}) "${clip(c.text, ITEM_CHARS)}"${c.note ? ` Reader's note: ${clip(c.note, 160)}` : ""}`);
  const user = mats.length ? `Things the reader marked, for a connection if one is natural (never required):\n${mats.join("\n")}` : "The reader has no marks yet. Pick a model that serves everyday life.";
  return [{ role: "system", content: sys }, { role: "user", content: user }];
}
export interface Parsed { title: string; body: string; people: string[]; models: string[]; summary: string }
export function parseLesson(raw: string): Parsed | null {
  const j = jsonOf(raw); if (!j) return null;
  const s = (x: unknown) => typeof x === "string" ? x.trim() : "";
  const arr = (x: unknown) => Array.isArray(x) ? x.filter((y): y is string => typeof y === "string").map(y => y.trim()).filter(Boolean).slice(0, 8) : [];
  const title = s(j.title), body = s(j.body);
  if (!title || body.split(/\s+/).length < 40) return null;
  return { title, body, people: arr(j.people), models: arr(j.models), summary: s(j.summary) || body.slice(0, 160) };
}
export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// One question to the model about a book: which passages go, the messages, the stream, and the conversation kept on
// this device. Conversations are local (IndexedDB "kv", key chat:<book>:<scope>): they are not synced or exported.
import type { Passage } from "../core/types";
import { get, put, del } from "../core/idb";
import { passages as readPassages } from "../core/read";
import { contextFor, cite, type Scope } from "./retrieve";
import { stream, type Msg, type Part, type Route, type Result } from "./providers";

export interface Turn { role: "user" | "assistant"; text: string; at: number; summary?: boolean; sent?: string[]; selection?: string; images?: number; error?: string; errorKind?: string }
export interface BookInfo { id: string; title: string; author: string }
export const chatKey = (book: string, scope: Scope) => `chat:${book}:${scope.mode === "book" ? "book" : `ch${scope.upTo?.section ?? scope.selection?.section ?? 0}`}`;
export const loadChat = async (key: string) => (await get<Turn[]>("kv", key)) ?? [];
export const saveChat = (key: string, turns: Turn[]) => put("kv", turns.slice(-200), key);
export const clearChat = (key: string) => del("kv", key);

const HISTORY = 12; // earlier turns sent back, text only
export function systemPrompt(b: BookInfo, s: Scope, chapter?: string): string {
  const scope = s.mode === "book" ? "the book" : `the chapter "${chapter || "this chapter"}"`;
  return [
    `You are a reading companion talking with one reader about ${scope} of "${b.title}"${b.author ? ` by ${b.author}` : ""}.`,
    "How you answer:",
    "- Ground everything in the book passages you are given. Right after a claim that uses a passage, cite it by its id in square brackets, like [12.4]. Use only ids you were given.",
    "- If the passages do not say, say \"The book does not say.\" first; then you may add your own view, marked as your own.",
    "- Lead with the answer in one or two sentences, then the reasoning. Use the author's own examples.",
    "- Plain, exact sentences. No filler, no flattery, no restating the question, no em dashes.",
    ...(s.whole ? [] : ["- The reader has not finished the book. Never reveal what happens after the passages you were given."]),
    "- Write math in LaTeX: $...$ inline, $$...$$ for a display formula. When a diagram helps, add one ```mermaid block (a flowchart or sequence diagram) with short labels.",
    "- Reply in the language the reader writes in.",
  ].join("\n");
}
export function material(ps: Passage[]): string {
  return ps.map(p => `[${cite(p)}] (${p.chapter || "untitled"})\n${p.text}`).join("\n\n");
}
export function buildMessages(b: BookInfo, s: Scope, ps: Passage[], history: Turn[], question: string, images: Part[] = [], chapter?: string): Msg[] {
  const past: Msg[] = history.filter(t => !t.error && t.text).slice(-HISTORY).map(t => ({ role: t.role, content: t.text }));
  const parts = [`Book passages:\n\n${material(ps) || "(none matched)"}`];
  if (s.selection) parts.push(`The reader selected this text [${s.selection.section}.${s.selection.block}]:\n"${s.selection.text}"`);
  parts.push(`Question: ${question}`);
  const text = parts.join("\n\n");
  return [{ role: "system", content: systemPrompt(b, s, chapter) }, ...past, { role: "user", content: images.length ? [{ type: "text", text }, ...images] : text }];
}

export interface Asked { msgs: Msg[]; sent: Passage[] }
// what would go to the model for this question (also what "What was sent" shows)
export async function prepare(b: BookInfo, s: Scope, question: string, history: Turn[], images: Part[] = [], all?: Passage[], byMeaning: string[] = []): Promise<Asked> {
  const ps = all ?? (await readPassages(b.id)) ?? [];
  const sent = contextFor(ps, question, s, byMeaning);
  const here = s.selection?.section ?? s.upTo?.section;
  const chapter = ps.find(p => p.section === here)?.chapter;
  return { msgs: buildMessages(b, s, sent, history, question, images, chapter), sent };
}
export async function askBook(route: Route, key: string, a: Asked, o: { signal?: AbortSignal; onText?: (d: string, all: string) => void; fetch?: typeof fetch } = {}): Promise<Result> {
  return stream(route, key, a.msgs, { ...o, maxTokens: 2000 });
}

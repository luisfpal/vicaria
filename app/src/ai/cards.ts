// Chapter cards, ported from 0.x (book_reader/cards.py, prompt version c3): one core claim and three lessons per
// chapter, the book's own terms, and a diagram only when the ideas have a structure a list cannot show. Limits, a
// repetition check and the diagram's shape are checked here; a card that fails is rewritten once, then whatever still
// repeats in optional fields is dropped and a diagram that still fails is left out.
import { stream, type Route } from "./providers";

export const CARD_VERSION = "c3";
export interface Lesson { lesson: string; why: string }
export interface Term { term: string; meaning: string }
export type Diagram =
  | { type: "cause" | "process" | "cycle" | "map"; title: string; nodes: { id: string; label: string }[]; edges: { from: string; to: string; label: string }[] }
  | { type: "compare"; title: string; sides: [string, string]; rows: { aspect: string; a: string; b: string }[] }
  | { type: "none"; why?: string };
export interface Card { core: string; lessons: Lesson[]; remember?: string; terms?: Term[]; diagram?: Diagram; model?: string; v?: string }

const LIMITS = { core: 30, lesson: 14, why: 32, remember: 18 } as const;
export const STYLE = `You hand on the lessons of a book the way the best book explainers do: one big idea, a few memorable lessons, timeless rather than topical. Plain words a smart 15-year-old understands. Every lesson must be something the reader can use or see the world through, grounded in the text. No filler, no praise, no em dashes, no "the author argues". Every field must add something no other field says: never restate a claim in new words. Define before you use: any word the book gives its own meaning (an everyday word it redefines, like "game", "stroke" or "script", or a technical term) goes in "terms" with the book's own definition, in plain words. Never pass off an outside definition as the book's; if the book only shows the meaning, say how the book uses it. Write in the language of the chapter. Reply with JSON only.`;
const DIAGRAM = `"diagram": decide first whether these ideas have a structure that a list cannot show. Pick exactly one type:
 "cause": one thing causes or produces another, in a chain of at least 3 steps (causes may join or branch)
 "process": ordered steps that lead to a result
 "cycle": a feedback loop, where the last step feeds the first again
 "compare": two things contrasted on the same aspects
 "map": concepts joined by different named relationships (requires, produces, is part of, contrasts with)
 "none": the ideas are parallel points with no real relationship between them. Choose none rather than force a diagram.
Every edge must be a relationship the text states or clearly shows: never invent a cause. When the text contrasts two things (people and machines, old and new, two methods), compare usually teaches best.
For cause, process, cycle or map: {"type": "...", "title": "the question it answers, at most 10 words", "nodes": [{"id": "a", "label": "2 to 5 words"}], "edges": [{"from": "a", "to": "b", "label": "a verb, 1 to 3 words"}]} with 3 to 7 nodes named after things in this chapter. Never hang every node off one centre node: that is a list. At least one edge must join two nodes that are not the main idea.
For compare: {"type": "compare", "title": "...", "sides": ["A", "B"], "rows": [{"aspect": "1 to 3 words", "a": "at most 8 words", "b": "at most 8 words"}]} with 3 to 5 rows.
For none: {"type": "none", "why": "one short reason"}.`;
export function chapterPrompt(title: string, author: string, chapter: string, text: string) {
  return `Book: ${title}${author ? ` by ${author}` : ""}
Chapter: ${chapter}

Write the card for this chapter as JSON:
{"core": "the chapter's one claim, a single sentence, at most 25 words",
 "lessons": [{"lesson": "a sub-claim that the core does not already state, at most 12 words", "why": "the evidence, mechanism or concrete example from the text behind that sub-claim, at most 30 words; do not repeat its words"}],
 "remember": "a memorable line ONLY if it adds something new (an image, a rule of thumb, a question) and reuses no example above; otherwise an empty string",
 "terms": [{"term": "a word or phrase used above in this book's own sense", "meaning": "the book's definition, plain words, at most 25 words"}],
 ${DIAGRAM}}
Exactly 3 lessons, each a different sub-claim. "terms": every word in the core and lessons that a reader new to this book would misread (0 to 5 of them; [] when there are none). The book's title words count when the book redefines them.

--- CHAPTER TEXT ---
${text}`;
}

const words = (s: unknown) => String(s ?? "").split(/\s+/).filter(Boolean).length;
const STOP = new Set(("a an the and or but if then so of to in on at by for with from into onto over under as is are was were be been being it its this that these those there their they them he she his her you your we our us i me my not no nor do does did done can could will would should may might must have has had than too very just also only more most less much many such what which who whom whose when where why how all any each every some one ones own same other another about out up down off again further once here both few new old get gets got make makes made way ways thing things").split(" "));
function contentWords(s: string): Set<string> {
  const out = new Set<string>();
  for (let w of (s.toLowerCase().replace(/\u2019/g, "'").match(/\p{L}+/gu) ?? [])) {
    if (w.length < 3 || STOP.has(w)) continue;
    for (const suf of ["ing", "ed", "es", "s"]) if (w.endsWith(suf) && w.length - suf.length >= 4 && !w.endsWith("ss")) { w = w.slice(0, -suf.length); break; }
    out.add(w);
  }
  return out;
}
export function overlap(a: string, b: string): number {
  const A = contentWords(a), B = contentWords(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  const j = inter / (A.size + B.size - inter), small = Math.min(A.size, B.size);
  const contain = small >= 3 ? inter / small : 0;
  return Math.max(j, contain < 0.8 ? 0 : contain * 0.75);
}
function elements(c: Card): [string, string][] {
  const out: [string, string][] = [["core", c.core]];
  (c.lessons || []).forEach((l, i) => { out.push([`lesson ${i + 1}`, l?.lesson ?? ""], [`lesson ${i + 1} body`, l?.why ?? ""]); });
  if (c.remember) out.push(["remember", c.remember]);
  return out.filter(([, v]) => String(v).trim());
}
export function repeats(c: Card, threshold = 0.35): [string, string, number][] {
  const els = elements(c), out: [string, string, number][] = [];
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) { const s = overlap(els[i][1], els[j][1]); if (s > threshold) out.push([els[i][0], els[j][0], Math.round(s * 100) / 100]); }
  return out;
}

// ---- diagrams ----
export function diagramProblems(d: unknown): string[] {
  if (!d || typeof d !== "object") return ["diagram missing: give a diagram object or type none"];
  const x = d as Record<string, unknown>, t = x.type;
  if (t === "none") return [];
  if (!["cause", "process", "cycle", "map", "compare"].includes(String(t))) return [`diagram type ${JSON.stringify(t)} is not one of cause, process, cycle, map, compare, none`];
  const out: string[] = [];
  if (t === "compare") {
    const sides = (x.sides as unknown[]) || [], rows = (x.rows as Record<string, unknown>[]) || [];
    if (sides.length !== 2 || !sides.every(s => String(s).trim())) out.push("compare needs exactly 2 sides");
    if (rows.length < 3 || rows.length > 5) out.push(`compare has ${rows.length} rows, need 3 to 5`);
    for (const r of rows) {
      if (!r || !["aspect", "a", "b"].every(k => String(r[k] ?? "").trim())) { out.push("every compare row needs aspect, a and b"); break; }
      if (words(r.a) > 9 || words(r.b) > 9 || words(r.aspect) > 4) out.push(`compare row "${r.aspect}" is too long (aspect <= 3 words, cells <= 8)`);
    }
    return out;
  }
  const nodes = ((x.nodes as Record<string, unknown>[]) || []).filter(n => n && String(n.id ?? "").trim());
  const ids = nodes.map(n => String(n.id)), edges = ((x.edges as Record<string, unknown>[]) || []).filter(e => e && typeof e === "object");
  if (nodes.length < 3 || nodes.length > 8) return [`diagram has ${nodes.length} nodes, need 3 to 7`];
  if (new Set(ids).size !== ids.length) out.push("duplicate node ids");
  for (const n of nodes) if (!String(n.label ?? "").trim() || words(n.label) > 6) out.push(`node ${n.id} label must be 2 to 5 words`);
  const labels = nodes.map(n => String(n.label ?? "").trim().toLowerCase());
  if (new Set(labels).size !== labels.length) out.push("two nodes have the same label");
  for (const e of edges) {
    const f = String(e.from), to = String(e.to);
    if (!ids.includes(f) || !ids.includes(to)) out.push(`edge ${f}->${to} points to a missing node`);
    if (!String(e.label ?? "").trim() || words(e.label) > 4) out.push(`edge ${f}->${to} needs a 1 to 3 word verb label`);
  }
  if (out.length) return out;
  const E = edges.map(e => [String(e.from), String(e.to)] as const);
  if (E.length < ids.length - 1) return ["some nodes are not connected"];
  const seen = new Set([ids[0]]), todo = [ids[0]];
  while (todo.length) { const n = todo.pop()!; for (const [a, b] of E) for (const [p, q] of [[a, b], [b, a]]) if (p === n && !seen.has(q)) { seen.add(q); todo.push(q); } }
  if (seen.size !== ids.length) out.push("some nodes are not connected");
  const star = (() => {
    if (ids.length < 3 || !E.length) return false;
    for (const hub of ids) if (E.every(([a, b]) => a === hub || b === hub)) { if (ids.length >= 4) return true; const outs = E.filter(([a]) => a === hub).length; return outs === 0 || outs === E.length; }
    return false;
  })();
  if (star) out.push("every node hangs off one centre node: that is a list, not a diagram. Show how the parts relate to each other, or choose type none");
  const adj = new Map(ids.map(i => [i, E.filter(([a]) => a === i).map(([, b]) => b)]));
  const longest = () => { let best = 0; const walk = (n: string, s: Set<string>) => { best = Math.max(best, s.size); for (const m of adj.get(n)!) if (!s.has(m)) walk(m, new Set([...s, m])); }; ids.forEach(n => walk(n, new Set([n]))); return best; };
  const cyclic = () => { const st = new Map<string, number>(); const dfs = (n: string): boolean => { st.set(n, 1); for (const m of adj.get(n)!) if (st.get(m) === 1 || (!st.has(m) && dfs(m))) return true; st.set(n, 2); return false; }; return ids.some(n => !st.has(n) && dfs(n)); };
  if (t === "cycle" && !cyclic()) out.push("a feedback loop needs edges that return to the start");
  if ((t === "cause" || t === "process") && longest() < 3) out.push(`a ${t} diagram needs a chain of at least 3 steps`);
  return out;
}

export function problems(c: Card): string[] {
  const out: string[] = [];
  if (!c.core) out.push("missing core");
  for (const k of ["core", "remember"] as const) if (words(c[k]) > LIMITS[k]) out.push(`${k} has ${words(c[k])} words, limit ${LIMITS[k]}`);
  const ls = c.lessons || [];
  if (ls.length !== 3) out.push(`${ls.length} lessons, need 3`);
  ls.forEach((l, i) => {
    if (!l || !l.lesson) { out.push(`lesson ${i + 1} empty`); return; }
    for (const k of ["lesson", "why"] as const) if (words(l[k]) > LIMITS[k]) out.push(`lesson ${i + 1} ${k} has ${words(l[k])} words, limit ${LIMITS[k]}`);
  });
  for (const [a, b, s] of repeats(c)) out.push(`${a} and ${b} say the same thing (${Math.round(s * 100)}% shared words): make ${b} add new information`);
  out.push(...diagramProblems(c.diagram));
  return out;
}
export function settle(c: Card): Card {
  const card = { ...c };
  if (card.remember && repeats(card).some(([a, b]) => a === "remember" || b === "remember")) card.remember = "";
  if (card.diagram && card.diagram.type !== "none" && diagramProblems(card.diagram).length) card.diagram = { type: "none", why: "left out: it did not pass its checks" };
  card.lessons = (card.lessons || []).slice(0, 3);
  return card;
}
const parse = (raw: string): Card => { const m = raw.match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : ({} as Card); } catch { return {} as Card; } };

export async function makeCard(route: Route, key: string, book: { title: string; author: string }, chapter: string, text: string, o: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<Card> {
  let prompt = chapterPrompt(book.title, book.author, chapter, text.slice(0, 60_000)), card = {} as Card;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await stream(route, key, [{ role: "system", content: STYLE }, { role: "user", content: prompt }], { ...o, maxTokens: 2500, json: true });
    card = parse(r.text);
    const probs = problems(card);
    if (!probs.length) break;
    if (attempt === 0) prompt += `\n\nYour last reply had these problems, fix every one: ${probs.join("; ")}`;
  }
  if (!card.lessons?.length || !card.core) throw new Error("The model did not return a usable card. Try again.");
  return { ...settle(card), model: route.model, v: CARD_VERSION };
}

// ---- showing a card: Markdown with a Mermaid diagram or a comparison table ----
const q = (s: string) => `"${String(s).replace(/"/g, "'").replace(/[\[\]{}<>]/g, " ")}"`;
export function diagramMarkdown(d?: Diagram): string {
  if (!d || d.type === "none" || diagramProblems(d).length) return "";
  if (d.type === "compare") {
    const cell = (s: string) => String(s).replace(/\|/g, "/");
    return `#### ${d.title}\n\n| | ${cell(d.sides[0])} | ${cell(d.sides[1])} |\n|---|---|---|\n${d.rows.map(r => `| ${cell(r.aspect)} | ${cell(r.a)} | ${cell(r.b)} |`).join("\n")}`;
  }
  const id = (s: string) => "n" + String(s).replace(/[^A-Za-z0-9_]/g, "_");
  const lines = ["flowchart LR", ...d.nodes.map(n => `  ${id(n.id)}[${q(n.label)}]`), ...d.edges.map(e => `  ${id(e.from)} -->|${q(e.label)}| ${id(e.to)}`)];
  return `#### ${d.title}\n\n\`\`\`mermaid\n${lines.join("\n")}\n\`\`\``;
}
export function cardMarkdown(c: Card): string {
  const parts = [`**${c.core}**`, c.lessons.map((l, i) => `${i + 1}. **${/[.!?:]$/.test(l.lesson.trim()) ? l.lesson.trim() : l.lesson.trim() + "."}**  \n   ${l.why}`).join("\n")];
  if (c.remember) parts.push(`> ${c.remember}`);
  if (c.terms?.length) parts.push(c.terms.map(t => `*${t.term}*: ${t.meaning}`).join("  \n"));
  const d = diagramMarkdown(c.diagram); if (d) parts.push(d);
  return parts.join("\n\n");
}

// ---- stored as ops, so a card made on one device is on all of them ----
import { addOp, bookOps, newer } from "../core/ops";
import type { Op } from "../core/types";
export function cardIn(ops: Op[], book: string, section: number): Card | null {
  let best: Op | null = null;
  for (const o of ops) if (o.k === "chapter-card" && o.v.book === book && o.v.section === section && o.v.card && typeof o.v.card === "object" && (!best || newer(o, best))) best = o;
  const c = best?.v.card as Card | undefined;
  return c && typeof c.core === "string" && Array.isArray(c.lessons) ? c : null;
}
export const savedCard = async (book: string, section: number) => cardIn(await bookOps(book), book, section);
export const saveCard = (book: string, section: number, card: Card) => addOp("chapter-card", { book, section, card: card as unknown as Record<string, unknown> });

// Writing marks. Every change is one "mark" op; the fold in marks.ts turns the log back into marks.
import { addOp } from "./ops";
import { invariantProblem, validMarkV, validNote, validSet, NOTE_MAX, type Mark, type MarkSet, type MarkOpV } from "./marks";
import { PARSER_VERSION, type Op } from "./types";

export class MarkError extends Error {}
const write = (v: MarkOpV | ((id: string) => MarkOpV)) => addOp("mark", (id: string) => {
  const x = typeof v === "function" ? v(id) : v;
  if (x.set && "at" in x.set) x.p = PARSER_VERSION; // so a device that reads the book differently knows to find it again
  if (!validMarkV(x)) throw new MarkError("That change is not valid.");
  return x as unknown as Record<string, unknown>;
});

export async function createMark(book: string, set: MarkSet, extra: { note?: string; tags?: string[] } = {}): Promise<Op> {
  const problem = invariantProblem({ ...set, note: extra.note });
  if (problem) throw new MarkError(problem);
  if (!set.at) throw new MarkError("a mark needs a place in the text");
  if (extra.note !== undefined && !validNote(extra.note)) throw new MarkError(`A note can hold up to ${NOTE_MAX / 1024} KB.`);
  const op = await write(id => ({ id, book, set: { ...set, made: Date.now() }, ...(extra.note ? { note: extra.note, base: null } : {}) }));
  for (const t of extra.tags || []) await addTag({ id: op.id, book } as Mark, t);
  return op;
}
// Fields to change; null removes a facet ({ bookmark: null } un-bookmarks).
export async function updateMark(m: Mark, set: { [K in keyof MarkSet]?: MarkSet[K] | null }) {
  if (!validSet(set)) throw new MarkError("That change is not valid.");
  const next = { ...m, ...Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v ?? undefined])) } as Mark;
  const problem = invariantProblem(next); if (problem) throw new MarkError(problem);
  return write({ id: m.id, book: m.book, set: set as Record<string, unknown> });
}
// A note edit names the version it replaced. Saving while conflict copies are shown resolves them.
export async function setNote(m: Mark, text: string, resolveConflicts = false) {
  if (!validNote(text)) throw new MarkError(`A note can hold up to ${NOTE_MAX / 1024} KB.`);
  if (!text && m.sticky) throw new MarkError("a sticky note needs text");
  return write({ id: m.id, book: m.book, note: text, base: m.noteOp ?? null, ...(resolveConflicts && m.conflicts.length ? { resolves: m.conflicts.map(c => c.op) } : {}) });
}
export const dismissConflicts = (m: Mark) => write({ id: m.id, book: m.book, resolves: m.conflicts.map(c => c.op), note: m.note ?? "", base: m.noteOp ?? null });
export async function addTag(m: Pick<Mark, "id" | "book">, tag: string) { return write({ id: m.id, book: m.book, tag: tag.trim().slice(0, 64) }); }
export async function removeTag(m: Mark, tag: string) { const ids = m.tagOps[tag]; if (ids?.length) return write({ id: m.id, book: m.book, untag: ids }); return null; }
export const removeMark = (m: Mark) => write({ id: m.id, book: m.book, set: { gone: true } });
export const restoreMark = (m: Mark) => write({ id: m.id, book: m.book, set: { gone: false } });

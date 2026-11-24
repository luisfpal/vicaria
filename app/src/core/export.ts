// Exports of marks: one Markdown file per book (for people and note apps) and one W3C Web Annotation file
// (annotations.jsonld, for other tools). Pure, so it is tested without a browser.
import type { Mark } from "./marks";
import { byPlace } from "./marks";
import { PARSER_VERSION } from "./types";

export interface ExportBook { id: string; title: string; author: string; sha256: string; toc: { title: string; section: number; block: number }[] }
export type Labels = Partial<Record<string, string>>;
const DEFAULT_LABELS: Labels = { yellow: "Highlight", green: "Idea", blue: "Quote", pink: "Question", purple: "Word", orange: "Important" };

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
const quote = (s: string) => "> " + s.replace(/\r\n?/g, "\n").split("\n").join("\n> ");

export function chapterAt(b: ExportBook, section: number, block: number): string {
  let c = "";
  for (const t of b.toc) if (t.section < section || (t.section === section && t.block <= block)) c = t.title; else break;
  return c;
}

export function markdownFor(b: ExportBook, marks: Mark[], labels: Labels = {}): string {
  const L = { ...DEFAULT_LABELS, ...labels };
  const lines = [`# ${b.title}`]; if (b.author) lines.push(`*${b.author}*`); lines.push("");
  const placed = marks.filter(m => !m.gone && m.at).sort(byPlace), unplaced = marks.filter(m => !m.gone && !m.at);
  const bms = placed.filter(m => m.bookmark), loved = placed.filter(m => m.loved);
  if (bms.length) { lines.push("## Bookmarks", ""); for (const m of bms) lines.push(`- ${m.bookmark!.name || m.at!.exact.slice(0, 80) || "Bookmark"}${m.loved ? " (loved)" : ""}`); lines.push(""); }
  if (loved.length) { lines.push("## Places I loved", ""); for (const m of loved) lines.push(`- ${(m.bookmark?.name || m.at!.exact).replace(/\s+/g, " ").slice(0, 120)}`); lines.push(""); }
  let chapter: string | null = null;
  for (const m of placed) {
    if (m.bookmark) continue;
    const c = chapterAt(b, m.at!.section, m.at!.block);
    if (c !== chapter) { if (c) lines.push(`## ${c}`, ""); chapter = c; }
    if (m.at!.exact) lines.push(quote(m.at!.exact), "");
    const meta = [m.color ? L[m.color] || m.color : "", m.style && m.style !== "fill" ? m.style : "", m.sticky ? "sticky note" : "", m.loved ? "loved" : "", ...m.tags.map(t => "#" + t.replace(/\s+/g, "-"))].filter(Boolean);
    if (meta.length) lines.push(`*${meta.join(" · ")}*`, "");
    if (m.card) lines.push(`Chapter card: ${m.card.text}`, "");
    if (m.ask) lines.push(`Question: ${m.ask.q}`, "", `Answer (${m.ask.model}): ${m.ask.a}`, "");
    if (m.note) lines.push(m.note, "");
    for (const v of m.conflicts) lines.push(`Other version of the note: ${v.text}`, "");
  }
  if (unplaced.length) { lines.push("## Not found in this edition", ""); for (const m of unplaced) { if (m.lost?.exact) { lines.push(quote(m.lost.exact), ""); if (m.note) lines.push(m.note, ""); } else lines.push(quote(m.note || "(empty)"), ""); } }
  return lines.join("\n");
}

// https://www.w3.org/TR/annotation-model/ : a TextQuoteSelector, plus a FragmentSelector naming the place in the book
export function webAnnotations(books: ExportBook[], marks: Mark[], labels: Labels = {}) {
  const L = { ...DEFAULT_LABELS, ...labels };
  const byId = new Map(books.map(b => [b.id, b]));
  const items = [];
  for (const m of marks) {
    const b = byId.get(m.book); if (!b || m.gone) continue;
    const body: unknown[] = [];
    if (m.note) body.push({ type: "TextualBody", value: m.note, format: "text/plain", purpose: "commenting" });
    if (m.color) body.push({ type: "TextualBody", value: L[m.color] || m.color, purpose: "tagging" });
    for (const t of m.tags) body.push({ type: "TextualBody", value: t, purpose: "tagging" });
    if (m.style && m.style !== "fill") body.push({ type: "TextualBody", value: m.style, purpose: "tagging" });
    if (m.loved) body.push({ type: "TextualBody", value: "loved", purpose: "tagging" });
    if (m.sticky) body.push({ type: "TextualBody", value: "sticky note", purpose: "tagging" });
    if (m.card) body.push({ type: "TextualBody", value: m.card.text, format: "text/plain", purpose: "describing" });
    if (m.ask) body.push({ type: "TextualBody", value: m.ask.q, format: "text/plain", purpose: "questioning" }, { type: "TextualBody", value: m.ask.a, format: "text/plain", purpose: "replying", generator: m.ask.model });
    if (m.bookmark) body.push({ type: "TextualBody", value: m.bookmark.name || "Bookmark", purpose: "bookmarking" });
    const sel: unknown[] = [];
    const q = m.at ?? m.lost; // a lost mark keeps its words, without a place
    if (q?.exact) sel.push({ type: "TextQuoteSelector", exact: q.exact, prefix: q.prefix, suffix: q.suffix });
    // the place in Vicaria's own text stream: block text of the parsed book, offsets in UTF-16 code units, tied to the
    // parser version. Other tools use the TextQuoteSelector, which is standard.
    if (m.at) sel.push({ type: "FragmentSelector", conformsTo: `urn:vicaria:text-blocks:parser-${PARSER_VERSION}:utf16`, value: `section=${m.at.section}&block=${m.at.block}&offset=${m.at.offset}${m.at.endBlock !== undefined ? `&endBlock=${m.at.endBlock}` : ""}${m.at.endOffset !== undefined ? `&endOffset=${m.at.endOffset}` : ""}` });
    items.push({
      id: `urn:vicaria:mark:${m.id}`, type: "Annotation", motivation: m.bookmark ? "bookmarking" : m.note ? "commenting" : "highlighting",
      created: new Date(m.made).toISOString(), modified: new Date(m.edited).toISOString(),
      ...(body.length ? { body: body.length === 1 ? body[0] : body } : {}),
      target: { source: `urn:sha256:${b.sha256}`, ...(b.title ? { title: b.title } : {}), ...(sel.length ? { selector: sel.length === 1 ? sel[0] : sel } : {}) },
    });
  }
  return { "@context": ["http://www.w3.org/ns/anno.jsonld", "http://www.w3.org/ns/ldp.jsonld"], id: "urn:vicaria:export", type: ["BasicContainer", "AnnotationCollection"], total: items.length, first: { type: "AnnotationPage", items } };
}

export function exportFiles(books: ExportBook[], marks: Mark[], labels: Labels = {}): Record<string, string> {
  const per = new Map<string, Mark[]>();
  for (const m of marks) if (!m.gone) (per.get(m.book) ?? per.set(m.book, []).get(m.book)!).push(m);
  const out: Record<string, string> = {}, used = new Set<string>();
  for (const b of books) {
    const ms = per.get(b.id); if (!ms?.length) continue;
    let name = safeName(b.author ? `${b.title} - ${b.author}` : b.title) || b.id;
    if (used.has(name.toLowerCase())) name = `${name} (${b.id.slice(0, 6)})`;
    used.add(name.toLowerCase());
    out[`${name}.md`] = markdownFor(b, ms, labels);
  }
  out["annotations.jsonld"] = JSON.stringify(webAnnotations(books, marks, labels));
  return out;
}

// The data model. Originals (EPUB bytes) are the source of truth; a BookDoc is derived from them and can be rebuilt
// whenever PARSER_VERSION rises. User data (ops) is small and versioned by SCHEMA_VERSION with explicit migrations.

export const PARSER_VERSION = 3; // 3: an author who also has other roles (Standard Ebooks: aut, ann, ill) is kept; 2: Gutenberg books open at chapter one, boilerplate left out of passages, cleaner author names
export const SCHEMA_VERSION = 1;

export type SectionKind = "cover" | "front" | "body" | "back" | "notes" | "toc";

export interface BookMeta {
  id: string;            // first 16 hex chars of the SHA-256 of the original file
  sha256: string;
  title: string;
  author: string;
  language: string;
  dir: "ltr" | "rtl";
  vertical: boolean;     // vertical writing (Japanese, Chinese)
  cover: string | null;  // image path inside the EPUB
  size: number;
  addedAt: number;
  start: number;         // section to open first (skips cover, title page, front matter)
  startBlock?: number;
  format?: "pdf";        // absent for EPUB   // block inside it (Gutenberg books start mid-section, after the license header)
}

export interface Section {
  idx: number;
  href: string;
  title: string;
  kind: SectionKind;
  linear: boolean;
  html: string;          // sanitized, every block carries data-b="<n>", ids are "s<idx>-<id>"
  blocks: string[];      // plain text per block, indexed by data-b
  fixed?: { w: number; h: number }; // pre-paginated page: html is a full sandboxed page document
}

export interface TocEntry { title: string; section: number; block: number; depth: number }

export interface Note {
  id: string;            // the element id it came from, prefixed: "s<idx>-<id>"
  section: number;
  block: number;
  label: string;         // the number or symbol the reader saw
  html: string;          // sanitized note body, back links removed
  kind: "footnote" | "endnote" | "note";
}

export interface Passage {
  id: string;            // "<section>:<firstBlock>"
  section: number;
  b0: number;
  b1: number;            // inclusive
  chapter: string;       // TOC path, " / " separated
  text: string;
  notes: string[];       // note ids referenced inside the passage
}

export interface DocStats {
  sections: number; blocks: number; words: number;
  noterefs: number; resolved: number; unresolved: string[];
  notes: number; math: number; images: number; links: number;
}

export interface BookDoc {
  v: number;             // PARSER_VERSION that produced it
  meta: BookMeta;
  sections: Section[];
  toc: TocEntry[];
  notes: Record<string, Note>;
  passages: Passage[];
  images: Record<string, string>; // path -> media type, bytes stored separately
  stats: DocStats;
}

// A highlight anchor that survives re-imports: block index plus a text quote (W3C Web Annotation style).
export interface Anchor { section: number; block: number; offset: number; endBlock?: number; endOffset?: number; exact: string; prefix: string; suffix: string }

// One operation in the append-only log. Same shape as the 0.x sync log so paired devices keep merging.
// "b" is the book key under which a 0.x device filed the op (its own book id, like "meditations"); new ops name the
// book inside v.book instead. "alias" links a 0.x book key to a book id; "card" holds a 0.x chapter card; "chapter-card" a 1.0 one ({ book, section, card }). "thought", "lesson" and "wiser" are the saved thoughts, lessons and settings of the Wiser screen (src/wiser/data.ts).
// "c" is the logical part of a hybrid logical clock (Kulkarni et al. 2014), only on kinds 0.x does not know, because
// 0.x drops unknown fields and would pass on a different copy of the op.
export interface Op { id: string; dev: string; t: number; c?: number; k: OpKind; v: Record<string, unknown>; b?: string }
export type OpKind = "pos" | "hl" | "hl-" | "reader" | "listen" | "shelf" | "alias" | "card" | "mark" | "bg" | "session" | "chapter-card" | "thought" | "lesson" | "wiser";
export const LEGACY_KINDS: ReadonlySet<OpKind> = new Set(["pos", "hl", "hl-", "reader", "listen", "shelf"]); // what 0.x accepts

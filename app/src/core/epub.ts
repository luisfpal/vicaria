// EPUB to BookDoc: one intact semantic copy per book. Runs in a worker (no DOM needed) and in Node tests.
import { unzipSync, strFromU8 } from "fflate";
import { parseDocument, DomUtils } from "htmlparser2";
import type { Element, AnyNode, Document } from "domhandler";
import { PARSER_VERSION, type BookDoc, type BookMeta, type Note, type Passage, type Section, type SectionKind, type TocEntry } from "./types";

export class EpubError extends Error {}

type Files = Record<string, Uint8Array>;
const isEl = (n: AnyNode | null | undefined): n is Element => !!n && (n.type === "tag" || n.type === "script" || n.type === "style");
const local = (name: string) => name.replace(/^[\w-]+:/, "").toLowerCase();
const attr = (e: Element, name: string): string | undefined => {
  if (e.attribs[name] != null) return e.attribs[name];
  for (const k in e.attribs) if (local(k) === name && k.includes(":") === name.includes(":")) return e.attribs[k];
  return undefined;
};
const epubType = (e: Element) => (e.attribs["epub:type"] || e.attribs["role"] || "").toLowerCase();
const kids = (e: Element | Document) => e.children;

function resolvePath(base: string, rel: string): string {
  const [path] = rel.split("#");
  if (/^[a-z]+:/i.test(path)) return path;
  const parts = (base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "").concat(decodeURIComponent(path)).split("/");
  const out: string[] = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); }
  return out.join("/");
}

function parseXml(text: string): Document {
  return parseDocument(text, { xmlMode: true, decodeEntities: true });
}
const xml = (files: Files, path: string): Document => {
  const f = files[path];
  if (!f) throw new EpubError(`missing file ${path}`);
  return parseXml(strFromU8(f).replace(/^\uFEFF/, ""));
};
const findAll = (root: AnyNode | AnyNode[], pred: (e: Element) => boolean) => DomUtils.findAll(pred as (e: Element) => boolean, Array.isArray(root) ? root : [root]);
const findOne = (root: AnyNode | AnyNode[], pred: (e: Element) => boolean) => DomUtils.findOne(pred as (e: Element) => boolean, Array.isArray(root) ? root : [root], true);
const text = (n: AnyNode | AnyNode[]) => DomUtils.textContent(n).replace(/\s+/g, " ").trim();

// ---------- sanitizing serializer ----------
const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "dt", "dd", "figcaption", "blockquote", "td", "th", "caption", "hr", "figure", "table", "div", "section", "aside", "header", "footer", "article", "ul", "ol", "dl", "tr", "tbody", "thead", "tfoot", "nav", "body", "hgroup", "math"]);
const LEAF_BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "pre", "dt", "dd", "figcaption", "caption", "td", "th"]);
const KEEP = new Set(["p", "div", "section", "article", "aside", "header", "footer", "hgroup", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "dl", "dt", "dd", "pre", "code", "em", "i", "strong", "b", "u", "s", "sub", "sup", "small", "span", "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col", "br", "hr", "abbr", "cite", "q", "ruby", "rt", "rp", "rb", "bdi", "bdo", "var", "kbd", "samp", "mark", "del", "ins", "wbr", "dfn", "time", "address"]);
const DROP = new Set(["script", "style", "link", "meta", "title", "head", "iframe", "object", "embed", "form", "input", "button", "select", "textarea", "audio", "video", "source", "canvas", "noscript", "template"]);
const MATH_TAGS = new Set(["math", "mi", "mn", "mo", "ms", "mtext", "mspace", "mrow", "mfrac", "msqrt", "mroot", "mstyle", "merror", "mpadded", "mphantom", "menclose", "msub", "msup", "msubsup", "munder", "mover", "munderover", "mmultiscripts", "mprescripts", "none", "mtable", "mtr", "mtd", "mlabeledtr", "semantics", "annotation", "annotation-xml", "maction", "mfenced", "mglyph", "malignmark", "maligngroup", "mlongdiv", "mstack", "msgroup", "msrow", "mscarries", "mscarry", "msline"]);
const KEEP_ATTR = new Set(["lang", "dir", "colspan", "rowspan", "alt", "title", "start", "reversed", "value", "datetime", "abbr", "scope", "span"]);
const PG_START = /\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG/i;
const PG_END = /\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i;
const CHAPTER_ONE = /^\s*(chapter|chap\.|cap[ií]tulo|chapitre|kapitel|capitolo|hoofdstuk|book|libro|livre|buch|part|parte|letter|carta|canto|stave)\s+(1|i|one|first|primero|primera|uno|premier|première|erste[sr]?|primo)\b/i;

// Library catalogs write names as "Dickens, Charles, 1812-1870" or "active 6th century B.C. Sunzi".
export function cleanAuthor(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/\([^)]*\d[^)]*\)/g, " ");                                               // (1812-1870)
  const LIFE = "(active|fl\\.?|floruit|approximately|ca\\.?|circa|born|died)";
  const WHEN = "(\\d+(st|nd|rd|th)\\s+century|\\d{1,4}\\??)(\\s*(B\\.?\\s?C\\.?(E\\.?)?|A\\.?\\s?D\\.?))?";
  s = s.replace(new RegExp(`^${LIFE}\\s+${WHEN}\\s*`, "i"), "");                             // active 6th century B.C. Sunzi
  s = s.replace(new RegExp(`,?\\s*${LIFE}?\\s*${WHEN}?\\s*-\\s*${WHEN}?\\s*$`, "i"), "");        // , 1812-1870
  s = s.replace(new RegExp(`,?\\s*${LIFE}\\s+${WHEN}\\s*$`, "i"), "");                         // , active 6th century B.C.
  const parts = s.split(",").map(x => x.trim()).filter(Boolean);
  if (parts.length === 2 && !/\d/.test(parts[1]) && !/^(jr|sr|ii|iii|iv)\.?$/i.test(parts[1]) && parts[0].split(" ").length <= 2) s = `${parts[1]} ${parts[0]}`;
  return s.replace(/\s+/g, " ").replace(/[,;\s]+$/, "").trim();
}

const ESC = /[&<>]/;
const esc = (s: string) => ESC.test(s) ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : s;
const escA = (s: string) => esc(s).replace(/"/g, "&quot;");

const NOTEREF_TEXT = /^(\[?\(?\s*(\d{1,4}[a-z]?|[ivxlc]{1,6}|[a-z])\s*\)?\]?|[*†‡§¶‖#]{1,3})$/i;
const NOTE_TYPES = /\b(footnote|endnote|rearnote|note|doc-footnote|doc-endnote)\b/;
const BACKLINK = /^(↩|↑|\^|back|return|\[?\d{1,4}\]?\.?)$/i;

interface Ctx {
  files: Files;
  sectionOf: Map<string, number>;              // file path -> section index
  ids: Map<string, { section: number; el: Element }>; // "path#id" -> element
  noteTargets: Map<Element, string>;            // element -> note id (filled while scanning)
  images: Record<string, string>;
  mediaTypes: Map<string, string>;
  stats: BookDoc["stats"];
  backlinks?: Set<Element>;
}

function closestBlock(e: Element): Element {
  let n: Element | null = e;
  while (n && !LEAF_BLOCK.has(local(n.name)) && local(n.name) !== "aside" && !(local(n.name) === "div" && hasDirectText(n))) n = n.parent && isEl(n.parent) ? n.parent : null;
  return n || e;
}
function hasDirectText(e: Element) { return e.children.some(c => c.type === "text" && c.data.trim().length > 0); }
function containsBlock(e: Element): boolean {
  for (const c of e.children) if (isEl(c) && (BLOCK.has(local(c.name)) || containsBlock(c))) return true;
  return false;
}

class SectionWriter {
  out: string[] = [];
  blocks: string[] = [];
  blockOfId = new Map<string, number>();
  noterefs: { noteEl: Element; label: string; block: number; id: string }[] = [];
  math = 0; imgs = 0; links = 0;
  private cur: string[] | null = null; // text of the block being written
  constructor(private ctx: Ctx, private idx: number, private path: string, private hidden: Set<Element>) {}

  write(nodes: AnyNode[], inMath = false) { for (const n of nodes) this.node(n, inMath); }

  private node(n: AnyNode, inMath: boolean) {
    if (n.type === "text") { this.out.push(esc(n.data)); this.cur?.push(n.data); return; }
    if (n.type === "cdata") { this.write(n.children, inMath); return; }
    if (!isEl(n)) return;
    const name = local(n.name);
    if (DROP.has(name)) return;
    if (name === "switch") { // epub:switch: take the MathML case, drop the fallback
      const c = n.children.find(c => isEl(c) && local(c.name) === "case") as Element | undefined;
      const d = n.children.find(c => isEl(c) && local(c.name) === "default") as Element | undefined;
      this.write((c || d)?.children || [], inMath); return;
    }
    if (name === "svg") { // cover pages: keep the image inside an svg wrapper
      const im = findOne(n, e => local(e.name) === "image");
      const href = im && (attr(im, "xlink:href") || attr(im, "href"));
      if (href) this.img(resolvePath(this.path, href), ""); return;
    }
    if (inMath || name === "math") { this.mathEl(n, name); return; }
    if (!KEEP.has(name)) { this.write(n.children, inMath); return; }

    const id = n.attribs.id;
    const isLeaf = this.isBlock(n, name);
    const noteId = this.ctx.noteTargets.get(n);
    const attrs: string[] = [];
    if (id) attrs.push(`id="${escA(`s${this.idx}-${id}`)}"`);
    for (const k in n.attribs) if (KEEP_ATTR.has(local(k)) && !(local(k) === "lang" && k !== "lang" && n.attribs.lang)) attrs.push(`${local(k)}="${escA(n.attribs[k])}"`);
    const et = epubType(n);
    if (et) attrs.push(`data-t="${escA(et.slice(0, 80))}"`);
    if (noteId) attrs.push(`data-note-src="${escA(noteId)}"`);
    if (this.hidden.has(n)) attrs.push(`hidden`);

    if (name === "img") { const src = attr(n, "src"); if (src) this.img(resolvePath(this.path, src), n.attribs.alt || ""); return; }
    if (name === "a") { this.anchor(n, attrs); return; }

    let b = -1;
    if (isLeaf) {
      b = this.blocks.length; this.blocks.push(""); this.cur = [];
      attrs.push(`data-b="${b}"`);
    }
    if (id) this.blockOfId.set(id, isLeaf ? b : this.blocks.length);
    this.out.push(`<${name}${attrs.length ? " " + attrs.join(" ") : ""}>`);
    if (name !== "br" && name !== "hr" && name !== "wbr" && name !== "col") {
      this.write(n.children, inMath);
      this.out.push(`</${name}>`);
    }
    if (isLeaf) { this.blocks[b] = this.cur!.join("").replace(/\s+/g, " ").trim(); this.cur = null; }
  }

  private isBlock(n: Element, name: string) {
    if (this.cur) return false; // already inside a block
    if (LEAF_BLOCK.has(name)) return true;
    if (name === "hr" || name === "figure" || name === "blockquote" || name === "div" || name === "section" || name === "aside") {
      if (name === "hr") return false;
      return !containsBlock(n) && (hasDirectText(n) || n.children.some(c => isEl(c)));
    }
    return false;
  }

  private img(path: string, alt: string) {
    const mt = this.ctx.mediaTypes.get(path) || (/\.png$/i.test(path) ? "image/png" : /\.svg$/i.test(path) ? "image/svg+xml" : /\.gif$/i.test(path) ? "image/gif" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg");
    if (!this.ctx.files[path]) return;
    this.ctx.images[path] = mt; this.imgs++;
    this.out.push(`<img data-src="${escA(path)}" alt="${escA(alt)}" loading="lazy">`);
  }

  private anchor(n: Element, attrs: string[]) {
    const href = attr(n, "href") || attr(n, "xlink:href") || "";
    const label = text(n);
    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      this.links++;
      attrs.push(`href="${escA(href)}"`, `target="_blank"`, `rel="noopener noreferrer"`);
      this.out.push(`<a ${attrs.join(" ")}>`); this.write(n.children); this.out.push("</a>"); return;
    }
    if (href && !/^[a-z]+:/i.test(href)) {
      const path = href.startsWith("#") ? this.path : resolvePath(this.path, href);
      const frag = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
      const target = frag ? this.ctx.ids.get(`${path}#${decodeURIComponent(frag)}`) : undefined;
      const sec = this.ctx.sectionOf.get(path);
      const noteId = target ? this.ctx.noteTargets.get(target.el) || this.ctx.noteTargets.get(closestBlock(target.el)) : undefined;
      const et = epubType(n);
      const looksRef = /noteref/.test(et) || (noteId && NOTEREF_TEXT.test(label));
      if (/backlink/.test(et) || this.ctx.backlinks?.has(n)) return; // back links belong to the note popover, not the text
      if (looksRef && noteId) {
        this.ctx.stats.noterefs++;
        this.noterefs.push({ noteEl: target!.el, label, block: this.blocks.length - (this.cur ? 1 : 0), id: noteId });
        attrs.push(`class="nref"`, `data-note="${escA(noteId)}"`, `href="#${escA(noteId)}"`, `role="doc-noteref"`);
        const keep = this.cur; this.cur = null; // the label is not part of the sentence's text
        this.out.push(`<a ${attrs.join(" ")}>`); this.write(n.children); this.out.push("</a>"); this.cur = keep; return;
      }
      if (/noteref/.test(et)) { this.ctx.stats.noterefs++; this.ctx.stats.unresolved.push(`${this.path}#${frag}`); }
      if (sec != null) {
        this.links++;
        const to = frag ? `s${sec}-${frag}` : `s${sec}`;
        attrs.push(`href="#${escA(to)}"`, `data-sec="${sec}"`);
        if (frag) attrs.push(`data-frag="${escA(frag)}"`);
        this.out.push(`<a ${attrs.join(" ")}>`); this.write(n.children); this.out.push("</a>"); return;
      }
    }
    if (n.attribs.id) { this.out.push(`<span ${attrs.join(" ")}>`); this.write(n.children); this.out.push("</span>"); this.blockOfId.set(n.attribs.id, Math.max(0, this.blocks.length - (this.cur ? 1 : 0))); return; }
    this.write(n.children);
  }

  private mathEl(n: Element, name: string) {
    if (!MATH_TAGS.has(name)) { this.write(n.children, true); return; }
    if (name === "math") this.math++;
    const attrs: string[] = name === "math" ? [`xmlns="http://www.w3.org/1998/Math/MathML"`] : [];
    for (const k in n.attribs) {
      const l = local(k);
      if (l.startsWith("on") || l === "href" || l === "src" || l === "style" || l === "class" || k.startsWith("xmlns") || l === "altimg") continue;
      attrs.push(`${l}="${escA(n.attribs[k])}"`);
    }
    if (name === "math" && n.attribs.alttext) this.cur?.push(` ${n.attribs.alttext} `);
    this.out.push(`<${name}${attrs.length ? " " + attrs.join(" ") : ""}>`);
    for (const c of n.children) {
      if (c.type === "text") { this.out.push(esc(c.data)); if (name !== "annotation" && !(name === "math" && n.attribs.alttext)) this.cur?.push(c.data); }
      else if (isEl(c)) this.mathEl(c, local(c.name));
    }
    this.out.push(`</${name}>`);
  }
}

function sectionKind(body: Element, path: string, landmarks: Map<string, string>, isNav: boolean): SectionKind {
  const types = [epubType(body), ...findAll(body.children, e => ["section", "div", "article"].includes(local(e.name))).slice(0, 2).map(epubType), landmarks.get(path) || ""].join(" ");
  if (isNav || /\btoc\b/.test(types)) return "toc";
  if (/\bcover\b/.test(types)) return "cover";
  if (/\b(endnotes|footnotes|rearnotes)\b/.test(types)) return "notes";
  if (/\b(titlepage|halftitlepage|frontmatter|imprint|copyright-page|dedication|epigraph|foreword|preface|acknowledgments|contributors|seriespage|loi|lot)\b/.test(types)) return "front";
  if (/\b(colophon|backmatter|uncopyright|appendix|glossary|bibliography|index|afterword|licen[cs]e)\b/.test(types)) return "back";
  return "body";
}

export interface ParsedEpub { doc: BookDoc; images: Record<string, Uint8Array>; }

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function parseEpub(bytes: Uint8Array, addedAt = Date.now()): Promise<ParsedEpub> {
  const hash = await sha256(bytes);
  return { ...parseEpubSync(bytes, hash, addedAt) };
}

export function parseEpubSync(bytes: Uint8Array, hash: string, addedAt: number): ParsedEpub {
  let files: Files;
  try { files = unzipSync(bytes); } catch (e) { throw new EpubError("This file is not a readable EPUB (the zip archive is damaged)."); }
  for (const k of Object.keys(files)) if (k.startsWith("/")) { files[k.slice(1)] = files[k]; delete files[k]; }
  if (Object.keys(files).some(k => /^META-INF\/(encryption|rights)\.xml$/.test(k)) && isDrm(files)) throw new EpubError("This book is locked with DRM, so it cannot be opened here.");
  const container = files["META-INF/container.xml"] ? xml(files, "META-INF/container.xml") : null;
  const rootfile = container && findOne(container.children, e => local(e.name) === "rootfile");
  const opfPath = (rootfile && attr(rootfile, "full-path")) || Object.keys(files).find(k => k.endsWith(".opf"));
  if (!opfPath) throw new EpubError("This file is not an EPUB (no package document).");
  const opf = xml(files, opfPath);
  const pkg = findOne(opf.children, e => local(e.name) === "package");
  const md = findOne(opf.children, e => local(e.name) === "metadata");
  const dc = (n: string) => md ? findAll(md.children, e => local(e.name) === n && e.name.toLowerCase().includes("dc:") || local(e.name) === n && !e.name.includes(":")).map(e => text(e)).filter(Boolean) : [];
  const metaTags = md ? findAll(md.children, e => local(e.name) === "meta") : [];
  const manifest = new Map<string, { href: string; type: string; props: string }>();
  const mediaTypes = new Map<string, string>();
  for (const it of findAll(opf.children, e => local(e.name) === "item")) {
    const href = resolvePath(opfPath, attr(it, "href") || "");
    manifest.set(it.attribs.id, { href, type: it.attribs["media-type"] || "", props: it.attribs.properties || "" });
    mediaTypes.set(href, it.attribs["media-type"] || "");
  }
  const spineEl = findOne(opf.children, e => local(e.name) === "spine");
  if (!spineEl) throw new EpubError("This EPUB has no reading order (spine).");
  const spine = findAll(spineEl.children, e => local(e.name) === "itemref")
    .map(e => ({ item: manifest.get(e.attribs.idref), linear: e.attribs.linear !== "no" }))
    .filter(x => x.item && files[x.item.href] && /x?html|xml/.test(x.item.type || "xhtml"));
  if (!spine.length) throw new EpubError("This EPUB has no readable chapters.");
  const navItem = [...manifest.values()].find(i => /\bnav\b/.test(i.props));
  const ncxItem = manifest.get(spineEl.attribs.toc || "") || [...manifest.values()].find(i => i.type === "application/x-dtbncx+xml");

  // cover
  let cover: string | null = [...manifest.values()].find(i => /\bcover-image\b/.test(i.props))?.href || null;
  if (!cover) { const m = metaTags.find(m => m.attribs.name === "cover"); const it = m && manifest.get(m.attribs.content); if (it && /^image\//.test(it.type)) cover = it.href; }
  if (cover && !files[cover]) cover = null;

  const sectionOf = new Map<string, number>();
  spine.forEach((s, i) => sectionOf.set(s.item!.href, i));
  const doms = spine.map(s => { try { return xml(files, s.item!.href); } catch { return parseXml("<html><body></body></html>"); } });

  // landmarks (EPUB 3 nav) and guide (EPUB 2) give section kinds
  const landmarks = new Map<string, string>();
  let navDom: Document | null = null;
  if (navItem && files[navItem.href]) {
    navDom = xml(files, navItem.href);
    const lm = findOne(navDom.children, e => local(e.name) === "nav" && /landmarks/.test(epubType(e)));
    if (lm) for (const a of findAll(lm.children, e => local(e.name) === "a")) landmarks.set(resolvePath(navItem.href, attr(a, "href") || ""), epubType(a));
  }
  for (const r of findAll(opf.children, e => local(e.name) === "reference")) landmarks.set(resolvePath(opfPath, attr(r, "href") || ""), (r.attribs.type || "").toLowerCase().replace("text", "bodymatter"));

  const stats: BookDoc["stats"] = { sections: spine.length, blocks: 0, words: 0, noterefs: 0, resolved: 0, unresolved: [], notes: 0, math: 0, images: 0, links: 0 };
  const ctx: Ctx = { files, sectionOf, ids: new Map(), noteTargets: new Map(), images: {}, mediaTypes, stats };
  // one walk per document: ids, document order, explicit notes and candidate links (big books have 100k+ elements)
  const order = new Map<Element, number>();
  let seq = 0;
  const all: { els: Element[]; notes: Element[]; links: Element[] }[] = doms.map(d => {
    const els = findAll(d.children, () => true), notes: Element[] = [], links: Element[] = [];
    for (const e of els) {
      if (e.attribs.id) {
        const et = epubType(e);
        if (et && NOTE_TYPES.test(et) && !/noteref/.test(et)) notes.push(e);
      }
      if (local(e.name) === "a") { links.push(e); order.set(e, seq++); } // order is only compared between links
    }
    return { els, notes, links };
  });
  doms.forEach((d, i) => { for (const e of all[i].els) if (e.attribs.id) ctx.ids.set(`${spine[i].item!.href}#${e.attribs.id}`, { section: i, el: e }); });

  // note targets: explicit epub:type notes, then targets of links that look like note references
  const hidden = new Set<Element>();
  const noteKind = (e: Element): Note["kind"] => /endnote|rearnote/.test(epubType(e)) ? "endnote" : /footnote/.test(epubType(e)) ? "footnote" : "note";
  doms.forEach((d, i) => {
    for (const e of all[i].notes) {
      ctx.noteTargets.set(e, `s${i}-${e.attribs.id}`);
      if (local(e.name) === "aside" && /footnote/.test(epubType(e)) && sectionKind(findOne(d.children, x => local(x.name) === "body") || (d as unknown as Element), spine[i].item!.href, landmarks, false) !== "notes") hidden.add(e);
    }
  });
  // heuristic note references (EPUB 2, Gutenberg): collect candidates first, then drop back links, which are the
  // later link of a pair that point at each other
  const cands: { a: Element; t: { section: number; el: Element } }[] = [];
  doms.forEach((d, i) => {
    for (const a of all[i].links) {
      const href = attr(a, "href") || "";
      if (!href.includes("#") || /^[a-z]+:/i.test(href)) continue;
      const lbl = text(a);
      const et = epubType(a);
      if (/backlink/.test(et)) continue;
      const inSup = (a.parent && isEl(a.parent) && ["sup", "small"].includes(local(a.parent.name))) || a.children.some(c => isEl(c) && local(c.name) === "sup");
      const cls = (a.attribs.class || "") + " " + (a.attribs.id || "");
      if (!/noteref/.test(et) && !(NOTEREF_TEXT.test(lbl) && (inSup || /^\[.*\]$/.test(lbl) || /note|fn|ftn/i.test(cls)))) continue;
      const path = href.startsWith("#") ? spine[i].item!.href : resolvePath(spine[i].item!.href, href);
      const t = ctx.ids.get(`${path}#${decodeURIComponent(href.slice(href.indexOf("#") + 1))}`);
      if (t) cands.push({ a, t });
    }
  });
  const candLinks = new Set(cands.map(c => c.a));
  const refBlocks = new Set<Element>();
  for (const { a, t } of cands) {
    const tgtLink = candLinks.has(t.el) ? t.el : null;
    if (tgtLink && (order.get(tgtLink) ?? 0) < (order.get(a) ?? 0) && !/noteref/.test(epubType(a))) continue; // back link
    const host = ctx.noteTargets.has(t.el) ? t.el : closestBlock(t.el);
    if (!ctx.noteTargets.has(host)) ctx.noteTargets.set(host, `s${t.section}-${host.attribs.id || t.el.attribs.id}`);
    if (host !== t.el) ctx.noteTargets.set(t.el, ctx.noteTargets.get(host)!);
    refBlocks.add(closestBlock(a));
  }
  const backlinks = new Set(cands.filter(({ a, t }) => candLinks.has(t.el) && (order.get(t.el) ?? 0) < (order.get(a) ?? 0) && !/noteref/.test(epubType(a))).map(c => c.a));
  ctx.backlinks = backlinks;

  // write sections
  const sections: Section[] = [];
  const writers: SectionWriter[] = [];
  const globalFixed = metaTags.some(m => m.attribs.property === "rendition:layout" && text(m) === "pre-paginated");
  const spineRefs = findAll(spineEl.children, e => local(e.name) === "itemref").filter(e => { const it = manifest.get(e.attribs.idref); return it && files[it.href] && /x?html|xml/.test(it.type || "xhtml"); });
  doms.forEach((d, i) => {
    const path = spine[i].item!.href;
    const props = spineRefs[i]?.attribs.properties || "";
    if ((globalFixed && !/layout-reflowable/.test(props)) || /layout-pre-paginated/.test(props)) {
      const fx = fixedPage(files, path, mediaTypes, ctx.images);
      writers.push(new SectionWriter(ctx, i, path, hidden));
      sections.push({ idx: i, href: path, title: "", kind: "body", linear: spine[i].linear, html: fx.html, blocks: fx.text ? [fx.text] : [], fixed: { w: fx.w, h: fx.h } });
      stats.blocks += fx.text ? 1 : 0; stats.images += fx.imgs;
      return;
    }
    const body = findOne(d.children, e => local(e.name) === "body");
    const w = new SectionWriter(ctx, i, path, hidden);
    w.write(body ? body.children : d.children);
    writers.push(w);
    const isNav = navItem?.href === path;
    const kind = body ? sectionKind(body, path, landmarks, isNav) : "body";
    const h = body && findOne(body.children, e => /^h[1-6]$/.test(local(e.name)));
    const htmlEl = findOne(d.children, e => local(e.name) === "html");
    const secLang = htmlEl && (htmlEl.attribs["xml:lang"] || htmlEl.attribs.lang);
    const secDir = htmlEl && htmlEl.attribs.dir;
    let html = w.out.join("");
    if (secLang || secDir) html = `<div${secLang ? ` lang="${escA(secLang)}"` : ""}${secDir ? ` dir="${escA(secDir)}"` : ""}>${html}</div>`;
    sections.push({ idx: i, href: path, title: h ? text(h).slice(0, 120) : "", kind, linear: spine[i].linear, html, blocks: w.blocks });
    stats.blocks += w.blocks.length; stats.math += w.math; stats.images += w.imgs; stats.links += w.links;
  });

  // notes: body of each target, back links removed
  const notes: Record<string, Note> = {};
  const targetsById = new Map<string, { el: Element; section: number }>();
  for (const [el, id] of ctx.noteTargets) {
    const cur = targetsById.get(id);
    if (!cur || (local(cur.el.name) === "a" && local(el.name) !== "a") || (local(el.name) !== "a" && text(el).length > text(cur.el).length)) targetsById.set(id, { el, section: sectionIdxOf(ctx, el) });
  }
  const labels = new Map<string, string>();
  writers.forEach(w => w.noterefs.forEach(r => { if (!labels.has(r.id)) labels.set(r.id, r.label); }));
  for (const [id, { el, section }] of targetsById) {
    if (!labels.has(id) && !NOTE_TYPES.test(epubType(el))) continue;
    const nw = new SectionWriter({ ...ctx, noteTargets: new Map() }, section, spine[section].item!.href, new Set());
    BACKSET = ctx.backlinks || new Set();
    const body = stripBacklinks(el);
    if (!body.length) continue;
    nw.write(body);
    const html = nw.out.join("").replace(/^\s*(<p[^>]*>)\s*/, "$1");
    const w = writers[section];
    notes[id] = { id, section, block: w.blockOfId.get(el.attribs.id) ?? 0, label: labels.get(id) || "", html, kind: noteKind(el) };
  }
  stats.notes = Object.keys(notes).length;
  stats.resolved = writers.reduce((n, w) => n + w.noterefs.filter(r => notes[r.id]).length, 0);
  for (const w of writers) for (const r of w.noterefs) if (!notes[r.id]) stats.unresolved.push(r.id);

  // toc
  let toc: TocEntry[] = [];
  const blockFor = (path: string, frag: string) => {
    const s = sectionOf.get(path); if (s == null) return null;
    return { section: s, block: frag ? (writers[s].blockOfId.get(decodeURIComponent(frag)) ?? 0) : 0 };
  };
  if (navDom && navItem) {
    const nav = findOne(navDom.children, e => local(e.name) === "nav" && /\btoc\b/.test(epubType(e))) || findOne(navDom.children, e => local(e.name) === "nav");
    const walk = (ol: Element, depth: number) => {
      for (const li of ol.children.filter(c => isEl(c) && local((c as Element).name) === "li") as Element[]) {
        const a = li.children.find(c => isEl(c) && ["a", "span"].includes(local((c as Element).name))) as Element | undefined;
        const href = a && attr(a, "href");
        if (a && href) {
          const p = resolvePath(navItem.href, href); const frag = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
          const at = blockFor(p, frag); if (at) toc.push({ title: text(a), depth, ...at });
        }
        const sub = li.children.find(c => isEl(c) && local((c as Element).name) === "ol") as Element | undefined;
        if (sub) walk(sub, depth + 1);
      }
    };
    const ol = nav && findOne(nav.children, e => local(e.name) === "ol");
    if (ol) walk(ol, 0);
  }
  if (!toc.length && ncxItem && files[ncxItem.href]) {
    const ncx = xml(files, ncxItem.href);
    const walk = (parent: Element | Document, depth: number) => {
      for (const np of kids(parent).filter(c => isEl(c) && local((c as Element).name) === "navpoint") as Element[]) {
        const lbl = findOne(np.children, e => local(e.name) === "navlabel");
        const content = np.children.find(c => isEl(c) && local((c as Element).name) === "content") as Element | undefined;
        const src = content?.attribs.src;
        if (src) { const p = resolvePath(ncxItem.href, src); const frag = src.includes("#") ? src.slice(src.indexOf("#") + 1) : ""; const at = blockFor(p, frag); if (at) toc.push({ title: lbl ? text(lbl) : "", depth, ...at }); }
        walk(np, depth + 1);
      }
    };
    const map = findOne(ncx.children, e => local(e.name) === "navmap");
    if (map) walk(map, 0);
  }
  if (!toc.length) toc = sections.filter(s => s.title && s.kind !== "toc").map(s => ({ title: s.title, section: s.idx, block: 0, depth: 0 }));
  toc = toc.filter(t => t.title);

  // Project Gutenberg wraps every book in a license header and footer. They stay in the text (it is their book),
  // but the book opens at chapter one and the boilerplate is left out of search and AI passages.
  const skip = new Map<number, number>(); // section -> blocks before this index are boilerplate
  let pgStart: { section: number; block: number } | null = null;
  for (const s of sections) {
    const hb = s.blocks.findIndex(b => PG_START.test(b));
    if (hb >= 0 && !pgStart) { pgStart = { section: s.idx, block: hb + 1 }; skip.set(s.idx, hb + 1); }
    const fb = s.blocks.findIndex(b => PG_END.test(b));
    if (fb >= 0 && pgStart) { if (fb <= 1) { skip.set(s.idx, s.blocks.length); s.kind = "back"; } else skip.set(-s.idx - 1, fb); }
  }
  if (pgStart) {
    const s0 = sections[pgStart.section];
    if (s0.kind === "body" && s0.blocks.slice(pgStart.block).join(" ").length < 1500) s0.kind = "front";
  }

  // start: the first body section with real text, after cover, title page and front matter
  const bm = [...landmarks.entries()].find(([, t]) => /bodymatter/.test(t));
  let start = bm ? (sectionOf.get(bm[0]) ?? -1) : -1;
  let startBlock = 0;
  if (pgStart) {
    const after = toc.filter(t => t.section > pgStart!.section || (t.section === pgStart!.section && t.block >= pgStart!.block));
    const one = after.find(t => CHAPTER_ONE.test(t.title)) || after.find(t => t.section > pgStart!.section);
    if (one) { start = one.section; startBlock = one.block; } else { start = pgStart.section; startBlock = pgStart.block; }
  }
  if (start < 0 || sections[start]?.kind !== "body" && !pgStart) { start = sections.findIndex(s => s.kind === "body" && s.linear && s.blocks.join(" ").length > 200); startBlock = 0; }
  if (start < 0 || globalFixed) { start = 0; startBlock = 0; }

  const passages = buildPassages(sections, toc, writers, skip);
  for (const s of sections) for (const b of s.blocks) stats.words += b ? b.split(" ").length : 0;

  const title = dc("title")[0] || spine[0].item!.href.replace(/.*\//, "").replace(/\.x?html?$/, "") || "Untitled";
  const creators = md ? findAll(md.children, e => local(e.name) === "creator") : [];
  const authors = creators.filter(c => !c.attribs.id || (roles => !roles.length || roles.includes("aut"))(metaTags.filter(m => m.attribs.refines === `#${c.attribs.id}` && m.attribs.property === "role").map(text))).map(c => cleanAuthor(text(c))).filter(Boolean);
  const language = (dc("language")[0] || "en").toLowerCase();
  const rtl = (spineEl.attribs["page-progression-direction"] === "rtl" && !/^(ja|zh|ko)/.test(language)) || /^(ar|he|fa|ur|yi|ps|sd|ug)\b/.test(language);
  const css = Object.keys(files).filter(k => k.endsWith(".css")).map(k => strFromU8(files[k])).join("\n");
  const vertical = /writing-mode\s*:\s*vertical-(rl|lr)/i.test(css) && /^(ja|zh|ko)/.test(language);

  const meta: BookMeta = {
    id: hash.slice(0, 16), sha256: hash, title: title.slice(0, 300), author: (authors[0] ? authors.join(", ") : "").slice(0, 300),
    language, dir: rtl ? "rtl" : "ltr", vertical, cover, size: bytes.length, addedAt, start, ...(startBlock ? { startBlock } : {}),
  };
  const images: Record<string, Uint8Array> = {};
  for (const p of Object.keys(ctx.images)) images[p] = files[p];
  if (cover && !images[cover]) { images[cover] = files[cover]; ctx.images[cover] = mediaTypes.get(cover) || "image/jpeg"; }
  void pkg;
  return { doc: { v: PARSER_VERSION, meta, sections, toc, notes, passages, images: ctx.images, stats }, images };
}

// Fixed-layout page: the page's own markup, scripts and handlers removed, CSS inlined, resources listed so the
// reader can swap in local URLs. It is shown in a sandboxed frame with scripts disabled.
function fixedPage(files: Files, path: string, mediaTypes: Map<string, string>, images: Record<string, string>) {
  let src = strFromU8(files[path]).replace(/^\uFEFF/, "");
  const vp = src.match(/<meta[^>]+name="viewport"[^>]+content="([^"]+)"/i)?.[1] || "";
  const w = +(vp.match(/width\s*=\s*(\d+)/)?.[1] || 0) || 1000, h = +(vp.match(/height\s*=\s*(\d+)/)?.[1] || 0) || 1400;
  src = src.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "").replace(/javascript:/gi, "");
  let imgs = 0;
  const res = (rel: string, base = path) => { const p = resolvePath(base, rel); if (files[p]) { images[p] = mediaTypes.get(p) || "application/octet-stream"; imgs++; return `vic-res:${p}`; } return rel; };
  src = src.replace(/<link[^>]+href="([^"]+\.css)"[^>]*>/gi, (_m, href) => {
    const p = resolvePath(path, href); if (!files[p]) return "";
    const css = strFromU8(files[p]).replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (_u, u) => /^data:/.test(u) ? `url(${u})` : `url("${res(u, p)}")`);
    return `<style>${css.replace(/<\/style/gi, "")}</style>`;
  });
  src = src.replace(/\b(src|xlink:href)\s*=\s*"([^"#][^"]*)"/gi, (_m, a, u) => /^(data:|https?:)/.test(u) ? `${a}="${u}"` : `${a}="${res(u)}"`);
  const textOnly = DomUtils.textContent(parseXml(src.replace(/<style[\s\S]*?<\/style>/gi, ""))).replace(/\s+/g, " ").trim();
  return { html: src.replace(/^<\?xml[^>]*>\s*/, ""), w, h, text: textOnly, imgs };
}

function sectionIdxOf(ctx: Ctx, el: Element): number {
  for (const [, v] of ctx.ids) if (v.el === el) return v.section;
  let n: AnyNode | null = el;
  while (n && n.parent) n = n.parent;
  for (const [, v] of ctx.ids) { let m: AnyNode | null = v.el; while (m && m.parent) m = m.parent; if (m === n) return v.section; }
  return 0;
}

let BACKSET: Set<Element> = new Set();
function stripBacklinks(el: Element): AnyNode[] {
  const clone = (n: AnyNode): AnyNode | null => {
    if (isEl(n)) {
      if (local(n.name) === "a" && (/backlink/.test(epubType(n)) || BACKSET.has(n) || (BACKLINK.test(text(n)) && (attr(n, "href") || "").includes("#") && n === firstOrLastLink(el, n)))) return null;
      const c = { ...n, children: [] as AnyNode[] } as Element;
      Object.setPrototypeOf(c, Object.getPrototypeOf(n));
      c.children = n.children.map(clone).filter(Boolean) as AnyNode[];
      return c;
    }
    return n;
  };
  const isAside = ["aside", "li", "div", "section", "p"].includes(local(el.name));
  const root = clone(el) as Element | null;
  if (!root) return [];
  return isAside && local(el.name) !== "p" ? root.children : [root];
}
function firstOrLastLink(root: Element, a: Element) {
  const links = findAll(root.children, e => local(e.name) === "a" && !!attr(e, "href"));
  return links[0] === a || links[links.length - 1] === a ? a : null;
}

function isDrm(files: Files): boolean {
  const enc = files["META-INF/encryption.xml"];
  if (!enc) return !!files["META-INF/rights.xml"];
  const s = strFromU8(enc);
  // font obfuscation (IDPF and Adobe) is not DRM; anything else is
  const algs = [...s.matchAll(/Algorithm="([^"]+)"/g)].map(m => m[1]);
  return algs.some(a => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(a));
}

// Passages for AI and search: about 150 to 400 words, inside one section, broken at headings.
export function buildPassages(sections: Section[], toc: TocEntry[], writers: { noterefs: { block: number; id: string }[] }[] = [], skip = new Map<number, number>()): Passage[] {
  const out: Passage[] = [];
  const tocAt = (s: number, b: number) => {
    const path: string[] = [];
    for (const t of toc) { if (t.section < s || (t.section === s && t.block <= b)) { path.length = t.depth; path[t.depth] = t.title; } }
    return path.filter(Boolean).join(" / ");
  };
  for (const s of sections) {
    if (s.kind === "toc" || s.kind === "cover" || s.kind === "front") continue;
    const refs = writers[s.idx]?.noterefs ?? [];
    let b0 = -1, words = 0, buf: string[] = [];
    const flush = (b1: number) => {
      if (b0 < 0 || !buf.join("").trim()) { b0 = -1; buf = []; words = 0; return; }
      const notes = [...new Set(refs.filter(r => r.block >= b0 && r.block <= b1).map(r => r.id))];
      out.push({ id: `${s.idx}:${b0}`, section: s.idx, b0, b1, chapter: tocAt(s.idx, b0), text: buf.join("\n"), notes });
      b0 = -1; buf = []; words = 0;
    };
    const from = skip.get(s.idx) ?? 0, until = skip.get(-s.idx - 1) ?? s.blocks.length; // license header and footer
    s.blocks.forEach((t, b) => {
      if (b < from || b >= until) return;
      const w = t ? t.split(" ").length : 0;
      if (b0 >= 0 && (words + w > 400 && words >= 150)) flush(b - 1);
      if (!t) return;
      if (b0 < 0) b0 = b;
      buf.push(t); words += w;
    });
    flush(s.blocks.length - 1);
  }
  return out;
}

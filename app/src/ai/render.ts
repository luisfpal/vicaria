// Answers are Markdown with math ($...$, $$...$$, \(...\), \[...\]), Mermaid diagrams (```mermaid) and citations
// ([12.4], ids of passages that were sent). Rendering is safe for text from a model: raw HTML is shown as text, links
// only open http(s) pages in a new tab, and images are never loaded (a model could put the reader's data in an image
// address). KaTeX and Mermaid are passed in only once loaded, so a plain answer costs neither.
import { Marked, type Tokens } from "marked";

type Slot = { k: "math"; tex: string; display: boolean } | { k: "cite"; ids: string[] };
export interface KatexLike { renderToString(tex: string, o: { displayMode: boolean; throwOnError: boolean; output?: "html" | "htmlAndMathml" | "mathml" }): string }
export interface RenderOpts { sent?: Set<string>; katex?: KatexLike | null; label?: (id: string) => string }

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const OPEN = "\uE000", CLOSE = "\uE001"; // private-use characters: never in a model's answer, kept as they are by marked
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=[^\s$\d])((?:\\\$|[^$\n])+?)(?<=[^\s\\])\$(?!\d)/g;
const CITE = /\[(\d+\.\d+(?:\s*[,;]\s*\d+\.\d+)*)\]/g;

// math and citations become slots, outside code (fenced blocks and inline code are left exactly as written)
function protect(md: string, sent: Set<string> | undefined, slots: Slot[]): string {
  const parts = md.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return parts.map((p, i) => {
    if (i % 2) return p;
    p = p.replace(MATH, (_m, a, b, c, d) => { slots.push({ k: "math", tex: (a ?? b ?? c ?? d).trim(), display: a !== undefined || b !== undefined }); return OPEN + (slots.length - 1) + CLOSE; });
    return p.replace(CITE, (_m, list: string) => {
      const ids = list.split(/\s*[,;]\s*/).filter(id => !sent || sent.has(id));
      if (!ids.length) return "";
      slots.push({ k: "cite", ids }); return OPEN + (slots.length - 1) + CLOSE;
    });
  }).join("");
}

const md = new Marked({ gfm: true, breaks: false, async: false });
md.use({
  renderer: {
    html(t: Tokens.HTML | Tokens.Tag) { return esc(t.text); },
    image(t: Tokens.Image) { return esc(t.text || ""); },
    link(t: Tokens.Link) {
      const inner = this.parser.parseInline(t.tokens);
      return /^https?:\/\//i.test(t.href) ? `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>` : inner;
    },
    code(t: Tokens.Code) {
      const lang = (t.lang || "").trim().split(/\s/)[0].toLowerCase();
      if (lang === "mermaid") return `<div class="mermaid-src"><pre><code>${esc(t.text)}</code></pre></div>`;
      return `<pre><code${lang ? ` class="lang-${esc(lang)}"` : ""}>${esc(t.text)}</code></pre>`;
    },
  },
});

export const hasMath = (s: string) => { const slots: Slot[] = []; protect(s, undefined, slots); return slots.some(x => x.k === "math"); };
export const hasMermaid = (s: string) => /```\s*mermaid/i.test(s);

export function renderAnswer(text: string, o: RenderOpts = {}): string {
  const slots: Slot[] = [];
  const html = md.parse(protect(text, o.sent, slots)) as string;
  return html.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_m, n) => {
    const s = slots[+n]; if (!s) return "";
    if (s.k === "cite") return s.ids.map(id => `<button type="button" class="cite" data-cite="${esc(id)}">${esc(o.label?.(id) ?? id)}</button>`).join("");
    if (!o.katex) return `<code class="tex">${esc(s.tex)}</code>`;
    try { return o.katex.renderToString(s.tex, { displayMode: s.display, throwOnError: false, output: "htmlAndMathml" }); }
    catch { return `<code class="tex">${esc(s.tex)}</code>`; }
  });
}

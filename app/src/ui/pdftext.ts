// A PDF section as plain text that reflows: the same blocks (so marks, places and searches are the same), each a
// paragraph, a heading where its type is clearly larger than the page's body text, and a quiet page number between pages.
export function pdfTextHtml(html: string): string {
  const out: string[] = [];
  const pages = html.split(/(?=<div class="pdfpage")/).filter(Boolean);
  for (const pg of pages) {
    const n = +(pg.match(/data-page="(\d+)"/)?.[1] ?? 0);
    const blocks = [...pg.matchAll(/<p class="pl" data-b="(\d+)"[^>]*>(.*?)<\/p>/g)].map(m => {
      const size = +(m[2].match(/font-size:([\d.]+)cqw/)?.[1] ?? 0);
      const text = m[2].replace(/<span[^>]*>/g, "").replace(/<\/span>/g, "");
      return { b: m[1], size, text };
    });
    const sizes = blocks.filter(x => x.text.length > 80).map(x => x.size).sort((a, b) => a - b);
    const body = sizes[sizes.length >> 1] || 0;
    out.push(`<div class="pdfno" aria-hidden="true">${n + 1}</div>`);
    for (const x of blocks) {
      const tag = body && x.size > body * 1.6 ? "h2" : body && x.size > body * 1.2 && x.text.length < 120 ? "h3" : "p";
      out.push(`<${tag} data-b="${x.b}">${x.text}</${tag}>`);
    }
  }
  if (!/data-b="\d+">[^<]/.test(out.join(""))) out.unshift('<p class="muted pdfnone">These pages are pictures, with no text to show here. Choose "Pages as printed" in Text settings to see them.</p>');
  return out.join("");
}

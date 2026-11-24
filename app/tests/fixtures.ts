// Small synthetic EPUBs for cases the corpus does not cover.
import { zipSync, strToU8 } from "fflate";

export function makeEpub(chapters: Record<string, string>, opts: { title?: string; lang?: string; extra?: Record<string, string>; ncx?: boolean } = {}): Uint8Array {
  const names = Object.keys(chapters);
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${opts.title || "Fixture"}</dc:title><dc:creator>Test Author</dc:creator><dc:language>${opts.lang || "en"}</dc:language></metadata><manifest>${names.map((n, i) => `<item id="c${i}" href="${n}" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${names.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`;
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OEBPS/content.opf": strToU8(opf),
  };
  for (const n of names) files[`OEBPS/${n}`] = strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML"><head><title>x</title></head><body>${chapters[n]}</body></html>`);
  for (const [k, v] of Object.entries(opts.extra || {})) files[k] = strToU8(v);
  return zipSync(files as never);
}

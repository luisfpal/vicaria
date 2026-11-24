// Makes the small PDFs the tests read: a text PDF with chapters, an outline, a two-column page and a picture,
// and a scanned PDF (pictures of pages, no text). Run: node scripts/make-pdfs.mjs
import { chromium } from "playwright";
const out = new URL("../tests/fixtures/", import.meta.url).pathname;
const para = (n, w) => Array.from({ length: n }, (_, i) => `<p>${w} ${i + 1}. The steward of a small estate keeps a ledger of every promise made to him, and he reads it each evening by a candle so that nothing owed is forgotten and nothing forgiven is counted twice.</p>`).join("");
const b = await chromium.launch();
const p = await b.newPage();
await p.setContent(`<!doctype html><html lang="en"><head><title>The Steward's Ledger</title><style>
body{font:12pt Georgia,serif;margin:0} h1{font-size:22pt;break-before:page;margin-top:0} h1:first-of-type{break-before:auto}
.cols{column-count:2;column-gap:24pt} figure{margin:12pt 0} figure div{width:200pt;height:120pt;background:linear-gradient(135deg,#246,#8ac)}
</style></head><body>
<h1>Chapter One: The Ledger</h1>${para(9, "First chapter, paragraph")}
<h2>A short section</h2><p>Energy and mass are related by E = mc², which the steward copied into the margin.</p>${para(4, "Section, paragraph")}
<h1>Chapter Two: Two Columns</h1><div class="cols">${para(8, "Column text, paragraph")}</div>
<figure><div></div><figcaption>A drawing of the estate at dusk.</figcaption></figure>
<h1>Chapter Three: The Reckoning</h1>${para(6, "Third chapter, paragraph")}<p>The last line of the book reads: settle every account before the frost.</p>
</body></html>`);
await p.pdf({ path: out + "ledger.pdf", format: "A5", margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" }, outline: true, tagged: true });
// a scan: two pages that are only pictures
const shot = async t => { await p.setContent(`<div style="width:600px;padding:40px;font:20px Georgia;background:#fbf8f0">${t}</div>`); return (await p.locator("div").screenshot()).toString("base64"); };
const imgs = [await shot("A page that was scanned. " + "Words in a picture are not text. ".repeat(12)), await shot("The second scanned page.")];
await p.setContent(`<html><head><title>Scanned Notes</title></head><body style="margin:0">${imgs.map(i => `<img src="data:image/png;base64,${i}" style="width:100%;break-after:page;display:block">`).join("")}</body></html>`);
await p.pdf({ path: out + "scan.pdf", format: "A5", printBackground: true });
// right to left: Hebrew paragraphs with an outline
const he = "השומר של אחוזה קטנה רושם בפנקס כל הבטחה שניתנה לו, וקורא בו בכל ערב לאור נר כדי ששום חוב לא יישכח.";
await p.setContent(`<!doctype html><html lang="he" dir="rtl"><head><title>הפנקס</title><style>body{font:13pt Heebo,sans-serif;margin:0} h1{font-size:22pt}</style></head><body><h1>פרק ראשון</h1>${Array.from({ length: 6 }, (_, i) => `<p>פסקה ${i + 1}. ${he}</p>`).join("")}</body></html>`);
await p.pdf({ path: out + "hebrew.pdf", format: "A5", margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" }, outline: true, tagged: true });
await b.close();
console.log("made ledger.pdf, scan.pdf and hebrew.pdf");

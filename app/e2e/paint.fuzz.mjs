// Fuzz test of drawing marks, in real Chromium: random paragraphs with nested inline elements and random overlapping
// marks. After painting, the text is unchanged, every mark covers exactly its quote, nothing valid is missed, and the
// result does not depend on the order the marks arrive in.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const out = mkdtempSync(tmpdir() + "/paint-") + "/paint.js";
execSync(`npx rolldown src/ui/paint.ts --format iife --name VicPaint --file ${out}`, { stdio: "pipe" });
const b = await chromium.launch(); const p = await b.newPage();
await p.setContent("<div id=root></div>"); await p.addScriptTag({ content: readFileSync(out, "utf8") });
const res = await p.evaluate(({ cases }) => {
  let seed = 12345; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = "the quick brown fox jumps over a lazy dog while seneca writes letters about time and stoic calm".split(" ");
  const fail = [];
  for (let c = 0; c < cases; c++) {
    const nb = 1 + rnd(4); let html = "";
    for (let i = 1; i <= nb; i++) {
      let s = ""; const nw = 3 + rnd(25);
      for (let w = 0; w < nw; w++) { const word = words[rnd(words.length)]; const r = rnd(10); s += (r === 0 ? `<em>${word}</em>` : r === 1 ? `<a class="nref">${rnd(9)}</a>` : r === 2 ? `<span><b>${word}</b> x</span>` : word) + (rnd(6) ? " " : ""); }
      html += `<p data-b="${i}">${s}</p>`;
    }
    const root = document.getElementById("root"); root.innerHTML = html;
    const texts = [...root.querySelectorAll("[data-b]")].map(e => e.textContent);
    const marks = []; const nm = rnd(12);
    for (let k = 0; k < nm; k++) {
      const bi = rnd(nb), t = texts[bi]; if (t.length < 2) continue;
      const cross = nb > 1 && bi < nb - 1 && rnd(4) === 0;
      const s = rnd(t.length - 1);
      if (cross) { const eb = bi + 1, e = 1 + rnd(texts[eb].length || 1); const exact = t.slice(s) + "\\n" + texts[eb].slice(0, e); marks.push({ id: "m" + k, at: { section: 0, block: bi + 1, offset: s, endBlock: eb + 1, endOffset: e, exact, prefix: "", suffix: "" }, color: "yellow", conflicts: [], tags: [], gone: false }); }
      else { const e = s + 1 + rnd(t.length - s); marks.push({ id: "m" + k, at: { section: 0, block: bi + 1, offset: s, endOffset: e, exact: t.slice(s, e), prefix: "", suffix: "" }, color: ["yellow", "green", "pink"][rnd(3)], style: rnd(3) ? undefined : "underline", conflicts: [], tags: [], gone: false }); }
    }
    const valid = marks.filter(m => m.at.exact.trim());
    const missed = VicPaint.paintMarks(root, marks, 0, "dom");
    const after = [...root.querySelectorAll("[data-b]")].map(e => e.textContent);
    if (after.join("|") !== texts.join("|")) fail.push({ c, why: "text changed" });
    const missedValid = missed.filter(m => valid.includes(m));
    if (missedValid.length) fail.push({ c, why: "missed " + missedValid.map(m => JSON.stringify(m.at)).join(" ") });
    for (const m of valid) {
      if (missed.includes(m)) continue;
      const got = [...root.querySelectorAll(`mark[data-h="${m.id}"]`)].map(e => e.textContent).join("");
      const want = m.at.exact.replace("\\n", "");
      if (got !== want) { fail.push({ c, why: `mark ${m.id} covers "${got}" not "${want}"` }); break; }
    }
    const first = root.innerHTML;
    root.innerHTML = html; VicPaint.paintMarks(root, [...marks].reverse(), 0, "dom");
    if (root.innerHTML !== first) fail.push({ c, why: "depends on order" });
    // the same marks as CSS highlights: the page is untouched and each mark's ranges hold exactly its quote
    root.innerHTML = html;
    const missed2 = VicPaint.paintMarks(root, marks, 0, "highlight");
    if (root.innerHTML !== html) fail.push({ c, why: "highlight mode changed the page" });
    if (missed2.length !== missed.length) fail.push({ c, why: "modes disagree on what is missed" });
    const by = new Map(); for (const x of VicPaint.paintedMarks()) by.set(x.m.id, (by.get(x.m.id) || "") + x.range.toString());
    for (const m of valid) { if (missed2.includes(m)) continue; const want = m.at.exact.replace("\n", ""); if (by.get(m.id) !== want) { fail.push({ c, why: `highlight ${m.id} covers "${by.get(m.id)}" not "${want}"` }); break; } }
    const names = [...CSS.highlights.keys()].filter(k => k.startsWith("vic-"));
    if (valid.length > missed2.length && !names.length) fail.push({ c, why: "no highlights registered" });
    if (fail.length > 5) break;
  }
  return fail;
}, { cases: 2000 });
await b.close();
if (res.length) { console.error("paint fuzz FAILED", JSON.stringify(res.slice(0, 5), null, 1)); process.exit(1); }
console.log("paint fuzz passed (2000 cases)");

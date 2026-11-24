// What marks are drawn on the page, whichever way they are drawn (CSS highlights or mark elements).
export const drawn = p => p.evaluate(() => {
  const hl = window.__vicPainted?.() ?? [];
  if (hl.length) { const by = new Map(); for (const x of hl) { const o = by.get(x.id); if (o) o.text += x.text; else by.set(x.id, { ...x }); } return [...by.values()]; }
  const by = new Map();
  for (const e of document.querySelectorAll(".prose mark.hl")) { const o = by.get(e.dataset.h); if (o) o.text += e.textContent; else by.set(e.dataset.h, { id: e.dataset.h, text: e.textContent, c: e.dataset.c === "none" ? undefined : e.dataset.c, s: e.dataset.s, n: !!e.dataset.n }); }
  return [...by.values()];
});
export async function waitDrawn(p, pred, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const d = await drawn(p); if (d.some(pred)) return true; if (Date.now() > end) return false; await p.waitForTimeout(50); }
}
// click the middle of the first line of a drawn mark
export async function clickMark(p, filter) {
  const pt = await p.evaluate(f => {
    const hl = window.__vicPainted?.() ?? [];
    const ok = x => (!f.c || x.c === f.c) && (!f.id || x.id === f.id) && (!f.s || x.s === f.s);
    if (hl.length) {
      const i = hl.findIndex(ok); if (i < 0) return null;
      // ranges are not exposed, so find the text again through the painted list order
      const r = window.__vicPaintedRanges?.()[i]; if (!r) return null;
      r.startContainer.parentElement.scrollIntoView({ block: "center" });
      const b = r.getClientRects()[0]; return { x: b.left + Math.min(b.width / 2, 20), y: b.top + b.height / 2 };
    }
    const e = [...document.querySelectorAll(".prose mark.hl")].find(e => ok({ id: e.dataset.h, c: e.dataset.c, s: e.dataset.s })); if (!e) return null;
    e.scrollIntoView({ block: "center" }); const b = e.getClientRects()[0]; return { x: b.left + Math.min(b.width / 2, 20), y: b.top + b.height / 2 };
  }, filter);
  if (!pt) return false;
  await p.mouse.click(pt.x, pt.y); return true;
}

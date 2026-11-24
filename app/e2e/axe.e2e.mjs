// Accessibility: axe-core on every screen, light and dark, desktop and phone. Serious and critical findings fail.
import { chromium } from "./engine.mjs";
import { createRequire } from "node:module";
const axeSrc = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const b = await chromium.launch(); let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await b.newContext({ viewport, colorScheme: scheme }); const p = await ctx.newPage();
    await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
    const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
    for (const path of ["/", "/ideas", "/places", "/discover", "/settings", "/privacy", `/book/${id}`, "/book/0000000000000000", "/nope"]) {
      await p.goto(BASE + path); await p.waitForTimeout(path.startsWith("/book/" + id) ? 1500 : 700);
      if (path === "/ideas") await p.waitForTimeout(500);
      await p.addScriptTag({ path: axeSrc });
      const r = await p.evaluate(() => axe.run(document, { resultTypes: ["violations"] }));
      for (const v of r.violations.filter(v => v.impact === "serious" || v.impact === "critical"))
        fail(`${label} ${scheme} ${path}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`);
    }
    // the reader with its text settings and its Ask panel open
    for (const name of [/text settings/i, /^ask/i]) {
      await p.goto(BASE + `/book/${id}`); await p.waitForTimeout(1500);
      const btn = p.getByRole("button", { name }).first();
      if (!await btn.count()) { fail(`${label} ${scheme}: no button ${name} in the reader`); continue; }
      await btn.click(); await p.waitForTimeout(600); await p.addScriptTag({ path: axeSrc }).catch(() => {});
      const r = await p.evaluate(() => axe.run(document, { resultTypes: ["violations"] }));
      for (const v of r.violations.filter(v => v.impact === "serious" || v.impact === "critical")) fail(`${label} ${scheme} reader ${name}: ${v.id} ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`);
    }
    // the graph view of Ideas and the reader's menus
    await p.goto(BASE + "/ideas"); const g = p.getByRole("tab", { name: /graph/i });
    if (await g.count()) { await g.first().click(); await p.waitForTimeout(1500); await p.addScriptTag({ path: axeSrc }).catch(() => {});
      const r = await p.evaluate(() => axe.run(document, { resultTypes: ["violations"] }));
      for (const v of r.violations.filter(v => v.impact === "serious" || v.impact === "critical")) fail(`${label} ${scheme} ideas graph: ${v.id} ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`); }
    await ctx.close();
  }
}
await b.close();
console.log(failed ? `${failed} FAILED` : "axe e2e passed"); process.exit(failed ? 1 : 0);

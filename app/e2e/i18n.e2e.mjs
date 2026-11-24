// Interface language: a Spanish browser gets Spanish, Settings switches both ways and the choice sticks, English stays
// the fallback for other languages, and no screen shows a raw key or an unfilled {slot}.
import { chromium } from "./engine.mjs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const b = await chromium.launch(); let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
const bad = /\b[a-z]+\.[a-zA-Z]+\b(?=[^a-z]|$)|\{\w+\}/;
async function leaks(p, label) {
  const txt = await p.evaluate(() => document.body.innerText);
  const m = txt.split("\n").find(l => /\{\w+[,}]/.test(l) || /^[a-z]+\.[a-zA-Z]+$/.test(l.trim()));
  if (m) fail(`${label}: raw key or slot on screen: "${m}"`);
}
{ // Spanish browser
  const ctx = await b.newContext({ locale: "es-EC", viewport: { width: 1100, height: 800 } }); const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  await p.goto(BASE + "/"); await p.getByRole("button", { name: "Añadir un libro" }).waitFor({ timeout: 15000 }).catch(() => fail("es: shelf not in Spanish"));
  if (await p.evaluate(() => document.documentElement.lang) !== "es") fail("es: html lang");
  for (const [path, word] of [["/", "Biblioteca"], ["/ideas", "Ideas"], ["/places", "Lugares"], ["/discover", "Descubrir"], ["/settings", "Ajustes"]]) {
    await p.goto(BASE + path); await p.waitForTimeout(500);
    if (!(await p.locator("nav, header").first().innerText()).includes(word)) fail(`es: nav lacks ${word} on ${path}`);
    await leaks(p, `es ${path}`);
  }
  await p.goto(BASE + "/settings");
  await p.locator(".lang select").selectOption("en");
  await p.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 10000 }).catch(() => fail("switch to English did not show English"));
  await p.reload(); await p.getByRole("heading", { name: "Settings" }).waitFor();
  if (await p.locator(".lang select").inputValue() !== "en") fail("choice not kept after reload");
  await p.locator(".lang select").selectOption("es");
  await p.getByRole("heading", { name: "Ajustes" }).waitFor({ timeout: 10000 }).catch(() => fail("switch back to Spanish failed"));
  if (errors.length) fail("page errors: " + errors.join(" | "));
  await ctx.close();
}
for (const loc of ["es-ES", "en-US"]) { // a small phone (360 px): the bars fit with every tab shown (no scrolling), the Ideas search keeps a usable width
  const ctx = await b.newContext({ locale: loc, viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage();
  await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const fits = sel => p.evaluate(s => { const n = document.querySelector(s); return !!n && n.scrollWidth <= n.clientWidth + 1; }, sel);
  for (const path of ["/", "/ideas", "/places", "/discover", "/settings"]) {
    await p.goto(BASE + path); await p.waitForTimeout(600);
    if (!await fits(".bar") || !await fits(".bar nav")) fail(`${loc} 360 ${path}: the tabs do not fit`);
    const inView = await p.evaluate(() => { const nav = document.querySelector(".bar nav"), on = nav?.querySelector("a.on"); if (!nav || !on) return false; const a = nav.getBoundingClientRect(), r = on.getBoundingClientRect(); return r.left >= a.left - 1 && r.right <= a.right + 1; });
    if (!inView) fail(`${loc} 360 ${path}: the open tab is cut off`);
  }
  await p.goto(BASE + "/ideas"); await p.waitForTimeout(600);
  const w = await p.evaluate(() => document.querySelector(".ideas input[type=search]")?.getBoundingClientRect().width || 0);
  if (w < 200) fail(`${loc} 360: the Ideas search box is ${Math.round(w)} px wide`);
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  if (!await fits(".rbar")) fail(`${loc} 360: the reader bar overflows`);
  const last = await p.evaluate(() => { const r = document.querySelector(".rbar").lastElementChild.getBoundingClientRect(); return r.right <= innerWidth + 1; });
  if (!last) fail(`${loc} 360: the last reader control is off screen`);
  await ctx.close();
}
{ // another language falls back to English
  const ctx = await b.newContext({ locale: "fr-FR" }); const p = await ctx.newPage();
  await p.goto(BASE + "/"); await p.getByRole("button", { name: "Add a book" }).waitFor({ timeout: 15000 }).catch(() => fail("fr: no English fallback"));
  await ctx.close();
}
await b.close();
console.log(failed ? `${failed} FAILED` : "i18n e2e passed"); process.exit(failed ? 1 : 0);

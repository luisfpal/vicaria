// End to end: the daily thought, lessons, customisation and the follow-up chat, with the model mocked (same request and
// streaming format as DeepSeek). Checks: the card shows once a day on the first open, closes and does not come back, a
// saved thought and a kept lesson survive a reload; with no key the tiers work alone (cold start, the reader's
// highlights, the Ideas lattice) and starter lessons say what a key adds; with a key the thought and the lesson come
// from the model with a small, clipped request, one call per day, the lesson sees the earlier ones, and its follow-up
// chat is kept in Ask's storage; settings reach the prompt; Spanish; phone and desktop; light and dark.
// Usage: node e2e/wiser.e2e.mjs [baseUrl] [shotsDir]
import { chromium } from "./engine.mjs";
import { seedLibrary } from "./synth-library.mjs";
import { mkdirSync } from "node:fs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
const API = "https://api.deepseek.com/chat/completions";
const BODY = "**The idea.** What you count you can change. " + "Habits are loops of a cue, a move and a result, and a count closes the loop. ".repeat(6);
const sse = (content, usage = { prompt_tokens: 600, completion_tokens: 90 }) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
const day = (off = 0) => { const d = new Date(Date.now() + off * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const b = await chromium.launch();
const open = async (label, { lang = "en", theme = "light", key = false } = {}) => {
  const viewport = label === "phone" ? { width: 390, height: 844 } : { width: 1280, height: 860 };
  const ctx = await b.newContext({ viewport, deviceScaleFactor: label === "phone" ? 2 : 1, hasTouch: label === "phone", ...(lang === "es" ? { locale: "es-ES" } : {}) });
  await ctx.addInitScript(([lang, theme]) => { try { if (!localStorage.getItem("vic:lang")) localStorage.setItem("vic:lang", lang); if (!localStorage.getItem("vic:prefs")) localStorage.setItem("vic:prefs", JSON.stringify({ theme })); } catch { /* */ } }, [lang, theme]);
  const calls = []; let mode = "ok";
  await ctx.route(API, async route => {
    const req = route.request(), cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = JSON.parse(req.postData() || "{}"), sys = typeof body.messages[0].content === "string" ? body.messages[0].content : "";
    const last = body.messages[body.messages.length - 1].content;
    const out = o => route.fulfill({ ...o, headers: { ...cors, ...o.headers } });
    if (typeof last === "string" && /single word OK/.test(last)) return out({ status: 200, contentType: "text/event-stream", body: sse("OK") });
    calls.push({ sys, body, last });
    if (mode === "fail") return out({ status: 500, contentType: "application/json", body: "{}" });
    if (/one short thought/.test(sys)) return out({ status: 200, contentType: "text/event-stream", body: sse(JSON.stringify({ text: "Call the person you keep avoiding; the dread weighs more than the call.", uses: [1] })) });
    if (/Structure of the lesson/.test(sys)) { const n = calls.filter(c => /Structure of the lesson/.test(c.sys)).length; return out({ status: 200, contentType: "text/event-stream", body: sse(JSON.stringify({ title: `The ledger ${n}`, body: BODY, people: ["Benjamin Franklin"], models: ["feedback loop"], summary: `Counting closes the loop ${n}.` })) }); }
    return out({ status: 200, contentType: "text/event-stream", body: sse("Franklin kept it to one virtue a week, so a miss was easy to see.") });
  });
  const p = await ctx.newPage(), errors = []; p.on("pageerror", e => errors.push(String(e)));
  await p.goto(BASE + "/");
  await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  if (key) { await p.evaluate(() => localStorage.setItem("vic:aikey:deepseek", "sk-mock-not-a-real-key")); }
  return { ctx, p, calls, errors, setMode: m => { mode = m; } };
};
const shot = async (p, name) => { if (SHOTS) await p.waitForTimeout(700); if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const card = p => p.locator(".wisercard");
const waitCard = async (p, where) => { await card(p).first().waitFor({ timeout: 15000 }).catch(() => fail(`${where}: no card`)); };
const reload = async p => { await p.reload(); await p.waitForSelector(".shelf"); };
const resetDay = p => p.evaluate(() => localStorage.setItem("vic:wiser:seen", "2000-01-01"));
const clearToday = p => p.evaluate(async () => { const d = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); }); await new Promise(ok => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").delete("wiser:today"); t.objectStore("kv").delete("wiser:seen"); t.oncomplete = ok; }); d.close(); });
const tags = p => p.evaluate(async () => { const d = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); }); const ks = await new Promise(ok => { const q = d.transaction("kv").objectStore("kv").getAllKeys(); q.onsuccess = () => ok(q.result); }); d.close(); return ks; });

for (const label of ["desktop", "phone"]) {
  // ---- no key: cold start, once a day, close, save, starter lessons ----
  {
    const { ctx, p, errors } = await open(label);
    await waitCard(p, `${label} cold`);
    const text = await card(p).locator(".wtext").innerText().catch(() => "");
    if (!text) fail(`${label}: the card has no thought`);
    if (!(await card(p).innerText()).includes("A classic to start with")) fail(`${label}: cold start is not marked as a bundled classic`);
    if ((await p.evaluate(() => localStorage.getItem("vic:wiser:seen"))) !== day()) fail(`${label}: first open of the day not recorded`);
    await shot(p, `card-${label}-light`);
    await card(p).locator(".wheart").click();
    if ((await card(p).locator(".wheart").getAttribute("aria-pressed")) !== "true") fail(`${label}: heart did not save`);
    await card(p).getByRole("button", { name: "Close" }).click();
    if (await card(p).count()) fail(`${label}: card still there after Close`);
    await reload(p); await p.waitForTimeout(1500);
    if (await card(p).count()) fail(`${label}: card came back on the same day`);
    // the next day, the same thought (kept for the day) is not what shows: a new day, a new thought
    await resetDay(p); await reload(p); await waitCard(p, `${label} same day kept`);
    if ((await card(p).locator(".wtext").innerText()) !== text) fail(`${label}: a second open of the same day gave another thought`);
    await card(p).getByRole("button", { name: "Want a lesson?" }).click();
    await p.waitForURL(/\/wiser$/); await p.getByRole("heading", { name: "Starter lessons" }).waitFor();
    if (!(await p.getByText("need an AI key").count())) fail(`${label}: no explanation that AI makes lessons personal`);
    if (await p.getByRole("button", { name: "Write a lesson" }).count()) fail(`${label}: Write a lesson offered without a key`);
    if ((await p.locator(".saved .wtext").innerText()) !== text) fail(`${label}: saved thought missing on the Wiser screen`);
    await shot(p, `home-${label}-light`);
    const n = await p.locator(".lessons a").count(); if (n !== 5) fail(`${label}: ${n} starter lessons, expected 5`);
    await p.locator(".lessons a").first().click(); await p.waitForURL(/\/wiser\/b-/);
    const words = (await p.locator(".lessonbody").innerText()).split(/\s+/).length; if (words < 140 || words > 320) fail(`${label}: starter lesson has ${words} words`);
    await p.getByRole("button", { name: "Keep this lesson" }).click(); await p.getByRole("button", { name: /Favourite/ }).waitFor();
    if (!(await p.getByText("Add an AI key in Settings to talk about this lesson.").count())) fail(`${label}: no key note under a lesson`);
    await shot(p, `lesson-${label}-light`);
    await reload(p).catch(() => {}); await p.goto(BASE + "/wiser"); await p.getByRole("heading", { name: "Your lessons" }).waitFor().catch(() => fail(`${label}: kept lesson missing after reload`));
    if (errors.length) fail(`${label} cold: page errors ${errors.join(" | ")}`);
    await ctx.close();
  }
  // ---- no key: the reader's highlights, then the Ideas lattice ----
  {
    const { ctx, p } = await open(label);
    await seedLibrary(p, 10); await clearToday(p); await resetDay(p); await reload(p); await waitCard(p, `${label} highlights`);
    const t = await card(p).innerText();
    if (!t.includes("a quoted passage") || !t.includes("From your own highlights")) fail(`${label}: tier 2 is not the reader's highlight (${t.slice(0, 80)})`);
    // keep the tags but blank every highlight's text: no highlight is left, so the Ideas lattice answers
    await p.evaluate(async () => { const d = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); }); await new Promise(ok => { const t = d.transaction("ops", "readwrite"), s = t.objectStore("ops"), q = s.openCursor(); q.onsuccess = () => { const c = q.result; if (!c) return; const v = c.value.v; if (v?.set?.at) c.update({ ...c.value, v: { ...v, set: { ...v.set, at: { ...v.set.at, exact: "" } } } }); c.continue(); }; t.oncomplete = ok; }); d.close(); });
    await clearToday(p); await resetDay(p); await reload(p); await waitCard(p, `${label} lattice`);
    const l = await card(p).innerText();
    if (!l.includes("From your Ideas") || !/look unrelated|runs through/.test(l)) fail(`${label}: tier 3 is not an Ideas thought (${l.slice(0, 100)})`);
    await shot(p, `card-ideas-${label}-light`);
    await ctx.close();
  }
  // ---- with a key (mocked): the thought, the lesson, memory, chat, customisation ----
  {
    const { ctx, p, calls, errors, setMode } = await open(label, { key: true });
    await seedLibrary(p, 10); await clearToday(p); await resetDay(p); await reload(p); await waitCard(p, `${label} ai`);
    const t = await card(p).innerText();
    if (!t.includes("Call the person you keep avoiding") || !t.includes("Connected from your books by AI")) fail(`${label}: tier 1 card (${t.slice(0, 100)})`);
    const th = calls.filter(c => /one short thought/.test(c.sys));
    if (th.length !== 1) fail(`${label}: ${th.length} thought calls on the first open`);
    else {
      const user = th[0].last, items = (user.match(/^\[\d+\]/gm) || []).length;
      if (items > 6 || user.length > 3500 || th[0].body.max_tokens !== 160) fail(`${label}: thought request not small (${items} items, ${user.length} chars, max_tokens ${th[0].body.max_tokens})`);
      if (!/never invent a quotation/.test(th[0].sys)) fail(`${label}: thought rules missing`);
    }
    await resetDay(p); await reload(p); await waitCard(p, `${label} ai again`);
    if (calls.filter(c => /one short thought/.test(c.sys)).length !== 1) fail(`${label}: reopening on the same day called the model again`);
    // lesson
    await p.goto(BASE + "/wiser"); await p.getByRole("button", { name: "Write a lesson" }).waitFor();
    await p.getByLabel("A topic, or leave it empty").fill("habits"); await p.getByRole("button", { name: "Write a lesson" }).click();
    await p.waitForURL(/\/wiser\/les-/, { timeout: 15000 }).catch(() => fail(`${label}: lesson not written`));
    await p.getByRole("heading", { name: "The ledger 1" }).waitFor({ timeout: 5000 }).catch(() => fail(`${label}: lesson title missing`));
    const first = calls.find(c => /Structure of the lesson/.test(c.sys));
    if (!first?.sys.includes("habits") || first.body.max_tokens !== 800 || !first.sys.includes("200 to 260")) fail(`${label}: lesson prompt lacks the topic, cap or length`);
    await shot(p, `lesson-ai-${label}-light`);
    // follow-up chat reuses Ask's storage
    await p.getByLabel("Ask about this lesson").fill("Why one virtue a week?"); await p.getByRole("button", { name: "Ask", exact: true }).click();
    await p.getByText("Franklin kept it to one virtue a week").waitFor({ timeout: 10000 }).catch(() => fail(`${label}: no chat answer`));
    const chat = calls.at(-1); if (!chat.sys.includes("The ledger 1") || chat.last !== "Why one virtue a week?") fail(`${label}: chat request lacks the lesson`);
    const id = p.url().split("/").pop(); const keys = await tags(p);
    if (!keys.includes(`chat:lesson:${id}`)) fail(`${label}: chat not stored under Ask's key`);
    await p.reload(); await p.getByText("Franklin kept it to one virtue a week").waitFor({ timeout: 10000 }).catch(() => fail(`${label}: chat lost after reload`));
    // memory: the second lesson sees the first
    await p.goto(BASE + "/wiser"); await p.getByRole("button", { name: "Write a lesson" }).click(); await p.waitForURL(/\/wiser\/les-/);
    const second = calls.filter(c => /Structure of the lesson/.test(c.sys))[1];
    if (!second?.sys.includes("The ledger 1") || !second.sys.includes("Counting closes the loop 1")) fail(`${label}: the second lesson was not given the first one's memory`);
    await p.goto(BASE + "/wiser"); await p.locator(".lessons a").nth(1).waitFor({ timeout: 5000 }).catch(() => fail(`${label}: lessons not listed`));
    // customisation reaches the prompt
    await p.goto(BASE + "/settings#wiser"); await p.getByLabel("Add a person").fill("Ada Lovelace"); await p.getByRole("button", { name: "Add", exact: true }).click();
    await p.getByRole("button", { name: /^\+ / }).first().click();
    await p.getByLabel("Tone").selectOption("blunt"); await p.getByLabel("Length").selectOption("long");
    await p.getByLabel("Topics, separated by commas").fill("work, sleep"); await p.getByLabel("Topics, separated by commas").blur();
    await p.locator(".wtemplate summary").click();
    await p.getByLabel("Prompt template (advanced)").fill("You teach with care. Voice: {tone}.\nPeople: {people}\nTopics: {topics}\nLength: {length}\n{avoid}\nFINDME"); await p.getByLabel("Prompt template (advanced)").blur();
    await p.waitForTimeout(600); // the save is an async write: let it land before the page is replaced
    await shot(p, `settings-${label}-light`);
    await p.goto(BASE + "/wiser"); await p.getByRole("button", { name: "Write a lesson" }).click(); await p.waitForURL(/\/wiser\/les-/);
    const third = calls.filter(c => /Structure of the lesson/.test(c.sys))[2];
    for (const needle of ["Ada Lovelace", "blunt", "250 to 300", "work, sleep", "FINDME", "Structure of the lesson"]) if (!third?.sys.includes(needle)) fail(`${label}: customised prompt lacks "${needle}"`);
    // a failing model: the card falls back and nothing is shown as an error
    setMode("fail"); await p.goto(BASE + "/"); await p.waitForSelector(".shelf"); await clearToday(p); await resetDay(p); await reload(p); await waitCard(p, `${label} fallback`);
    if (!(await card(p).innerText()).includes("From your")) fail(`${label}: no quiet fallback`);
    // turned off in Settings: no card on a new day
    await p.goto(BASE + "/settings#wiser"); await p.getByLabel("Show a thought the first time I open Vicaria each day").uncheck();
    await p.goto(BASE + "/"); await p.waitForSelector(".shelf"); await clearToday(p); await resetDay(p); await reload(p); await p.waitForTimeout(1500);
    if (await card(p).count()) fail(`${label}: card shown although turned off`);
    // and the Wiser screen, opened with a key and the daily thought off, draws one without asking a model
    { const before = calls.filter(c => /one short thought/.test(c.sys)).length; await clearToday(p); await p.goto(BASE + "/wiser"); await p.locator(".wisercard.plain blockquote").waitFor({ timeout: 8000 }).catch(() => fail(`${label}: no thought on the Wiser screen`));
      if (calls.filter(c => /one short thought/.test(c.sys)).length !== before) fail(`${label}: the Wiser screen asked a model although the daily thought is off`); }
    if (errors.length) fail(`${label} ai: page errors ${errors.join(" | ")}`);
    await ctx.close();
  }
  // ---- Spanish, and dark ----
  {
    const { ctx, p } = await open(label, { lang: "es", theme: "dark" });
    await waitCard(p, `${label} es`);
    const t = await card(p).innerText();
    if (!t.includes("Un clásico para empezar") || /wiser\./.test(t)) fail(`${label}: Spanish card (${t.slice(0, 100)})`);
    if (!/[áéíóúñ¿]|Séneca|Epicteto|Marco Aurelio|Franklin|Montaigne/.test(t)) fail(`${label}: the bundled thought is not in Spanish`);
    await shot(p, `card-${label}-dark`);
    await p.goto(BASE + "/wiser"); await p.getByRole("heading", { name: "Más sabio" }).waitFor().catch(() => fail(`${label}: Spanish title`));
    await p.getByRole("heading", { name: "Lecciones iniciales" }).waitFor().catch(() => fail(`${label}: Spanish starter lessons`));
    await shot(p, `home-${label}-dark`);
    await p.locator(".lessons a").first().click(); await p.waitForURL(/\/wiser\/b-/);
    if (!/La idea|De dónde viene/.test(await p.locator(".lessonbody").innerText())) fail(`${label}: the starter lesson is not in Spanish`);
    await shot(p, `lesson-${label}-dark`);
    await p.goto(BASE + "/settings#wiser"); await p.getByText("Pensamientos y lecciones").first().waitFor().catch(() => fail(`${label}: Spanish settings`));
    await ctx.close();
  }
}
await b.close();
if (!failures.length) console.log("wiser e2e ok");

// Launch screenshots from the full demo state (e2e/demo-seed.mjs): library, reader with highlights and notes, marks,
// Ask with citations, a chapter card, Ideas as list and as graph, places, listen; phone and desktop, light and dark.
// Each shot starts from a library rebuilt by the seed script (replayed conversations, no key, no spend).
// Usage: node e2e/demo-shots.mjs <epubDir> <outDir> [baseUrl]      (ONLY=desktop-dark limits the runs, SHOT=ask the shots)
import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { seedDemo, STATE } from "./demo-seed.mjs";

const [EPUBS, OUT, BASE = "http://127.0.0.1:47812/vicaria/next"] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const chats = JSON.parse(readFileSync(join(STATE, "chats.json"), "utf8")), cards = JSON.parse(readFileSync(join(STATE, "cards.json"), "utf8"));
const MED = "marcus-aurelius_meditations_george-long";

// the device voice of listen.e2e.mjs: speaks each sentence for a moment, so the reading bar and highlight show
const fakeSpeech = () => {
  const voices = [{ name: "Samantha (Enhanced)", lang: "en-US", localService: true, default: true }];
  let cur = null, timer = 0;
  const s = { getVoices: () => voices, speaking: false, pending: false, paused: false,
    speak(u) { cur = u; timer = setTimeout(() => { cur = null; u.onend?.({}); }, 4000); },
    cancel() { clearTimeout(timer); const u = cur; cur = null; u?.onerror?.({ error: "interrupted" }); }, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(window, "speechSynthesis", { value: s, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.rate = 1; } };
};

// Piper voice files from VIC_MODELS (as in listen.e2e.mjs), whole and at once, with Range support
const MODELS = process.env.VIC_MODELS || new URL("../../../models/piper", import.meta.url).pathname;
async function serveModel(route) {
  const name = decodeURIComponent(route.request().url().split("/").pop()), file = `${MODELS}/${name}`;
  const cors = { "access-control-allow-origin": "*", "content-type": "application/octet-stream" };
  if (!existsSync(file)) return route.fulfill({ status: 404, headers: cors, body: "" });
  const all = readFileSync(file), m = /bytes=(\d+)-/.exec(route.request().headers().range || ""), from = m ? +m[1] : 0;
  return route.fulfill({ status: m ? 206 : 200, headers: { ...cors, ...(m ? { "content-range": `bytes ${from}-${all.length - 1}/${all.length}` } : {}) }, body: all.subarray(from) });
}

const want = n => !process.env.SHOT || process.env.SHOT.split(",").includes(n);
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
for (const scheme of ["light", "dark"]) for (const [form, viewport, dsf] of [["desktop", { width: 1280, height: 800 }, 2], ["phone", { width: 390, height: 844 }, 3]]) {
  const tag = `${form}-${scheme}`;
  if (process.env.ONLY && !tag.includes(process.env.ONLY)) continue;
  const ctx = await b.newContext({ viewport, deviceScaleFactor: dsf, hasTouch: form === "phone", colorScheme: scheme });
  await ctx.addInitScript(fakeSpeech);
  await ctx.route(/huggingface\.co|cdn\.jsdelivr\.net/, serveModel); // the clearer voice arrives at once from local files, so the bar shows no download
  const { page: p, files } = await seedDemo(ctx, { base: BASE, epubDir: EPUBS });
  const id = files.find(f => f.slug === MED).id;
  const shot = async name => { await p.waitForTimeout(700); await p.screenshot({ path: `${OUT}/${name}-${tag}.png` }); console.log("shot", name, tag); };
  const settle = async () => { await p.getByRole("button", { name: "Not now" }).click().catch(() => {}); await p.getByRole("button", { name: "Close", exact: true }).click({ timeout: 1500 }).catch(() => {}); };
  const gotoBook = async (section, block) => {
    await p.goto(`${BASE}/book/${id}?s=${section}&b=${block}`);
    await p.locator(".prose [data-b]").first().waitFor({ timeout: 30000 });
    await p.waitForTimeout(800);
  };
  const quoteAt = async quote => p.evaluate(async ({ id, quote }) => {
    const db = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); });
    const get = (s, k) => new Promise(ok => { const q = db.transaction(s).objectStore(s).get(k); q.onsuccess = () => ok(q.result); });
    const head = await get("heads", id);
    for (const s of head.sectionInfo) { const sec = await get("sections", [id, s.idx]); const b = sec.blocks.findIndex(x => x.includes(quote)); if (b >= 0) return [s.idx, b]; }
  }, { id, quote });

  if (want("library")) { await p.goto(BASE + "/"); await p.locator("a.book-card").first().waitFor(); await settle(); await p.waitForTimeout(1200); await shot("library"); }

  // the reader on Meditations, Book II: several highlights in colour and margin notes in one screen
  const [rs, rb] = await quoteAt("Begin the morning by saying");
  if (want("reader")) {
    await gotoBook(rs, rb); await settle();
    await p.evaluate(b => { document.querySelector(`.prose [data-b="${b}"]`)?.scrollIntoView({ block: "start" }); scrollBy(0, -90); }, rb);
    await shot("reader");
  }
  if (want("marks")) {
    await gotoBook(rs, rb);
    await p.getByRole("button", { name: "Marks", exact: true }).click(); await p.waitForTimeout(800); await shot("marks");
  }

  // Ask: the saved conversation of the chapter with the most cited answers
  const chat = chats.filter(c => c.slug === MED && c.scope.startsWith("ch")).sort((a, c) => c.turns.length - a.turns.length)[0];
  if (chat && want("ask")) {
    const sec = +chat.scope.slice(2);
    await gotoBook(sec, 2);
    await p.getByRole("button", { name: "Ask about this book" }).click().catch(() => p.getByRole("button", { name: "Ask", exact: true }).click());
    await p.getByRole("radio", { name: "This chapter" }).click();
    await p.locator(".turn.ai .answer button.cite").first().waitFor({ timeout: 10000 });
    await p.evaluate(() => { const t = document.querySelector(".turns"); if (t) t.scrollTop = 0; });
    await shot("ask");
  }
  const card = cards.find(c => c.slug === MED) ?? cards[0];
  if (card && want("card")) {
    const cid = files.find(f => f.slug === card.slug).id;
    await p.goto(`${BASE}/book/${cid}?s=${card.section}&b=2`); await p.locator(".prose [data-b]").first().waitFor();
    await p.getByRole("button", { name: "Ask about this book" }).click().catch(() => p.getByRole("button", { name: "Ask", exact: true }).click());
    await p.getByRole("radio", { name: "Chapter card" }).click(); await p.waitForTimeout(1200); await shot("card");
  }

  if (want("ideas")) {
    await p.goto(BASE + "/ideas"); await p.waitForFunction(() => document.querySelectorAll(".vrow").length > 1, null, { timeout: 20000 }); await settle();
    // the phone canvas is too narrow for thirty labelled nodes (labels run off the edge), so the phone's Ideas shot is the list
    if (form === "phone") await shot("ideas");
    else {
      if (want("ideas-list")) await shot("ideas-list");
      await p.getByRole("button", { name: /graph/i }).or(p.getByRole("tab", { name: /graph/i })).or(p.getByRole("radio", { name: /graph/i })).first().click();
      await p.waitForTimeout(7000); await shot("ideas");
    }
  }
  if (want("wiser")) {
    await p.goto(BASE + "/wiser"); await p.getByRole("heading", { name: "Your lessons" }).waitFor({ timeout: 15000 }); await p.waitForTimeout(800); await shot("wiser");
    await p.locator(".lessons a").first().click(); await p.locator(".lessonbody").waitFor(); await shot("lesson");
  }
  if (want("places")) {
    await p.goto(BASE + "/places"); await p.waitForTimeout(1000); await settle();
    await p.getByRole("tab", { name: /^Notes/ }).click().catch(() => {}); await p.waitForTimeout(600); await shot("places");
  }
  if (want("listen")) {
    await gotoBook(rs, rb);
    await p.getByRole("button", { name: "Listen", exact: true }).click();
    await p.locator(".listenbar").waitFor({ timeout: 8000 }); await p.waitForTimeout(1200); await shot("listen");
  }
  await ctx.close();
}
await b.close();

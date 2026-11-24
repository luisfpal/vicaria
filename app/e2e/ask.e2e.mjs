// End to end: asking about a book, against a mock of DeepSeek's API (same request and streaming format), at desktop
// and phone sizes. Checks: the key is checked and kept on the device; only passages already read are sent, each with
// its id; the answer streams in with citation chips that jump to the passage, math (KaTeX) and a Mermaid diagram,
// which load only when an answer needs them; a question about a selection; a picture; Stop; a refused key; the
// conversation is still there after a reload.
// Usage: node e2e/ask.e2e.mjs [baseUrl] [shotsDir]
import { chromium } from "./engine.mjs";
import { mkdirSync } from "node:fs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
// the last line names every failure, so a log cut to its tail still says what went wrong
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
// Diagram labels are drawn at 16px; a chart shrunk to fit the panel must not take them under 13px.
const labelsReadable = async (p, where) => {
  const sizes = await p.locator(".answer .mermaid svg").evaluateAll(svgs => svgs.map(s => { const vb = (s.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number); return vb[2] ? 16 * s.getBoundingClientRect().width / vb[2] : 16; }));
  for (const z of sizes) if (z < 13) fail(`${where}: diagram labels shrunk to ${z.toFixed(1)}px`);
};
// The scope chips sit on one row, at any width the panel has
const chipsOneRow = async (p, where) => {
  const tops = await p.locator(".askscope .chip").evaluateAll(cs => cs.map(c => Math.round(c.getBoundingClientRect().top)));
  if (new Set(tops).size !== 1) fail(`${where}: scope chips wrap onto ${new Set(tops).size} rows`);
};
const API = "https://api.deepseek.com/chat/completions";
// a 2x2 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

const b = await chromium.launch();
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: label === "phone" ? 3 : 1, hasTouch: label === "phone" });
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  const fetched = []; p.on("request", r => fetched.push(r.url()));
  const calls = []; let mode = "ok";
  await ctx.route(API, async route => {
    const req = route.request();
    // a cross-origin call with an Authorization header is preceded by an OPTIONS check; Playwright's WebKit does not answer it for us
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const fulfill = route.fulfill.bind(route); route.fulfill = o => fulfill({ ...o, headers: { ...cors, ...o.headers } });
    const body = JSON.parse(req.postData() || "{}");
    calls.push({ auth: req.headers().authorization, body });
    if (mode === "hang") { await new Promise(r => setTimeout(r, 15000)); return route.abort().catch(() => {}); }
    if (mode === "refuse") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { message: "Authentication Fails" } }) });
    const last = body.messages[body.messages.length - 1];
    const text = typeof last.content === "string" ? last.content : last.content.find(x => x.type === "text").text;
    if (/single word OK/.test(text)) return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n' });
    if (/hand on the lessons/.test(body.messages[0].content)) {
      const card = { core: "Expect difficult people each morning and keep your own judgment calm.", lessons: [{ lesson: "Wrongdoers share your nature", why: "He calls them kin who partake of the same reason." }, { lesson: "Only judgment can injure you", why: "No one can fix ugliness on you; harm comes from opinion." }, { lesson: "Cooperation is natural", why: "Like hands and eyelids, people exist to work together." }], remember: "", terms: [], diagram: { type: "cause", title: "How an insult becomes harm", nodes: [{ id: "a", label: "Someone acts badly" }, { id: "b", label: "You judge harm" }, { id: "c", label: "Anger follows" }, { id: "d", label: "Your mind is disturbed" }, { id: "e", label: "You act badly in turn" }], edges: [{ from: "a", to: "b", label: "prompts" }, { from: "b", to: "c", label: "produces" }, { from: "c", to: "d", label: "causes" }, { from: "d", to: "e", label: "leads to" }] } };
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(card) } }] })}\n\ndata: [DONE]\n\n` });
    }
    const ids = [...text.matchAll(/^\[(\d+\.\d+)\]/gm)].map(m => m[1]);
    const answer = `He treats anger as weakness [${ids[0]}]. The cost grows like $E = mc^2$ and\n\n$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$\n\n\`\`\`mermaid\nflowchart LR\n  A[Insult] --> B[Judgment] --> C[Anger]\n\`\`\`\n\nAlso [99.99] is not a real passage.`;
    const chunks = answer.match(/[\s\S]{1,25}/g).map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("");
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: chunks + 'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":80}}\n\ndata: [DONE]\n\n' });
  });

  // ---- the key ----
  await p.goto(BASE + "/");
  await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  await p.goto(BASE + "/settings#ai");
  await p.getByLabel("Provider").selectOption({ label: "DeepSeek" }); await p.getByLabel("DeepSeek API key").fill("sk-mock-not-a-real-key");
  await p.getByRole("button", { name: "Add key" }).click();
  await p.getByText("DeepSeek accepted the key.").waitFor({ timeout: 5000 }).catch(() => fail(`${label}: key check did not pass`));
  if (calls[0]?.auth !== "Bearer sk-mock-not-a-real-key") fail(`${label}: key not sent as a bearer token`);
  if (JSON.stringify(calls[0]?.body).includes("sk-mock")) fail(`${label}: key in the request body`);
  const stored = await p.evaluate(async () => { const d = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); }); const all = await new Promise(ok => { const q = d.transaction(["ops", "kv"]).objectStore("ops").getAll(); q.onsuccess = () => ok(q.result); }); return JSON.stringify(all).includes("sk-mock"); });
  if (stored) fail(`${label}: the key went into the synced op log`);

  // ---- a question in chapter mode ----
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  await p.goto(`${BASE}/book/${id}?s=3&b=0`);
  await p.locator(".prose [data-b]").first().waitFor();
  const before = fetched.length;
  await p.getByRole("button", { name: "Ask about this book" }).click();
  await p.getByLabel("Question").fill("What does he say about anger?");
  await p.getByLabel("Question").press("Enter");
  const ans = p.locator(".turn.ai .answer").last();
  await ans.locator("button.cite").first().waitFor({ timeout: 10000 }).catch(() => fail(`${label}: no citation chip`));
  await ans.locator(".katex").first().waitFor({ timeout: 10000 }).catch(() => fail(`${label}: math not rendered`));
  await ans.locator(".mermaid svg").first().waitFor({ timeout: 15000 }).catch(() => fail(`${label}: diagram not drawn`));
  if (await ans.locator(".katex-display").count() !== 1) fail(`${label}: display math missing`);
  if (await ans.locator("button.cite").count() !== 1) fail(`${label}: a citation of a passage that was not sent became a chip`);
  const late = fetched.slice(0, before).filter(u => /katex|mermaid/i.test(u));
  if (late.length) fail(`${label}: KaTeX or Mermaid loaded before an answer needed them: ${late[0]}`);
  if (!fetched.slice(before).some(u => /katex/i.test(u))) fail(`${label}: KaTeX was not loaded on demand`);
  const q1 = calls[calls.length - 1].body, u1 = q1.messages[q1.messages.length - 1].content;
  const sentIds = [...u1.matchAll(/^\[(\d+)\.(\d+)\]/gm)].map(m => [+m[1], +m[2]]);
  if (!sentIds.length) fail(`${label}: no passages sent`);
  if (sentIds.some(([s]) => s > 3)) fail(`${label}: passages after the reader's place were sent: ${sentIds.filter(([s]) => s > 3).join(" ")}`);
  if (q1.model !== "deepseek-flash" || q1.thinking?.type !== "disabled" || q1.stream !== true) fail(`${label}: request ${JSON.stringify({ model: q1.model, thinking: q1.thinking, stream: q1.stream })}`);
  if (/\u2014/.test(q1.messages[0].content)) fail(`${label}: em dash in the prompt`);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: `${SHOTS}/ask_${label}_answer.png` }); }
  await labelsReadable(p, label); await chipsOneRow(p, label);
  // the chip jumps to its passage
  const chip = await ans.locator("button.cite").first().getAttribute("data-cite");
  await ans.locator("button.cite").first().click();
  const [cs, cb] = chip.split(".").map(Number);
  await p.waitForFunction(({ cs, cb }) => { const u = new URL(location.href); const el = document.querySelector(`.prose [data-b="${cb}"]`); if (!el) return false; const r = el.getBoundingClientRect(); return +(u.searchParams.get("s") ?? -1) === cs || (r.top >= 0 && r.top < innerHeight); }, { cs, cb }, { timeout: 5000 }).catch(() => fail(`${label}: citation ${chip} did not go to its passage`));

  // ---- a question about a selection, with a picture (back in the same chapter: one conversation per chapter) ----
  await p.goto(`${BASE}/book/${id}?s=3&b=0`);
  await p.locator(".prose [data-b]").first().waitFor();
  const blk = await p.evaluate(() => +[...document.querySelectorAll(".prose [data-b]")].find(e => (e.textContent || "").length > 120 && e.getBoundingClientRect().top > 0).dataset.b);
  await p.evaluate(block => {
    const el = document.querySelector(`.prose [data-b="${block}"]`); el.scrollIntoView({ block: "center" });
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const n = w.nextNode();
    const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, Math.min(40, n.data.length)); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, blk);
  await p.locator(".seltools button", { hasText: "Ask" }).click();
  await p.locator(".asksel blockquote").waitFor({ timeout: 3000 }).catch(() => fail(`${label}: the selection is not shown in Ask`));
  await p.locator('.askbox input[type="file"]').setInputFiles({ name: "fig.png", mimeType: "image/png", buffer: PNG });
  await p.locator(".askimgs img").waitFor({ timeout: 3000 }).catch(() => fail(`${label}: picture not attached`));
  await p.getByLabel("Question").fill("What does this mean?");
  await p.getByRole("button", { name: "Ask", exact: true }).click();
  await p.locator(".turn.ai").nth(1).locator(".answer").waitFor({ timeout: 10000 }).catch(() => fail(`${label}: no answer about the selection`));
  const q2 = calls[calls.length - 1].body, u2 = q2.messages[q2.messages.length - 1].content;
  const t2 = Array.isArray(u2) ? u2.find(x => x.type === "text").text : u2;
  if (!/The reader selected this text \[\d+\.\d+\]/.test(t2)) fail(`${label}: the selection was not sent`);
  if (!Array.isArray(u2) || !u2.some(x => x.type === "image_url" && x.image_url.url.startsWith("data:image/jpeg;base64,"))) fail(`${label}: the picture was not sent`);
  if (q2.messages.filter(m => m.role === "assistant").length !== 1) fail(`${label}: the earlier answer was not sent back`);

  // ---- Stop, and a refused key ----
  mode = "hang";
  await p.getByLabel("Question").fill("A slow one");
  await p.getByLabel("Question").press("Enter");
  await p.getByRole("button", { name: "Stop" }).click({ timeout: 5000 });
  await p.locator(".turn.ai p", { hasText: "Stopped." }).waitFor({ timeout: 5000 }).catch(() => fail(`${label}: Stop did not stop`));
  mode = "refuse";
  await p.getByLabel("Question").fill("Another");
  await p.getByLabel("Question").press("Enter");
  await p.locator(".turn .err", { hasText: "did not accept the key" }).waitFor({ timeout: 15000 }).catch(async () => fail(`${label}: a refused key was not explained; last turn "${(await p.locator(".turn").last().innerText().catch(() => "")).slice(0, 200)}", ${calls.length} calls`));
  if (!await p.locator(".turn .err button", { hasText: "Open Settings" }).count()) fail(`${label}: a refused key does not lead to Settings`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/ask_${label}_errors.png` });

  // ---- a picture from the book (desktop: one size is enough for this) ----
  if (label === "desktop") {
    mode = "ok";
    await p.goto(BASE + "/");
    const corpus = new URL("../../tests/corpus/idpf-internallinks.epub", import.meta.url).pathname;
    await p.locator('input[type="file"][accept^=".epub"]').setInputFiles(corpus);
    await p.waitForURL(/\/book\/[0-9a-f]{16}/, { timeout: 30000 });
    const bid = p.url().match(/book\/([0-9a-f]{16})/)[1];
    let found = false;
    for (let s = 0; s < 25 && !found; s++) {
      await p.goto(`${BASE}/book/${bid}?s=${s}&b=0`); await p.locator(".prose [data-b]").first().waitFor({ timeout: 5000 }).catch(() => {});
      found = await p.waitForFunction(() => [...document.querySelectorAll(".prose img")].some(i => i.complete && i.naturalWidth > 0 && !i.closest("a")), null, { timeout: 1500 }).then(() => true).catch(() => false);
    }
    if (!found) fail("desktop: no picture found in the test book");
    else {
      const img = p.locator(".prose img").filter({ hasNot: p.locator("xpath=ancestor::a") }).first();
      await img.scrollIntoViewIfNeeded(); await img.click();
      await p.getByRole("button", { name: "Ask about this picture" }).click();
      await p.locator(".askimgs img").waitFor({ timeout: 5000 }).catch(() => fail("desktop: the book's picture was not attached"));
      await p.getByLabel("Question").fill("What does this picture show?");
      await p.getByLabel("Question").press("Enter");
      await p.locator(".turn.ai .answer").first().waitFor({ timeout: 10000 }).catch(() => fail("desktop: no answer about the picture"));
      const q3 = calls[calls.length - 1].body, u3 = q3.messages[q3.messages.length - 1].content;
      if (!Array.isArray(u3) || !u3.some(x => x.type === "image_url")) fail("desktop: the book's picture was not sent");
      else if (!/selected this text \[\d+\.\d+\]:\n"\(picture/.test(u3.find(x => x.type === "text").text)) fail("desktop: the picture's place was not sent");
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/ask_desktop_picture.png` });
    }
  }

  // ---- the chapter card: made once, kept after a reload ----
  {
    mode = "ok";
    await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
    await p.getByRole("button", { name: "Ask about this book" }).click();
    await p.getByRole("radio", { name: "Chapter card" }).click();
    await chipsOneRow(p, `${label} card`);
    await p.getByRole("button", { name: "Make the card" }).click();
    await p.locator(".cardview .answer", { hasText: "Expect difficult people" }).waitFor({ timeout: 10000 }).catch(() => fail(`${label}: the card was not shown`));
    await p.locator(".cardview .mermaid svg").waitFor({ timeout: 15000 }).catch(() => fail(`${label}: the card's diagram was not drawn`));
    await labelsReadable(p, `${label} card`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/ask_${label}_card.png` });
    const n = calls.length;
    await p.reload(); await p.locator(".prose [data-b]").first().waitFor();
    await p.getByRole("button", { name: "Ask about this book" }).click();
    await p.getByRole("radio", { name: "Chapter card" }).click();
    await p.locator(".cardview .answer", { hasText: "Expect difficult people" }).waitFor({ timeout: 10000 }).catch(() => fail(`${label}: the card was not kept`));
    if (calls.length !== n) fail(`${label}: the kept card was asked for again`);
  }

  // ---- the conversation is kept ----
  mode = "ok";
  await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  await p.getByRole("button", { name: "Ask about this book" }).click();
  await p.locator(".turn.me", { hasText: "What does he say about anger?" }).waitFor({ timeout: 5000 }).catch(() => fail(`${label}: the conversation was not kept`));
  if (errors.length) fail(`${label}: page errors ${errors.join(" | ")}`);
  console.log(`${label}: ${calls.length} calls, ${sentIds.length} passages sent for the first question, all within the chapters read`);
  await ctx.close();
}
// ---- dictation: on the device only (the browser's recognizer is replaced by a stand-in that reports availability) ----
for (const avail of ["downloadable", "unavailable"]) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(a => {
    class R { constructor() { this.processLocally = false; window.__rec = this; } start() { window.__recStarted = { lang: this.lang, local: this.processLocally }; setTimeout(() => { this.onresult?.({ results: [[{ transcript: "what does he say " }], [{ transcript: "about anger" }]] }); this.onend?.(); }, 100); } stop() { this.onend?.(); } }
    R.available = async () => window.__installed ? "available" : a;
    R.install = async () => { window.__installed = true; return true; };
    window.SpeechRecognition = R; window.webkitSpeechRecognition = R;
    localStorage.setItem("vic:aikey:deepseek", "sk-mock-not-a-real-key");
  }, avail);
  const p = await ctx.newPage();
  await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  await p.getByRole("button", { name: "Ask about this book" }).click();
  await p.getByLabel("Question").waitFor();
  await p.waitForTimeout(500);
  const mic = p.getByRole("button", { name: "Dictate" });
  if (avail === "unavailable") {
    await mic.click();
    await p.locator(".toast", { hasText: "not available on this device" }).waitFor({ timeout: 3000 }).catch(() => fail("no word that dictation is not available on this device"));
    if (await p.evaluate(() => !!window.__recStarted)) fail("dictation started where the device cannot do it (it would go to a server)");
  }
  else {
    await mic.click();
    await p.locator(".toast", { hasText: "Getting dictation" }).waitFor({ timeout: 3000 }).catch(() => fail("installing the language was not shown"));
    await p.waitForFunction(() => document.querySelector('textarea[aria-label="Question"]').value === "what does he say about anger", null, { timeout: 5000 }).catch(() => fail("dictated words did not reach the question box"));
    const st = await p.evaluate(() => window.__recStarted);
    if (!st?.local) fail(`dictation did not ask for on-device recognition (${JSON.stringify(st)})`);
    console.log(`dictation: language installed on first use, on-device (${st.lang}), words in the box`);
  }
  await ctx.close();
}
await b.close();
console.log(process.exitCode ? "ask e2e FAILED" : "ask e2e passed");

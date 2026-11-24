// Golden test of a shipped AI route against the real provider, in a real browser, the way a reader uses it:
// the key is added in Settings (and checked), then a question about the starter book gets a streamed answer that
// cites passages that were sent, with a formula rendered when asked for one. The key is read from a file and is
// never printed or written anywhere but the browser's storage for this run.
// Usage: KEY_FILE=/path/to/key node e2e/golden.mjs [baseUrl] [screenshotDir]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
const key = readFileSync(process.env.KEY_FILE, "utf8").trim();
const hide = s => String(s).split(key).join("[key]");
const fail = m => { console.error("FAIL " + hide(m)); process.exitCode = 1; };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const p = await ctx.newPage();
const errors = []; p.on("pageerror", e => errors.push(hide(e)));
let usage = null, firstMs = null, t0 = 0;
p.on("response", async r => { if (r.url().startsWith("https://api.deepseek.com/") && r.request().method() === "POST") { try { const t = await r.text(); const u = [...t.matchAll(/"usage":(\{[^}]*\})/g)].pop(); if (u) usage = JSON.parse(u[1]); } catch { /* streaming body */ } } });
await p.goto(BASE + "/");
await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 60000 });
await p.goto(BASE + "/settings#ai");
await p.getByLabel("Provider").selectOption({ label: "DeepSeek" }); await p.getByLabel("DeepSeek API key").fill(key);
await p.getByRole("button", { name: "Add key" }).click();
await p.getByText("DeepSeek accepted the key.").waitFor({ timeout: 30000 }).catch(async () => fail(`key check: ${await p.locator('[role=status]').innerText().catch(() => "?")}`));
const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
for (const [n, q, want] of [
  [1, "What does Marcus Aurelius say to expect each morning, and why should it not anger him?", { cites: 1 }],
  [2, "Write the formula for the sum of the first n integers, as a display formula, and say in one sentence whether this book discusses mathematics.", { math: 1 }],
  [3, "Draw a short mermaid flowchart of how, in this chapter, an insult leads or does not lead to harm.", { mermaid: 1 }],
]) {
  await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  await p.getByRole("button", { name: "Ask about this book" }).click();
  await p.getByLabel("Question").fill(q); t0 = Date.now(); firstMs = null;
  await p.getByLabel("Question").press("Enter");
  const turn = p.locator(".turn.me", { hasText: q.slice(0, 40) }).last().locator("xpath=following-sibling::div[contains(@class,'ai')][1]");
  await turn.locator(".answer").waitFor({ timeout: 30000 }).then(() => { firstMs = Date.now() - t0; }).catch(() => fail(`q${n}: no answer started`));
  await p.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 90000 }).catch(() => fail(`q${n}: answer did not finish`));
  const err = await turn.locator(".err").innerText().catch(() => "");
  if (err) fail(`q${n}: ${err}`);
  const text = await turn.locator(".answer").innerText().catch(() => "");
  if (/\u2014/.test(text)) fail(`q${n}: em dash in the answer`);
  if (want.cites && await turn.locator("button.cite").count() < want.cites) fail(`q${n}: no citation of a sent passage`);
  if (want.math) await turn.locator(".katex-display").first().waitFor({ timeout: 10000 }).catch(() => fail(`q${n}: no display formula`));
  if (want.mermaid) await turn.locator(".mermaid svg").first().waitFor({ timeout: 15000 }).catch(() => fail(`q${n}: no diagram drawn`));
  console.log(`q${n}: first text ${firstMs} ms, ${await turn.locator("button.cite").count()} citations, ${text.length} chars; "${hide(text.replace(/\s+/g, " ").slice(0, 140))}"`);
  await p.locator(".panel .ptop button").click();
}
// a picture from the book: the title page image of the starter book says "Meditations"
{
  let found = false;
  for (let s = 0; s < 6 && !found; s++) {
    await p.goto(`${BASE}/book/${id}?s=${s}&b=0`); await p.locator(".prose [data-b]").first().waitFor({ timeout: 5000 }).catch(() => {});
    found = await p.waitForFunction(() => [...document.querySelectorAll(".prose img")].some(i => i.complete && i.naturalWidth > 0 && /Meditations/.test(i.alt)), null, { timeout: 2000 }).then(() => true).catch(() => false);
  }
  if (!found) fail("q4: no title page picture found");
  else {
    const img = p.locator(".prose img[alt*='Meditations']").first();
    await img.scrollIntoViewIfNeeded(); await img.click();
    await p.getByRole("button", { name: "Ask about this picture" }).click();
    await p.locator(".askimgs img").waitFor({ timeout: 5000 });
    const q = "Read the words written in this picture, exactly, and nothing else.";
    await p.getByLabel("Question").fill(q); t0 = Date.now();
    await p.getByLabel("Question").press("Enter");
    const turn = p.locator(".turn.me", { hasText: q.slice(0, 40) }).last().locator("xpath=following-sibling::div[contains(@class,'ai')][1]");
    await turn.locator(".answer").waitFor({ timeout: 30000 }).catch(() => fail("q4: no answer started"));
    await p.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 90000 }).catch(() => {});
    const err = await turn.locator(".err").innerText().catch(() => ""); if (err) fail(`q4: ${err}`);
    const text = await turn.locator(".answer").innerText().catch(() => "");
    // (the picture's description is sent with it, so this checks the flow; q5 checks that the image itself is read)
    if (!/meditations/i.test(text)) fail(`q4: the picture's words were not read: "${hide(text.slice(0, 200))}"`);
    console.log(`q4 (picture): ${Date.now() - t0} ms; "${hide(text.replace(/\s+/g, " ").slice(0, 140))}"`);
  }
}
// a picture whose words appear nowhere else in the request: proves the model reads the image itself
{
  const pg = await ctx.newPage();
  await pg.setContent('<div id="x" style="display:inline-block;padding:30px 50px;font:bold 64px sans-serif;background:#fff;color:#123">ZEBRA 4721</div>');
  const png = await pg.locator("#x").screenshot(); await pg.close();
  await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  if (!await p.locator(".panel .ask").count()) await p.getByRole("button", { name: "Ask about this book" }).click();
  await p.locator('.askbox input[type="file"]').setInputFiles({ name: "card.png", mimeType: "image/png", buffer: png });
  await p.locator(".askimgs img").waitFor({ timeout: 5000 });
  const q = "What word and number are written in the attached picture? Answer with just them.";
  await p.getByLabel("Question").fill(q); t0 = Date.now();
  await p.getByLabel("Question").press("Enter");
  const turn = p.locator(".turn.me", { hasText: q.slice(0, 40) }).last().locator("xpath=following-sibling::div[contains(@class,'ai')][1]");
  await turn.locator(".answer").waitFor({ timeout: 30000 }).catch(() => fail("q5: no answer started"));
  await p.getByRole("button", { name: "Stop" }).waitFor({ state: "detached", timeout: 90000 }).catch(() => {});
  const err = await turn.locator(".err").innerText().catch(() => ""); if (err) fail(`q5: ${err}`);
  const text = await turn.locator(".answer").innerText().catch(() => "");
  if (!/zebra/i.test(text) || !/4721/.test(text)) fail(`q5: the attached picture was not read: "${hide(text.slice(0, 200))}"`);
  console.log(`q5 (attached picture): ${Date.now() - t0} ms; "${hide(text.replace(/\s+/g, " ").slice(0, 100))}"`);
}
// a chapter card, made from the whole chapter and checked by the app's own rules
{
  await p.getByRole("radio", { name: "Chapter card" }).click();
  t0 = Date.now();
  await p.getByRole("button", { name: "Make the card" }).click();
  const ans = p.locator(".cardview .answer");
  await ans.waitFor({ timeout: 120000 }).catch(() => {});
  const err = await p.locator(".cardview .err").innerText().catch(() => ""); if (err) fail(`card: ${err}`);
  const text = await ans.innerText().catch(() => "");
  const lessons = await ans.locator("ol > li").count();
  if (lessons !== 3) fail(`card: ${lessons} lessons`);
  if (text.includes("\u2014")) fail("card: em dash");
  await p.waitForTimeout(3000);
  const diagram = (await ans.locator(".mermaid svg").count()) ? "drawn diagram" : (await ans.locator("table").count()) ? "comparison table" : "no diagram";
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/golden_card.png` });
  console.log(`card: ${Date.now() - t0} ms, ${lessons} lessons, ${diagram}; "${hide(text.replace(/\s+/g, " ").slice(0, 160))}"`);
}
if (usage) console.log(`last usage: ${usage.prompt_tokens} in, ${usage.completion_tokens} out`);
if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
await b.close();
console.log(process.exitCode ? "golden FAILED" : "golden passed");

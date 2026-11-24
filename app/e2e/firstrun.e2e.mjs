// End to end: setting up a device. The shelf card shows once and leads to Settings; Settings lists each model with
// size, progress, Download, Pause, Remove and the space used; search by meaning (EmbeddingGemma) is downloaded, the
// open book is read for it, and a question that shares no words with its passage sends that passage to the model
// (without the model, it does not); dictation by Whisper where the browser has no recognizer works from a spoken
// recording. Model files come from VIC_GEMMA and VIC_WHISPER (folders laid out as on Hugging Face), served locally.
// Usage: node e2e/firstrun.e2e.mjs [baseUrl] [shotsDir]
import { chromium } from "./engine.mjs";
import { mkdirSync, existsSync, statSync, createReadStream } from "node:fs";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || ""; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const GEMMA = process.env.VIC_GEMMA || `${new URL("../../../models/gemma", import.meta.url).pathname}`, WHISPER = process.env.VIC_WHISPER || `${new URL("../../../models/whisper", import.meta.url).pathname}`;
const WAV = new URL("../tests/fixtures/dictation.wav", import.meta.url).pathname;
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
for (const [d, f] of [[GEMMA, "onnx/model_quantized.onnx_data"], [WHISPER, "onnx/encoder_model_quantized.onnx"]]) if (!existsSync(`${d}/${f}`)) { console.error(`no model files in ${d}`); process.exit(1); }

// model files from a local server with Range support (the 300 MB file is too big to hand over through the browser
// tester's own request hook); `slow` holds each response back, so a download can be paused midway
let slow = 0;
// a self-signed certificate for the run (the pages' requests to Hugging Face are https, and a redirect keeps the scheme)
const tls = mkdtempSync(join(tmpdir(), "vic-tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", `${tls}/k.pem`, "-out", `${tls}/c.pem`], { stdio: "ignore" });
const server = createServer({ key: readFileSync(`${tls}/k.pem`), cert: readFileSync(`${tls}/c.pem`) }, async (req, res) => {
  const u = new URL(req.url, "http://x"), rel = u.pathname.split("/resolve/")[1]?.split("/").slice(1).join("/") ?? "";
  const dir = /embeddinggemma/.test(u.pathname) ? GEMMA : /whisper/.test(u.pathname) ? WHISPER : null, file = dir && `${dir}/${rel}`;
  const h = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/octet-stream" };
  if (req.method === "OPTIONS") { res.writeHead(204, h); return res.end(); }
  if (!file || !existsSync(file)) { res.writeHead(404, h); return res.end(); }
  if (slow) await new Promise(r => setTimeout(r, slow));
  const size = statSync(file).size, m = /bytes=(\d+)-/.exec(req.headers.range || ""), from = m ? +m[1] : 0;
  res.writeHead(m ? 206 : 200, { ...h, "content-length": size - from, ...(m ? { "content-range": `bytes ${from}-${size - 1}/${size}` } : {}) });
  createReadStream(file, { start: from }).pipe(res);
});
await new Promise(ok => server.listen(0, "127.0.0.1", ok));
const SERVED = `https://127.0.0.1:${server.address().port}`;
const API = "https://api.deepseek.com/chat/completions";
const row = (p, id) => p.locator(`[data-model="${id}"]`);
const settle = (p, id, ms) => p.waitForFunction(i => /On this device/.test(document.querySelector(`[data-model="${i}"]`)?.innerText ?? ""), id, { timeout: ms });

const b = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone"], ignoreHTTPSErrors: true });
// a browser with no speech recognizer of its own (Firefox, the Linux app)
await ctx.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
await ctx.route(/huggingface\.co/, route => route.continue({ url: SERVED + new URL(route.request().url()).pathname }));
const calls = []; let reply = "ok";
await ctx.route(API, route => {
  const body = JSON.parse(route.request().postData() || "{}"); calls.push(body);
  const last = body.messages[body.messages.length - 1], text = typeof last.content === "string" ? last.content : last.content.find(x => x.type === "text").text;
  const out = /single word OK/.test(text) ? "OK" : reply;
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ choices: [{ delta: { content: out } }] })}\n\ndata: [DONE]\n\n` });
});
const p = await ctx.newPage();
const errors = []; p.on("pageerror", e => errors.push(String(e)));
const fetched = []; p.on("request", r => fetched.push(r.url()));

// ---- the card on the shelf: once ----
await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
await p.locator(".setupcard").waitFor({ timeout: 3000 }).catch(() => fail("no setup card on the shelf"));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/firstrun_card.png` });
await p.getByRole("button", { name: "Not now" }).click();
await p.reload(); await p.locator(".shelf").waitFor();
if (await p.locator(".setupcard").count()) fail("the card came back after Not now");
if (fetched.some(u => /huggingface|ort-wasm|embed\.worker|whisper\.worker/.test(u))) fail("model code or files were fetched before anything was asked for");
await p.evaluate(() => localStorage.removeItem("vicaria.setup.seen"));
await p.reload(); await p.locator(".setupcard").waitFor();
await p.getByRole("button", { name: "Choose" }).click();
await p.waitForURL(/\/settings#device/);
await p.locator("#device").waitFor();
await p.waitForFunction(() => { const r = document.getElementById("device").getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; }, null, { timeout: 3000 }).catch(() => fail("Choose did not scroll to On this device"));
await p.goto(BASE + "/"); await p.locator(".shelf").waitFor();
if (await p.locator(".setupcard").count()) fail("the card came back after Choose");

// ---- threads: the page is isolated from the second load on, and other sites' pictures still load ----
await ctx.route("https://covers.example.test/**", route => route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64") }));
await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => fail("the service worker does not control the page"));
await p.reload(); await p.locator(".shelf").waitFor();
if (!await p.evaluate(() => crossOriginIsolated)) fail("the page is not cross-origin isolated after a reload");
const covered = await p.evaluate(() => new Promise(ok => { const i = new Image(); i.onload = () => ok(i.naturalWidth); i.onerror = () => ok(-1); i.src = "https://covers.example.test/c.png"; }));
if (covered !== 2) fail(`a cover from another site did not load under isolation (${covered})`);
if (SHOTS) await p.screenshot({ path: `${SHOTS}/firstrun_after_isolation.png` });

// ---- the list in Settings ----
await p.goto(BASE + "/settings#device"); await p.locator("#device").waitFor();
for (const id of ["voice-en", "voice-es", "search", "speech"]) if (!await row(p, id).count()) fail(`no row for ${id}`);
const txt = await row(p, "search").innerText();
if (!/Search by meaning/.test(txt) || !/\b3(2\d|3\d) MB\b/.test(txt) || !/Download/.test(txt)) fail(`search row: ${txt.replace(/\n/g, " | ")}`);
await p.waitForFunction(() => /No model files are on this device/.test(document.querySelector("[data-used]")?.innerText ?? ""), null, { timeout: 3000 }).catch(() => fail("space used before any download"));

// pause and resume midway (the speech model, held back so there is time to tap)
slow = 700;
await row(p, "speech").getByRole("button", { name: "Download" }).click();
await row(p, "speech").getByRole("button", { name: "Pause" }).waitFor({ timeout: 8000 }).catch(() => fail("no Pause button while downloading"));
await row(p, "speech").locator("progress").waitFor({ timeout: 5000 }).catch(() => fail("no progress bar while downloading"));
await row(p, "speech").getByRole("button", { name: "Pause" }).click();
await row(p, "speech").getByRole("button", { name: /Resume|Download/ }).waitFor({ timeout: 5000 }).catch(() => fail("no Resume after Pause"));
if (/On this device/.test(await row(p, "speech").innerText())) fail("a paused model shows as done");
slow = 0;
await row(p, "speech").getByRole("button", { name: /Resume|Download/ }).click();
await settle(p, "speech", 120000).catch(() => fail("speech model did not finish after Resume"));
await row(p, "search").getByRole("button", { name: "Download" }).click();
await settle(p, "search", 120000).catch(() => fail("search model did not finish"));
// the two models are about 410 MB together
await p.waitForFunction(() => /use (4[01]\d) MB/.test(document.querySelector("[data-used]")?.innerText ?? ""), null, { timeout: 5000 }).catch(async () => fail(`space used not the two models' size: ${await p.locator("[data-used]").innerText()}`));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/firstrun_settings.png`, fullPage: true });

// ---- dictation by Whisper ----
const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
await p.goto(BASE + "/settings#ai");
await p.getByLabel("Provider").selectOption({ label: "DeepSeek" }); await p.getByLabel("DeepSeek API key").fill("sk-mock-not-a-real-key"); await p.getByRole("button", { name: "Add key" }).click();
await p.getByText("DeepSeek accepted the key.").waitFor({ timeout: 5000 });
await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
await p.getByRole("button", { name: "Ask about this book" }).click();
const mic = p.getByRole("button", { name: "Dictate" });
await mic.waitFor({ timeout: 5000 }).catch(() => {});
if (!await mic.count()) fail("no dictation button in a browser without a recognizer");
else {
  await mic.click(); await p.getByRole("button", { name: "Stop dictation" }).waitFor({ timeout: 5000 }).catch(() => fail("recording did not start"));
  await p.waitForTimeout(4500); // the recording is the 3 second fixture, then silence
  await p.getByRole("button", { name: "Stop dictation" }).click();
  await p.waitForFunction(() => /anger/i.test(document.querySelector('textarea[aria-label="Question"]')?.value ?? ""), null, { timeout: 120000 })
    .catch(async () => fail(`dictation did not write the question: "${await p.getByLabel("Question").inputValue()}"`));
  if (!/marcus/i.test(await p.getByLabel("Question").inputValue())) console.error("note: the name was not recognised: " + await p.getByLabel("Question").inputValue());
}

// ---- search by meaning ----
// Book XII of Meditations, a question in Spanish about the English text: no word is shared, so only meaning finds it.
const Q = process.env.VIC_Q || "¿Qué dice sobre morir sin miedo?", SEC = 13;
const ask = async () => {
  await p.goto(`${BASE}/book/${id}?s=${SEC}&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  await p.getByRole("button", { name: "Ask about this book" }).click();
  await p.getByLabel("Question").fill(Q);
  const n = calls.length; await p.getByLabel("Question").press("Enter");
  await p.waitForFunction(() => document.querySelector(".turn.ai .answer"), null, { timeout: 20000 }).catch(() => fail("no answer"));
  const last = calls[calls.length - 1];
  if (calls.length === n) fail("no request was made");
  const body = last.messages.at(-1).content, text = typeof body === "string" ? body : body.find(x => x.type === "text").text;
  return text.split(/\n(?=\[\d+\.\d+\])/).slice(1).map(x => /^\[(\d+\.\d+)\]\s*([\s\S]*)/.exec(x)).filter(Boolean).map(m => ({ id: m[1], text: m[2] }));
};
await p.goto(`${BASE}/book/${id}?s=${SEC}&b=0`); await p.getByRole("button", { name: "Ask about this book" }).click();
await p.locator("[data-embed]").waitFor({ timeout: 30000 }).catch(() => fail("the book was not read for search by meaning"));
await p.waitForFunction(() => document.querySelector("[data-embed]")?.getAttribute("data-embed") === "done", null, { timeout: 600000 }).catch(() => fail("reading the book for search did not finish"));
const withSearch = await ask();
// two passages about dying, in other books, that share no word with the question
const WANT = ["10.21", "4.3"], got = id => withSearch.some(x => x.id === id);
for (const w of WANT) if (!got(w)) fail(`by meaning, passage ${w} was not sent (${withSearch.map(x => x.id).join(" ")})`);
if (withSearch.length > 40) fail(`${withSearch.length} passages sent`);
if (errors.length) fail(`page errors: ${errors[0]}`);

// the same question on a device without the model: those passages are not found by words
const ctx2 = await b.newContext({ viewport: { width: 1280, height: 860 } });
await ctx2.route(API, route => {
  const body = JSON.parse(route.request().postData() || "{}"); calls.push(body);
  const t = body.messages.at(-1).content;
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ choices: [{ delta: { content: /single word OK/.test(String(t)) ? "OK" : "ok" } }] })}\n\ndata: [DONE]\n\n` });
});
const p2 = await ctx2.newPage();
await p2.goto(BASE + "/"); await p2.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
await p2.goto(BASE + "/settings#ai"); await p2.getByLabel("Provider").selectOption({ label: "DeepSeek" }); await p2.getByLabel("DeepSeek API key").fill("sk-mock-not-a-real-key"); await p2.getByRole("button", { name: "Add key" }).click();
await p2.getByText("DeepSeek accepted the key.").waitFor({ timeout: 5000 });
await p2.goto(`${BASE}/book/${id}?s=${SEC}&b=0`); await p2.getByRole("button", { name: "Ask about this book" }).click();
await p2.getByLabel("Question").fill(Q); await p2.getByLabel("Question").press("Enter");
await p2.waitForFunction(() => document.querySelector(".turn.ai .answer"), null, { timeout: 20000 }).catch(() => fail("no answer without the model"));
const plain = JSON.stringify(calls.at(-1).messages.at(-1).content);
for (const w of WANT) if (plain.includes(`[${w}]`)) fail(`without the model, passage ${w} was sent anyway (the test would prove nothing)`);
if (await p2.locator("[data-embed]").count()) fail("a device without the model shows search progress");
await b.close(); server.close(); rmSync(tls, { recursive: true, force: true });
console.log(failures.length ? `firstrun e2e FAILED: ${failures.join(" | ")}` : "firstrun e2e passed");

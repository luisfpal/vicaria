// End to end: read a book aloud. Listening starts at once with the device voice (a stand-in that records what it is
// asked to say), highlights the sentence and keeps it on screen; the clearer voice downloads in the background,
// survives a reload in the middle of the download (resumes from where it stopped), then takes over and keeps working
// offline. At the end of a section reading carries on into the next. Lock screen controls are set. Desktop and phone.
// Model files are served from VIC_MODELS (a folder with the Piper and espeak-ng files) through a slow local server.
// Usage: node e2e/listen.e2e.mjs [baseUrl] [shotsDir]
import { chromium } from "playwright";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || ""; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const MODELS = process.env.VIC_MODELS || new URL("../../../models/piper", import.meta.url).pathname;
const failures = [];
const fail = m => { console.error("FAIL " + m); failures.push(m); process.exitCode = 1; };
process.on("exit", () => { if (failures.length) console.error(`failures (${failures.length}): ${failures.join(" || ")}`); });
if (!existsSync(`${MODELS}/en_US-lessac-medium.onnx`)) { console.error(`no model files in ${MODELS}`); process.exit(1); }

// model files, with Range requests; the first response for the voice is cut at 30%, as a dropped connection would
const ranges = []; let cut = true;
async function serveModel(route) {
  const name = decodeURIComponent(route.request().url().split("/").pop()), file = `${MODELS}/${name}`;
  if (!existsSync(file)) return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "" });
  const all = readFileSync(file), m = /bytes=(\d+)-/.exec(route.request().headers().range || ""), from = m ? +m[1] : 0;
  ranges.push(`${name}:${from}`);
  const headers = { "access-control-allow-origin": "*", "content-type": "application/octet-stream" };
  if (cut && name.endsWith(".onnx")) { cut = false; return route.fulfill({ status: 200, headers: { ...headers, "content-length": String(all.length) }, body: all.subarray(0, Math.floor(all.length * 0.3)) }); }
  return route.fulfill({ status: m ? 206 : 200, headers: { ...headers, ...(m ? { "content-range": `bytes ${from}-${all.length - 1}/${all.length}` } : {}) }, body: all.subarray(from) });
}

// the device voice: speaks each sentence for a moment and records it
const fakeSpeech = () => {
  window.__said = [];
  const voices = [{ name: "Daniel", lang: "en-GB", localService: true, default: true }, { name: "Samantha (Enhanced)", lang: "en-US", localService: true }];
  let cur = null, timer = 0;
  const s = {
    getVoices: () => voices, speaking: false, pending: false, paused: false,
    speak(u) { cur = u; window.__said.push({ text: u.text, voice: u.voice?.name, rate: u.rate }); timer = setTimeout(() => { cur = null; u.onend?.({}); }, 120); },
    cancel() { clearTimeout(timer); const u = cur; cur = null; u?.onerror?.({ error: "interrupted" }); }, pause() {}, resume() {},
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: s, configurable: true });
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.rate = 1; } };
};

const b = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: label === "phone" ? 3 : 1, hasTouch: label === "phone" });
  await ctx.addInitScript(fakeSpeech);
  await ctx.route(/huggingface\.co|cdn\.jsdelivr\.net/, serveModel); cut = true; ranges.length = 0;
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  const fetched = []; p.on("request", r => fetched.push(r.url()));
  await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  if (fetched.some(u => /voice\.worker|ort-wasm|piper|huggingface/.test(u))) fail(`${label}: voice code or models fetched before Listen`);

  // first listen: device voice at once, best voice for the book's language, sentence highlighted
  const t0 = Date.now();
  await p.getByRole("button", { name: "Listen", exact: true }).click();
  await p.locator(".listenbar").waitFor({ timeout: 5000 }).catch(() => fail(`${label}: no reading-aloud bar`));
  await p.waitForFunction(() => window.__said.length > 0, null, { timeout: 5000 }).catch(() => fail(`${label}: nothing was read`));
  const firstMs = Date.now() - t0;
  const said = await p.evaluate(() => window.__said.slice(0, 3));
  const topText = await p.evaluate(() => { for (const x of document.querySelectorAll(".prose [data-b]")) if (x.getBoundingClientRect().bottom > 80 && x.textContent.trim()) return x.textContent.trim().slice(0, 30); });
  if (!said[0] || !topText?.startsWith(said[0].text.trim().slice(0, 12))) fail(`${label}: reading did not start where the reader is ("${said[0]?.text.slice(0, 40)}" vs "${topText}")`);
  // the book is British English: a high quality US voice beats the plain British default
  if (said[0]?.voice !== "Samantha (Enhanced)") fail(`${label}: not the best device voice (${said[0]?.voice})`);
  const [hl, saidNow] = await p.evaluate(() => [CSS.highlights?.has("vic-speaking") && [...CSS.highlights.get("vic-speaking")][0].toString(), window.__said]);
  if (!hl || !saidNow.slice(-2).some(s => s.text.trim().startsWith(hl.trim().slice(0, 15)))) fail(`${label}: the sentence read is not highlighted (${String(hl).slice(0, 40)})`);
  const status = () => p.locator(".listenbar .lstatus").innerText();
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/listen_${label}_device.png` });

  // controls: pause stops the voice, play goes on from the same sentence, speed changes the rate
  await p.getByRole("button", { name: "Pause", exact: true }).click(); const n0 = await p.evaluate(() => window.__said.length);
  await p.waitForTimeout(500); if (await p.evaluate(() => window.__said.length) !== n0) fail(`${label}: pause did not stop reading`);
  await p.getByRole("button", { name: "Speed" }).click(); await p.getByRole("button", { name: "Play", exact: true }).click();
  await p.waitForFunction(n => window.__said.length > n, n0, { timeout: 3000 }).catch(() => fail(`${label}: play did not go on`));
  const resumed = await p.evaluate(n => window.__said[n], n0);
  if (resumed?.rate !== 1.25) fail(`${label}: speed not applied (${resumed?.rate})`);
  const ms = await p.evaluate(() => navigator.mediaSession.metadata && { title: navigator.mediaSession.metadata.title, album: navigator.mediaSession.metadata.album });
  if (!ms || !/Meditations/i.test(ms.album)) fail(`${label}: lock screen controls not set (${JSON.stringify(ms)})`);

  // the clearer voice downloads by itself after the first listen. The connection drops at 30%: the download goes on
  // from there (a range request), not from zero. A reload while it downloads resumes it too.
  await p.waitForFunction(() => /downloading/.test(document.querySelector(".listenbar .lstatus")?.textContent || ""), null, { timeout: 20000 }).catch(async () => fail(`${label}: the voice download did not start (${await status()})`));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/listen_${label}_downloading.png` });
  const pct = Number((/(\d+)%/.exec(await status()) || [])[1] ?? 100);
  const before = ranges.length;
  await p.reload(); await p.locator(".prose [data-b]").first().waitFor();
  await p.getByRole("button", { name: "Listen", exact: true }).click();
  // wait for the download to finish (the bar says which voice reads)
  const tDl = Date.now();
  await p.waitForFunction(() => { const s = document.querySelector(".listenbar .lstatus")?.textContent || ""; return !/downloading|waits|Clearer/.test(s); }, null, { timeout: 120000 }).catch(async () => fail(`${label}: the voice did not finish downloading (${await status()})`));
  const onnx = ranges.filter(r => r.startsWith("en_US-lessac-medium.onnx:"));
  if (!onnx.slice(1).length || onnx.slice(1).some(r => r.endsWith(":0"))) fail(`${label}: the voice was downloaded again from the start (${onnx.join(",")})`);
  const afterReload = ranges.slice(before).filter(r => r.startsWith("en_US-lessac-medium.onnx:"));
  console.log(`${label}: voice file requests ${onnx.map(r => r.split(":")[1]).join(", ")} (bytes from); reloaded at ${pct}%, ${afterReload.length ? `resumed at ${afterReload[0].split(":")[1]}` : "voice file already complete"}`);
  ranges.length = 0;
  // the neural voice takes over at a following sentence
  await p.waitForFunction(() => document.querySelector(".listenbar .lstatus")?.textContent === "Vicaria voice", null, { timeout: 30000 }).catch(async () => fail(`${label}: the neural voice did not take over (${await status()})`));
  const hl1 = await p.evaluate(() => [...(CSS.highlights.get("vic-speaking") || [])][0]?.toString());
  await p.waitForFunction(h => { const x = [...(CSS.highlights.get("vic-speaking") || [])][0]?.toString(); return x && x !== h; }, hl1, { timeout: 25000 }).catch(() => fail(`${label}: the neural voice does not move through the text`));
  console.log(`${label}: first sound after ${firstMs} ms with the device voice; the clearer voice ready ${Math.round((Date.now() - tDl) / 1000)} s after the reload`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/listen_${label}_neural.png` });

  // offline: reload with no network, the neural voice still reads
  await p.getByRole("button", { name: "Stop reading aloud" }).click();
  await ctx.setOffline(true);
  await p.reload(); await p.locator(".prose [data-b]").first().waitFor({ timeout: 15000 });
  await p.getByRole("button", { name: "Listen", exact: true }).click();
  await p.waitForFunction(() => document.querySelector(".listenbar .lstatus")?.textContent === "Vicaria voice", null, { timeout: 30000 }).catch(async () => fail(`${label}: offline, the neural voice does not read (${await status()})`));
  await p.getByRole("button", { name: "Stop reading aloud" }).click();
  await ctx.setOffline(false);

  // end of a section: starting at its last block, reading carries on into the next section (device voice)
  await p.evaluate(async () => { const r = await navigator.storage.getDirectory(); await r.removeEntry("models", { recursive: true }).catch(() => {}); localStorage.removeItem("vicaria.models.wanted"); });
  await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  const last = await p.evaluate(() => { const bs = [...document.querySelectorAll(".prose [data-b]")].filter(x => x.textContent.trim()); const l = bs.at(-1); const pad = document.createElement("div"); pad.style.height = "200vh"; document.body.append(pad); /* a short section (fonts differ by machine) must still be scrollable to its last block */ l.scrollIntoView({ block: "start" }); scrollBy(0, -60); return +l.dataset.b; });
  await p.getByRole("button", { name: "Listen", exact: true }).click();
  await p.waitForURL(/[?&]s=4/, { timeout: 30000 }).catch(() => fail(`${label}: reading did not carry on into the next section`));
  await p.waitForFunction(() => window.__said.length > 2, null, { timeout: 5000 }).catch(() => {});
  const lastSaid = await p.evaluate(() => window.__said.at(-1)?.text.trim().slice(0, 25)); const secText = await p.evaluate(() => document.querySelector(".prose").textContent.replace(/\s+/g, " "));
  if (!lastSaid || !secText.includes(lastSaid.replace(/\s+/g, " "))) fail(`${label}: after the section ended, the next section is not what is read ("${lastSaid}")`);
  await p.getByRole("button", { name: "Stop reading aloud" }).click();
  void last;
  if (errors.length) fail(`${label}: page errors: ${errors.join(" | ").slice(0, 300)}`);
  await ctx.close();
}
// a device with no speech engine at all (Android's WebView has no speechSynthesis): one tap on Listen fetches the
// clearer voice, and reading starts by itself once it is on the device, from the sentence the reader is at
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true });
  await ctx.addInitScript(() => { delete window.speechSynthesis; delete window.SpeechSynthesisUtterance; });
  await ctx.route(/huggingface\.co|cdn\.jsdelivr\.net/, serveModel); cut = false;
  const p = await ctx.newPage(); const errors = []; p.on("pageerror", e => errors.push(String(e)));
  await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  await p.goto(`${BASE}/book/${id}?s=3&b=0`); await p.locator(".prose [data-b]").first().waitFor();
  if (await p.evaluate(() => "speechSynthesis" in window)) fail("no-engine: the stand-in still has speechSynthesis");
  await p.getByRole("button", { name: "Listen", exact: true }).click();
  const st = () => p.locator(".listenbar .lstatus").innerText();
  await p.waitForFunction(() => document.querySelector(".listenbar .lstatus")?.textContent === "Vicaria voice" && document.querySelector(".listenbar .play")?.getAttribute("aria-label") === "Pause", null, { timeout: 120000 }).catch(async () => fail(`no-engine: reading did not start by itself with the clearer voice (${await st()})`));
  const h0 = await p.evaluate(() => [...(CSS.highlights.get("vic-speaking") || [])][0]?.toString());
  await p.waitForFunction(h => { const x = [...(CSS.highlights.get("vic-speaking") || [])][0]?.toString(); return x && x !== h; }, h0, { timeout: 25000 }).catch(() => fail("no-engine: the clearer voice does not move through the text"));
  if (errors.length) fail(`no-engine: page errors: ${errors.join(" | ").slice(0, 300)}`);
  console.log("no speech engine: one tap on Listen, the clearer voice downloaded and read on by itself");
  await ctx.close();
}
await b.close();
console.log(process.exitCode ? "listen e2e FAILED" : "listen e2e passed");

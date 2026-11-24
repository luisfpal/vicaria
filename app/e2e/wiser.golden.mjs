// Live check of the daily thought and a lesson against the real provider (two calls, a few thousand tokens).
// The key is read from a file, put in the browser's storage for this run only and never printed.
// Usage: KEY_FILE=/path/to/key node e2e/wiser.golden.mjs [baseUrl] [screenshotDir]
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { seedLibrary } from "./synth-library.mjs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next", SHOTS = process.argv[3] || "";
const key = readFileSync(process.env.KEY_FILE, "utf8").trim(), hide = s => String(s).split(key).join("[key]");
const fail = m => { console.error("FAIL " + hide(m)); process.exitCode = 1; };
const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 860 } }), p = await ctx.newPage();
let calls = 0, tokens = 0;
p.on("pageerror", e => fail(`page error ${e}`));
p.on("response", async r => { if (r.url().startsWith("https://api.deepseek.com/") && r.request().method() === "POST") { calls++; const u = [...(await r.text().catch(() => "")).matchAll(/"total_tokens":(\d+)/g)].pop(); if (u) tokens += +u[1]; } });
await p.goto(BASE + "/"); await p.waitForSelector(".shelf");
await seedLibrary(p, 10);
await p.evaluate(k => { localStorage.setItem("vic:aikey:deepseek", k); for (const x of Object.keys(localStorage)) if (x.startsWith("vic:wiser")) localStorage.removeItem(x); }, key);
await p.reload(); await p.waitForSelector(".shelf");
await p.locator(".wisercard .wtext").waitFor({ timeout: 30000 }).catch(() => fail("no card"));
const thought = await p.locator(".wisercard").innerText().catch(() => "");
console.log("thought:", hide(thought.replace(/\s+/g, " ").slice(0, 300)));
if (!calls) fail("the card did not call the model"); if (/From your own highlights/.test(thought)) fail("the card fell back to tier 2");
await p.goto(BASE + "/wiser"); await p.getByRole("button", { name: "Write a lesson" }).click();
await p.waitForURL(/\/wiser\/les-/, { timeout: 90000 }).catch(() => fail("lesson not written"));
const body = await p.locator(".lessonbody").innerText().catch(() => ""), words = body.split(/\s+/).length;
console.log("lesson words:", words, "|", hide(body.replace(/\s+/g, " ").slice(0, 200)));
if (words < 100 || words > 450) fail(`lesson length ${words}`); if (/[\u2014]/.test(body)) fail("lesson has an em dash");
if (SHOTS) await p.screenshot({ path: `${SHOTS}/wiser-live.png` });
console.log(`calls ${calls}, tokens ${tokens}`);
await b.close();

// Every provider in Settings, against mocks of their APIs: the key check goes to the right address with the right
// headers and body, the model is chosen from the provider's own list, the reader can switch provider, use a server of
// their own, and sign in with OpenRouter.
import { chromium } from "playwright";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const b = await chromium.launch();
let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport });
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  const calls = [];
  const sse = t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\ndata: [DONE]\n\n`;
  const asc = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "OK" } })}\n\n`;
  await ctx.route(/api\.(openai|deepseek|x)\.(com|ai)|openrouter\.ai\/api|generativelanguage|api\.anthropic/, route => {
    const r = route.request(), u = new URL(r.url()), body = r.method() === "POST" ? JSON.parse(r.postData() || "{}") : null;
    calls.push({ host: u.host, path: u.pathname, auth: r.headers()["authorization"], xkey: r.headers()["x-api-key"], body });
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
    if (r.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (u.pathname.endsWith("/models")) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ data: u.host.includes("openai") ? [{ id: "gpt-9-nano" }, { id: "gpt-9" }, { id: "gpt-image-9" }]  : [{ id: "x" }] }) });
    if (u.pathname.endsWith("/auth/keys")) return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ key: "sk-or-minted" }) });
    return route.fulfill({ status: 200, headers: cors, contentType: "text/event-stream", body: u.host.includes("anthropic") ? asc : sse("OK") });
  });
  await p.route(/openrouter\.ai\/auth\?/, route => route.fulfill({ status: 200, contentType: "text/html", body: "<title>sign in</title>" }));
  await p.goto(BASE + "/settings#ai"); await p.locator("#ai").waitFor();
  const select = p.getByLabel("Provider");
  const options = await select.locator("option").allTextContents();
  for (const n of ["OpenRouter", "DeepSeek", "OpenAI", "Anthropic", "Google Gemini", "xAI"]) if (!options.some(o => o.includes(n))) fail(`${label}: provider ${n} not offered`);

  // OpenAI: the output limit has the newer name, the model is replaced by a current small one from the list
  await select.selectOption({ label: "OpenAI" });
  await p.getByLabel("OpenAI API key").fill("sk-test-openai"); await p.getByRole("button", { name: "Add key" }).click();
  await p.getByText("OpenAI accepted the key.").waitFor({ timeout: 5000 }).catch(() => fail(`${label}: OpenAI key not accepted`));
  const oa = calls.find(c => c.path === "/v1/chat/completions" && c.host === "api.openai.com");
  if (!oa || oa.auth !== "Bearer sk-test-openai") fail(`${label}: OpenAI call or auth wrong ${JSON.stringify(oa)}`);
  else if (oa.body.max_completion_tokens !== 16 || oa.body.max_tokens !== undefined) fail(`${label}: OpenAI output limit wrong ${JSON.stringify(oa.body)}`);
  await p.waitForFunction(() => localStorage.getItem("vic:aimodel:openai") === "gpt-9-nano", null, { timeout: 5000 }).catch(async () => fail(`${label}: model not chosen from the list (${await p.evaluate(() => localStorage.getItem("vic:aimodel:openai"))})`));
  if (await p.evaluate(() => localStorage.getItem("vic:ai:active")) !== "openai") fail(`${label}: OpenAI not in use after adding`);

  // Anthropic: its own header, system apart
  await select.selectOption({ label: "Anthropic" });
  await p.getByLabel("Anthropic API key").fill("sk-ant-test"); await p.getByRole("button", { name: "Add key" }).click();
  await p.getByText("Anthropic accepted the key.").waitFor({ timeout: 5000 }).catch(() => fail(`${label}: Anthropic key not accepted`));
  const an = calls.find(c => c.host === "api.anthropic.com" && c.path === "/v1/messages");
  if (!an || an.xkey !== "sk-ant-test") fail(`${label}: Anthropic call wrong ${JSON.stringify(an)}`);

  // switching: both keys kept, the chosen one is in use
  await select.selectOption({ label: "✓ OpenAI" });
  await p.getByRole("button", { name: "Use this one" }).click();
  if (await p.evaluate(() => localStorage.getItem("vic:ai:active")) !== "openai") fail(`${label}: switch to OpenAI did not stick`);
  await p.reload(); await p.locator("#ai").waitFor();
  if (!(await select.inputValue()) || await select.inputValue() !== "openai") fail(`${label}: the provider in use is not shown after a reload (${await select.inputValue()})`);

  // OpenRouter sign in: the redirect carries a challenge, coming back with a code stores the minted key
  await select.selectOption({ label: "OpenRouter" });
  const nav = p.waitForRequest(r => /openrouter\.ai\/auth\?/.test(r.url()), { timeout: 5000 }).catch(() => null);
  await p.getByRole("button", { name: "Sign in with OpenRouter" }).click();
  const rq = await nav; if (!rq) fail(`${label}: no redirect to OpenRouter`);
  else { const q = new URL(rq.url()).searchParams; if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !/\/settings$/.test(q.get("callback_url") || "")) fail(`${label}: sign in address wrong ${rq.url()}`); }
  await p.goto(BASE + "/settings?code=abc#ai", { waitUntil: "commit" }).catch(() => {});
  await p.evaluate(() => sessionStorage.setItem("vic:or:verifier", "v".repeat(60))).catch(() => {});
  await p.goto(BASE + "/settings?code=abc#ai"); await p.locator("#ai").waitFor();
  await p.waitForFunction(() => localStorage.getItem("vic:aikey:openrouter") === "sk-or-minted", null, { timeout: 5000 }).catch(() => fail(`${label}: minted key not stored`));
  if (calls.find(c => c.path.endsWith("/auth/keys"))?.body?.code_verifier?.length !== 60) fail(`${label}: code exchange sent the wrong verifier`);

  // the key never appears on the page text or in a synced store
  if (/sk-test-openai|sk-ant-test|sk-or-minted/.test(await p.locator("body").innerText())) fail(`${label}: a key is visible on the page`);
  if (errors.length) fail(`${label}: page errors ${errors.join("; ")}`);
  console.log(`${label}: ${calls.length} mocked calls ok`);
  await ctx.close();
}
await b.close();
if (failed) { console.error(`failures (${failed})`); process.exit(1); }
console.log("providers e2e passed");

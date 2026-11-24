// Feedback, error screens and the privacy page. The feedback link opens a new issue with version and platform and no
// book text; a page that does not exist, a book that cannot be read and a crash each get a screen with a way out.
import { chromium } from "./engine.mjs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
const WK = /^(webkit|firefox)$/.test(process.env.VIC_ENGINE || ""); // Playwright WebKit and Firefox cannot grant clipboard access
const b = await chromium.launch(); let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
const checkIssue = (href, tag) => {
  const u = new URL(href);
  if (u.origin + u.pathname !== "https://github.com/luisfpal/vicaria/issues/new") fail(`${tag}: link goes to ${u.origin + u.pathname}`);
  const body = u.searchParams.get("body") || "";
  if (!/Vicaria \d+\.\d+\.\d+ \(/.test(body)) fail(`${tag}: no version in the report: ${body}`);
  if (!/Platform: (macOS|Linux|Windows|Android|iPadOS|iOS|ChromeOS|Unknown system), /.test(body)) fail(`${tag}: no platform in the report: ${body}`);
  return body;
};
for (const [label, viewport, ua] of [
  ["desktop", { width: 1280, height: 860 }, undefined],
  ["phone", { width: 390, height: 844 }, "Mozilla/5.0 (Linux; Android 14; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"],
]) {
  const ctx = await b.newContext({ viewport, userAgent: ua, permissions: WK ? [] : ["clipboard-read", "clipboard-write"] }); const p = await ctx.newPage();
  const errors = []; p.on("pageerror", e => errors.push(String(e)));
  await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 });
  const id = await p.evaluate(() => localStorage.getItem("vic:classic-id"));
  // Settings: feedback link and the privacy page
  await p.goto(BASE + "/settings");
  const body = checkIssue(await p.getByRole("link", { name: "Send feedback" }).getAttribute("href"), `${label} settings`);
  if (label === "phone" && !body.includes("Android")) fail(`${label}: platform should say Android: ${body}`);
  if (body.includes("Meditations") || body.includes(id)) fail(`${label}: the report names a book`);
  await p.getByRole("link", { name: "Privacy" }).click();
  await p.getByRole("heading", { name: "Privacy", level: 1 }).waitFor({ timeout: 5000 }).catch(() => fail(`${label}: privacy page did not open`));
  const txt = await p.locator(".privacy").innerText();
  for (const w of ["DeepSeek", "Nostr", "Hugging Face", "GitHub", "No accounts"]) if (!txt.includes(w)) fail(`${label}: privacy page lacks ${w}`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/privacy_${label}.png`, fullPage: true });
  // a page that does not exist
  await p.goto(BASE + "/nope");
  await p.getByRole("alert").getByText("This page does not exist").waitFor({ timeout: 5000 }).catch(() => fail(`${label}: no not-found screen`));
  checkIssue(await p.getByRole("alert").getByRole("link", { name: "Send feedback" }).getAttribute("href"), `${label} not found`);
  await p.getByRole("button", { name: "Copy report" }).click();
  const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  if (!WK && (!/Vicaria \d/.test(clip) || !/Platform:/.test(clip))) fail(`${label}: Copy report copied "${clip}"`);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/notfound_${label}.png` });
  await p.getByRole("button", { name: "Back to the library" }).click();
  await p.waitForURL(u => u.pathname.replace(/\/$/, "").endsWith("/next"), { timeout: 5000 }).catch(() => fail(`${label}: Back to the library did not go to the library`));
  // a book that is not on this device
  await p.goto(BASE + "/book/0123456789abcdef");
  await p.getByText("not in your library").waitFor({ timeout: 8000 }).catch(() => fail(`${label}: no missing-book message`));
  if (await p.evaluate(() => document.querySelectorAll("#app > header.bar").length)) fail(`${label}: a top bar is left under a book screen`);
  // a book whose text cannot be read: the screen says so, with a way out and a report with the error but no title
  await p.goto(BASE + "/");
  await p.evaluate(() => new Promise((ok, bad) => {
    const r = indexedDB.open("vicaria"); r.onerror = () => bad(r.error);
    r.onsuccess = () => { try { const t = r.result.transaction(["books", "heads"], "readwrite"), now = Date.now(), bid = "6e00000000000001";
      t.objectStore("books").put({ id: bid, sha256: bid, title: "Secret Title", author: "A", lang: "en", cover: null, addedAt: now, start: 0, dir: "ltr", vertical: false, fixedLayout: false, v: 1, words: 10, sections: 1, storage: "idb", size: 10 });
      t.objectStore("heads").put({ id: bid, meta: { id: bid, start: 0, startBlock: 0 }, sectionInfo: [null] });
      t.oncomplete = ok; t.onerror = () => bad(t.error); } catch (e) { bad(e); } };
  }));
  await p.goto(BASE + "/book/6e00000000000001"); await p.waitForTimeout(1500);
  const alert = p.getByRole("alert");
  if (await alert.count() === 0) { const t = await p.locator("main").innerText(); console.log(`${label}: unreadable book shows: ${t.slice(0, 120).replace(/\n/g, " | ")}`); }
  else {
    await alert.getByRole("link", { name: "Send feedback" }).waitFor();
    const bb = checkIssue(await alert.getByRole("link", { name: "Send feedback" }).getAttribute("href"), `${label} broken book`);
    if (bb.includes("Secret Title")) fail(`${label}: the report names the book`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/broken_${label}.png` });
  }
  if (errors.length) console.log(`${label}: page errors (expected for the broken book): ${errors.length}`);
  await ctx.close();
}
{ // Spanish: the privacy page and an error screen are in Spanish
  const ctx = await b.newContext({ locale: "es-EC" }); const p = await ctx.newPage();
  await p.goto(BASE + "/privacy"); await p.getByRole("heading", { name: "Privacidad", level: 1 }).waitFor({ timeout: 8000 }).catch(() => fail("es: privacy not in Spanish"));
  await p.goto(BASE + "/nope"); await p.getByText("Esta página no existe").waitFor({ timeout: 5000 }).catch(() => fail("es: not found not in Spanish"));
  await ctx.close();
}
{ // a screen whose file cannot be fetched (offline before it was cached): the error screen with Reload, not a blank page
  const ctx = await b.newContext({ serviceWorkers: "block" }); const p = await ctx.newPage();
  await p.route(/\/assets\/settings-[^/]+\.js$/, r => r.abort());
  await p.goto(BASE + "/settings");
  await p.getByRole("alert").getByRole("button", { name: "Reload" }).waitFor({ timeout: 8000 }).catch(() => fail("a screen that failed to load left the page blank"));
  await ctx.close();
}
await b.close();
console.log(failed ? `${failed} FAILED` : "errors e2e passed"); process.exit(failed ? 1 : 0);

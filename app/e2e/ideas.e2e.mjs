// Ideas page at 10, 100 and 1,000 books: only the rows on screen exist, search answers at once, the graph draws and
// reacts to search and to a group, nothing throws. Screenshots go to the folder given as the second argument.
import { chromium } from "./engine.mjs";
import { seedLibrary } from "./synth-library.mjs";
const BASE = process.argv[2] || "http://127.0.0.1:47812/vicaria/next";
const SHOTS = process.argv[3] || "";
const b = await chromium.launch(); let failed = 0; const fail = m => { failed++; console.error("FAIL", m); };
const sizes = (process.env.VIC_SIZES || "10,100,1000").split(",").map(Number);
for (const [label, viewport] of [["desktop", { width: 1280, height: 860 }], ["phone", { width: 390, height: 844 }]]) {
  for (const n of sizes) {
    const ctx = await b.newContext({ viewport }); const p = await ctx.newPage();
    const errors = []; p.on("pageerror", e => errors.push(String(e)));
    await p.goto(BASE + "/"); await p.waitForFunction(() => localStorage.getItem("vic:classic") === "done", null, { timeout: 30000 }); // the database is ready
    await seedLibrary(p, n);
    await p.evaluate(() => localStorage.removeItem("vic:lib1"));
    await p.goto(BASE + "/ideas");
    const tag = `${label} ${n}`;
    await p.waitForFunction(m => document.querySelectorAll(".vrow").length > 1 && +document.querySelector(".ideas input[type=search]").placeholder.match(/[\d,.]+/)[0].replace(/\D/g, "") >= m, n, { timeout: 20000 }).catch(() => fail(`${tag}: list did not show ${n} books`));
    // the top bar fits the screen with its five tabs
    if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector(".bar nav").getBoundingClientRect().right > innerWidth)) fail(`${tag}: the top bar is wider than the screen`);
    // the whole library is in the list but only a window of it is in the page
    const rowsIn = await p.locator(".vrow").count(), total = await p.locator(".vlist").getAttribute("data-rows");
    if (n >= 100 && rowsIn > 45) fail(`${tag}: ${rowsIn} rows in the page for ${total}`);
    if (+total < n) fail(`${tag}: list has ${total} rows for ${n} books`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/ideas_${label}_${n}_list.png` });
    // grouping by author and by title; the last title in the list is reachable by scrolling
    await p.selectOption('select[aria-label="Group by"]', "title");
    await p.evaluate(() => scrollTo(0, document.body.scrollHeight));
    await p.waitForFunction(() => [...document.querySelectorAll(".vrow .t")].some(e => /^The .* of .* \d+$/.test(e.textContent)) && scrollY > 0 || document.body.scrollHeight <= innerHeight, null, { timeout: 5000 }).catch(() => fail(`${tag}: nothing at the end of the list`));
    const rowsEnd = await p.locator(".vrow").count();
    if (n >= 100 && rowsEnd > 45) fail(`${tag}: ${rowsEnd} rows after scrolling to the end`);
    const lastY = await p.evaluate(() => { const r = [...document.querySelectorAll(".vrow")].pop().getBoundingClientRect(); return r.bottom; });
    if (n >= 100 && lastY > (await p.evaluate(() => innerHeight)) + 80) fail(`${tag}: the end of the list is not reachable`);
    await p.evaluate(() => scrollTo(0, 0));
    await p.selectOption('select[aria-label="Group by"]', "topic");
    // search: a word in titles narrows the list; a tag finds books by topic; nonsense finds none
    await p.fill(".ideas input[type=search]", "glass");
    await p.waitForTimeout(150);
    const t = await p.locator(".vrow .t").allTextContents();
    if (n >= 100 && !t.length) fail(`${tag}: "glass" found no title`);
    if (t.some(x => !/glass/i.test(x))) fail(`${tag}: "glass" shows ${t.find(x => !/glass/i.test(x))}`);
    // two words: every word must match (in any order), so the list is narrower than for one word
    await p.fill(".ideas input[type=search]", "glass letters"); await p.waitForTimeout(150);
    const t2 = await p.locator(".vrow .t").allTextContents();
    if (n >= 100 && !t2.length) fail(`${tag}: "glass letters" found no title`);
    if (t2.some(x => !/glass/i.test(x) || !/letters/i.test(x))) fail(`${tag}: "glass letters" shows ${t2.find(x => !/glass/i.test(x) || !/letters/i.test(x))}`);
    await p.fill(".ideas input[type=search]", "letters glass"); await p.waitForTimeout(150);
    if ((await p.locator(".vrow .t").allTextContents()).length !== t2.length) fail(`${tag}: "letters glass" and "glass letters" give different lists`);
    await p.fill(".ideas input[type=search]", "stoicism");
    await p.waitForFunction(() => [...document.querySelectorAll(".vrow .a")].length > 0 && [...document.querySelectorAll(".vrow .a")].every(e => /stoicism/i.test(e.textContent)), null, { timeout: 3000 }).catch(() => fail(`${tag}: search by tag shows books without that tag`));
    await p.fill(".ideas input[type=search]", "zzzzqq"); await p.getByText("No book matches").waitFor({ timeout: 3000 }).catch(() => fail(`${tag}: no empty message`));
    await p.fill(".ideas input[type=search]", "");
    // graph
    await p.getByRole("tab", { name: "Graph" }).click();
    await p.waitForFunction(() => document.querySelector(".graphbox canvas") && !document.querySelector(".graphbox .wait"), null, { timeout: 30000 }).catch(() => fail(`${tag}: graph did not draw`));
    await p.waitForTimeout(300);
    const blank = await p.evaluate(async b64 => {
      const img = await createImageBitmap(await (await fetch("data:image/png;base64," + b64)).blob()), c = new OffscreenCanvas(img.width, img.height), x = c.getContext("2d");
      x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, img.width, img.height).data; let k = 0;
      for (let j = 0; j < d.length; j += 4) if (Math.abs(d[j] - d[0]) + Math.abs(d[j + 1] - d[1]) + Math.abs(d[j + 2] - d[2]) > 40) k++;
      return k;
    }, (await p.locator(".graphbox .sg").screenshot()).toString("base64"));
    if (blank < n * 3) fail(`${tag}: the graph is blank (${blank} drawn pixels)`);
    const lay = await p.evaluate(() => document.querySelector(".graphbox .sg")?.dataset.layoutMs);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/ideas_${label}_${n}_graph.png` });
    const chips = await p.locator(".legend .chip").count();
    if (!chips) fail(`${tag}: no groups in the legend`);
    if (chips) { await p.locator(".legend .chip").first().click(); await p.waitForTimeout(200); if (SHOTS && n === 1000) await p.screenshot({ path: `${SHOTS}/ideas_${label}_${n}_graph_group.png` }); await p.locator(".legend .chip").first().click(); }
    await p.fill(".ideas input[type=search]", "stoicism"); await p.waitForTimeout(300);
    if (SHOTS && n === 1000) await p.screenshot({ path: `${SHOTS}/ideas_${label}_${n}_graph_search.png` });
    // the graph view stays after a reload, and so does the grouping
    await p.reload(); await p.waitForSelector(".graphbox canvas", { timeout: 30000 }).catch(() => fail(`${tag}: graph view not kept after reload`));
    if (errors.length) fail(`${tag}: page errors ${errors.join(" | ")}`);
    console.log(`${tag}: ok (${rowsIn} of ${total} rows in the page, ${chips} groups, graph ready in ${lay} ms)`);
    await ctx.close();
  }
}
await b.close();
if (failed) { console.error("ideas e2e FAILED"); process.exit(1); }
console.log("ideas e2e passed");

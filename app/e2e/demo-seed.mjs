// Builds the demo library the launch screenshots are taken from: about thirty public-domain books from Standard
// Ebooks with their covers, and the traces of a reader who has used the app for a few weeks: highlights in six named
// colours, notes, sticky notes, bookmarks, loved places, reading positions, ideas (tags) that link books, Ask
// conversations and chapter cards.
//
// The books are listed in docs/media/demo-state/books.txt and downloaded on demand. What the reader did is in
// docs/media/demo-state: plan.json (what to mark and ask, written by hand from the books' own sentences), and
// chats.json and cards.json (the answers DeepSeek gave when the state was built with --live). A plain run replays
// those files, so the demo can be rebuilt any time with no key, no network beyond the book downloads, and no spend.
// No key is ever written to demo-state: the key lives in the browser profile only, and the profile is never saved.
//
// Usage:
//   node e2e/demo-seed.mjs <epubDir> <profileDir> [--live <keyFile>] [--base <url>]
//     --live   ask DeepSeek for real (the cheapest model, spend estimate capped at $0.40) and save chats.json and cards.json
//   exported: seedDemo(context, { base, epubDir, live }) for e2e/demo-shots.mjs
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const STATE = join(HERE, "../../docs/media/demo-state");
const read = f => JSON.parse(readFileSync(join(STATE, f), "utf8"));
const slugOf = path => path.replace(/\//g, "_");

// ---- the books ----
export async function fetchBooks(dir) {
  mkdirSync(dir, { recursive: true });
  for (const path of readFileSync(join(STATE, "books.txt"), "utf8").split("\n").filter(Boolean)) {
    const file = join(dir, slugOf(path) + ".epub"); if (existsSync(file)) continue;
    const page = await (await fetch(`https://standardebooks.org/ebooks/${path}`)).text();
    const href = [...page.matchAll(/href="([^"]*\/downloads\/[^"]*\.epub)"/g)].map(m => m[1]).find(h => !/kepub|advanced/.test(h));
    if (!href) throw new Error(`no download link for ${path}`);
    const res = await fetch(`https://standardebooks.org${href}?source=download`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 2).toString() !== "PK") throw new Error(`${path}: not an EPUB`);
    writeFileSync(file, buf);
    await new Promise(r => setTimeout(r, 1000)); // the site asks for politeness
  }
}
const bookFiles = dir => readFileSync(join(STATE, "books.txt"), "utf8").split("\n").filter(Boolean).map(path => {
  const slug = slugOf(path), bytes = readFileSync(join(dir, slug + ".epub"));
  return { slug, name: slug + ".epub", bytes, id: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
});

// ---- in the page: where a sentence sits in a book, and writing ops ----
// Finds `quote` (a sentence copied from the book, maybe with a chapter number stuck to its front) in the book's
// blocks and returns an anchor shaped like the reader's own (block, offsets, exact text, 32 characters either side).
async function locate(page, items) {
  return page.evaluate(async items => {
    const open = () => new Promise((ok, bad) => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    const get = (db, store, key) => new Promise(ok => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => ok(q.result); });
    // letters and digits only, lower case, with where each one sat in the original: punctuation, quote marks and
    // invisible characters differ between the plain text the quotes were copied from and the blocks of the book
    const squash = s => { let out = "", at = []; for (let i = 0; i < s.length; i++) if (/[\p{L}\p{N}]/u.test(s[i])) { out += s[i].toLowerCase(); at.push(i); } return { out, at }; };
    const db = await open(), cache = {}, out = [];
    for (const it of items) {
      const head = cache[it.book] ??= await get(db, "heads", it.book);
      const secs = head.sectionInfo.filter(s => s.kind === "body" || s.kind === "front");
      let found = null;
      const words = it.quote.split(" ");
      for (let skip = 0; skip < Math.min(16, words.length - 4) && !found; skip++) {
        const rest = squash(words.slice(skip).join(" ")).out, probe = rest.slice(0, 40);
        for (const s of secs) {
          const sec = cache[it.book + ":" + s.idx] ??= await get(db, "sections", [it.book, s.idx]);
          for (let b = 0; b < sec.blocks.length && !found; b++) {
            const text = sec.blocks[b], sq = squash(text), i = sq.out.indexOf(probe);
            if (i < 0) continue;
            const j = Math.min(sq.at.length - 1, i + rest.length - 1), from = sq.at[i], to = sq.at[j] + 1;
            found = { section: s.idx, block: b, offset: from, endBlock: b, endOffset: to, exact: text.slice(from, to), prefix: text.slice(Math.max(0, from - 32), from), suffix: text.slice(to, to + 32) };
          }
          if (found) break;
        }
      }
      out.push(found);
    }
    return out;
  }, items);
}
async function bodyOf(page, ids) {
  return page.evaluate(async ids => {
    const db = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); });
    const out = {};
    for (const id of ids) {
      const h = await new Promise(ok => { const q = db.transaction("heads").objectStore("heads").get(id); q.onsuccess = () => ok(q.result); });
      out[id] = h.sectionInfo.filter(s => s.kind === "body" && s.linear && s.blocks >= 12).map(s => ({ idx: s.idx, blocks: s.blocks }));
    }
    return out;
  }, ids);
}
async function writeOps(page, ops) {
  await page.evaluate(ops => new Promise((ok, bad) => {
    const r = indexedDB.open("vicaria"); r.onerror = () => bad(r.error);
    r.onsuccess = () => { const t = r.result.transaction("ops", "readwrite"), s = t.objectStore("ops"); for (const o of ops) s.put(o); t.oncomplete = ok; t.onerror = () => bad(t.error); };
  }), ops);
}

// ---- seeding ----
export async function seedDemo(ctx, { base, epubDir, live = null }) {
  const plan = read("plan.json"), files = bookFiles(epubDir), byslug = Object.fromEntries(files.map(f => [f.slug, f]));
  const keyOf = live?.key;
  const page = await ctx.newPage();
  page.on("pageerror", e => console.error("pageerror", String(e)));
  await page.addInitScript(() => { if (!localStorage.getItem("vic:classic")) localStorage.setItem("vic:classic", "done"); });
  await page.goto(base + "/");
  await page.locator(".lib-tools").waitFor();
  for (let i = 0; i < files.length; i += 6) { // a few at a time: one big upload holds every book in memory twice
    const part = files.slice(i, i + 6);
    await page.locator('input[type="file"]').first().setInputFiles(part.map(f => ({ name: f.name, mimeType: "application/epub+zip", buffer: f.bytes })));
    await page.waitForFunction(n => document.querySelectorAll("a.book-card").length >= n, i + part.length, { timeout: 240000 });
  }
  console.log(`imported ${files.length} books`);
  await page.waitForTimeout(1500);

  const bodies = await bodyOf(page, files.map(f => f.id));
  const day = 3600e3, now = Date.now();
  const ops = []; let n = 0;
  const op = (k, v, book, t) => ops.push({ id: `demo.${++n}`, dev: "demo", t, c: 0, k, v, bk: book });
  const markId = () => `demo.${n + 1}`;

  // highlights, with notes, tags and loved places; sticky notes; bookmarks
  const all = [...plan.highlights.map(h => ({ ...h, kind: "hl" })), ...plan.stickies.map(h => ({ ...h, kind: "sticky" })), ...plan.bookmarks.map(h => ({ ...h, kind: "bm" }))];
  const where = await locate(page, all.map(h => ({ book: byslug[h.slug].id, quote: h.quote })));
  const lastSection = {}, missed = [];
  all.forEach((h, i) => {
    const a = where[i], f = byslug[h.slug];
    if (!a) { missed.push(`${h.slug}: ${h.quote.slice(0, 50)}`); return; }
    lastSection[f.id] = Math.max(lastSection[f.id] ?? 0, a.section);
    const t = now - (h.hoursAgo ?? 6 + (i * 37) % 400) * day;
    const id = markId(), p = 3; // PARSER_VERSION the anchors were found with
    if (h.kind === "hl") {
      op("mark", { id, book: f.id, set: { at: a, color: h.color, made: t }, p, ...(h.note ? { note: h.note, base: null } : {}) }, f.id, t);
      for (const tag of h.tags) op("mark", { id, book: f.id, tag }, f.id, t + 1);
      if (h.loved) op("mark", { id, book: f.id, set: { loved: true } }, f.id, t + 2);
    } else if (h.kind === "sticky") {
      op("mark", { id, book: f.id, set: { at: { ...a, endOffset: a.offset, exact: "" }, sticky: { side: "r", tint: h.tint }, made: t }, p, note: h.text, base: null }, f.id, t);
    } else {
      op("mark", { id, book: f.id, set: { at: { section: a.section, block: a.block, offset: a.offset, exact: "", prefix: a.prefix, suffix: a.exact.slice(0, 32) }, bookmark: { name: h.name }, made: t }, p }, f.id, t);
    }
  });
  if (missed.length) console.warn("not found in the text:\n  " + missed.join("\n  "));

  // reading positions (a reader is at least as far as their last highlight) and when each book was last opened
  const opened = {}, positions = {};
  for (const [slug, b] of Object.entries(plan.books)) {
    const f = byslug[slug], body = bodies[f.id]; if (!body.length) continue;
    let s = body[Math.round(b.pos * (body.length - 1))];
    const hi = body.find(x => x.idx >= (lastSection[f.id] ?? 0)); if (hi && hi.idx > s.idx) s = hi;
    const block = b.pos >= 1 ? s.blocks - 1 : Math.floor(s.blocks * 0.4);
    const total = body.reduce((n, x) => n + x.blocks, 0), before = body.filter(x => x.idx < s.idx).reduce((n, x) => n + x.blocks, 0);
    positions[f.id] = { section: s.idx, block, bodyIdx: body.indexOf(s), of: body.length, progress: Math.round((total ? (before + block) / total : 0) * 1000) / 1000 };
    opened[f.id] = now - b.hoursAgo * day;
    op("pos", { book: f.id, section: s.idx, block }, f.id, opened[f.id]);
  }
  await writeOps(page, ops);
  await page.evaluate(({ plan, opened, positions }) => {
    localStorage.setItem("vic:labels", JSON.stringify(plan.labels));
    localStorage.setItem("vic:opened", JSON.stringify(opened));
    localStorage.setItem("vic:progress", JSON.stringify(Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, p.progress]))));
    for (const [id, p] of Object.entries(positions)) localStorage.setItem("vic:pos:" + id, JSON.stringify({ section: p.section, block: p.block }));
  }, { plan, opened, positions });
  console.log(`wrote ${ops.length} ops (${plan.highlights.length} highlights, ${plan.stickies.length} sticky notes, ${plan.bookmarks.length} bookmarks)`);

  // conversations and chapter cards: live from DeepSeek, or replayed from what the last live run saved
  if (live) await askLive(page, { base, plan, byslug, bodies, positions, key: keyOf, budget: live.budget ?? 0.4 });
  else await replay(page, byslug);
  await page.goto(base + "/");
  await page.locator("a.book-card").first().waitFor();
  return { page, files, positions };
}

async function replay(page, byslug) {
  const chats = existsSync(join(STATE, "chats.json")) ? read("chats.json") : [], cards = existsSync(join(STATE, "cards.json")) ? read("cards.json") : [];
  const mapped = chats.filter(c => byslug[c.slug]).map(c => ({ key: `chat:${byslug[c.slug].id}:${c.scope}`, turns: c.turns }));
  await page.evaluate(items => new Promise((ok, bad) => {
    const r = indexedDB.open("vicaria"); r.onerror = () => bad(r.error);
    r.onsuccess = () => { const t = r.result.transaction("kv", "readwrite"), s = t.objectStore("kv"); for (const x of items) s.put(x.turns, x.key); t.oncomplete = ok; t.onerror = () => bad(t.error); };
  }), mapped);
  // Ask needs some key to open its panel; a replay never sends anything, so an obvious fake will do
  await page.evaluate(() => localStorage.setItem("vic:aikey:deepseek", "sk-demo-not-a-real-key"));
  const t0 = Date.now();
  await writeOps(page, cards.filter(c => byslug[c.slug]).map((c, i) => ({ id: `demo.c${i}`, dev: "demo", t: t0 - 1000 * (i + 1) - c.hoursAgo * 3600e3, c: 0, k: "chapter-card", v: { book: byslug[c.slug].id, section: c.section, card: c.card }, bk: byslug[c.slug].id })));
  console.log(`replayed ${mapped.length} conversations and ${cards.length} chapter cards`);
  // saved thoughts and lessons (wiser.json): written by hand, replayed as ops like everything else
  if (existsSync(join(STATE, "wiser.json"))) {
    const w = read("wiser.json"), at = d => t0 - d * 86400e3, dayOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    await writeOps(page, [
      ...w.thoughts.map((x, i) => ({ id: `demo.w${i}`, dev: "demo", t: at(x.daysAgo), c: 0, k: "thought", v: { id: `th-demo${i}`, text: x.text, act: x.act, by: x.by, from: x.from, src: x.src, day: dayOf(at(x.daysAgo)), made: at(x.daysAgo) } })),
      ...w.lessons.map((x, i) => ({ id: `demo.l${i}`, dev: "demo", t: at(x.daysAgo), c: 0, k: "lesson", v: { id: `les-demo${i}`, title: x.title, body: x.body, people: x.people, models: x.models, summary: x.summary, topics: x.topics, lang: "en", src: "ai", made: at(x.daysAgo), ...(x.fav ? { fav: true } : {}) } })),
    ]);
    console.log(`replayed ${w.thoughts.length} thoughts and ${w.lessons.length} lessons`);
  }
}

// Real questions through the real Ask panel, the way a reader would put them. The key stays in the page's storage.
async function askLive(page, { base, plan, byslug, bodies, positions, key, budget }) {
  if (!key) throw new Error("--live needs a key file");
  await page.evaluate(k => localStorage.setItem("vic:aikey:deepseek", k), key);
  let spent = 0; // estimate in dollars, pessimistic: $0.30 per million tokens in, $1.20 out, 4 characters a token
  page.on("request", r => { if (r.url().includes("api.deepseek.com") && r.method() === "POST") spent += (r.postData()?.length ?? 0) / 4 * 0.30e-6 + 450 * 1.2e-6; });
  const only = process.env.DEMO_ONLY, bySlug = {}; for (const a of plan.asks) if (!only || a.slug.includes(only)) (bySlug[a.slug] ??= []).push(a);
  const cardJobs = plan.cards.filter(c => !only || c.slug.includes(only)).map(c => ({ ...c }));
  const savedCards = [];
  const open = async (slug, at) => {
    const f = byslug[slug], body = bodies[f.id], p = positions[f.id];
    const s = at === undefined ? { idx: p.section, blocks: p.block + 1 } : body[Math.min(body.length - 1, Math.round(at * (body.length - 1)))];
    const sec = Math.min(s.idx, p.section);
    await page.goto(`${base}/book/${f.id}?s=${sec}&b=${at === undefined ? p.block : 2}`);
    await page.locator(".prose [data-b]").first().waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Ask about this book" }).click().catch(() => {});
    await page.getByLabel("Question").or(page.getByRole("radio", { name: "Chapter card" })).first().waitFor();
    return sec;
  };
  for (const [slug, list] of Object.entries(bySlug)) {
    for (const a of list) {
      if (spent > budget) { console.warn(`spend estimate $${spent.toFixed(3)} passed the cap; stopping`); break; }
      await open(slug, a.at);
      await page.getByRole("radio", { name: a.scope === "book" ? "The book so far" : "This chapter" }).click();
      await page.waitForTimeout(900); // the panel swaps in the conversation of this scope a moment after the click
      const turns = await page.locator(".turn.ai").count();
      await page.getByLabel("Question").fill(a.q);
      await page.getByLabel("Question").press("Enter");
      await page.waitForFunction(n => document.querySelectorAll(".turn.ai").length > n && !document.querySelector(".askbox button.btn.ghost"), turns, { timeout: 90000 })
        .catch(async e => { await page.screenshot({ path: "/tmp/seed-fail.png" }); throw e; });
      await page.waitForTimeout(500);
      const err = await page.locator(".turn.ai .err").count();
      console.log(`${err ? "ERR " : "ok  "} ${slug.slice(0, 26).padEnd(26)} ${a.scope.padEnd(7)} ${a.q.slice(0, 60)}   ~$${spent.toFixed(3)}`);
      if (err) throw new Error("DeepSeek returned an error; see the screen");
    }
  }
  for (const c of cardJobs) {
    if (spent > budget) break;
    await open(c.slug, c.at);
    await page.getByRole("radio", { name: "Chapter card" }).click();
    await page.getByRole("button", { name: "Make the card" }).click();
    await page.getByRole("button", { name: "Make it again" }).waitFor({ timeout: 120000 });
    console.log(`card ${c.slug.slice(0, 30)}   ~$${spent.toFixed(3)}`);
  }
  // save what was made, keyed by book name instead of book id, with no key anywhere in it
  const idOf = Object.fromEntries(Object.entries(byslug).map(([s, f]) => [f.id, s]));
  const dump = await page.evaluate(async () => {
    const db = await new Promise(ok => { const r = indexedDB.open("vicaria"); r.onsuccess = () => ok(r.result); });
    const ask = (store, method) => new Promise(ok => { const q = db.transaction(store).objectStore(store)[method](); q.onsuccess = () => ok(q.result); });
    const [ks, vs, os] = [await ask("kv", "getAllKeys"), await ask("kv", "getAll"), await ask("ops", "getAll")];
    return { kv: ks.map((k, i) => [k, vs[i]]).filter(([k]) => String(k).startsWith("chat:")), cards: os.filter(o => o.k === "chapter-card") };
  });
  const chats = dump.kv.map(([k, turns]) => { const [, id, scope] = k.split(":"); return { slug: idOf[id], scope, turns }; }).filter(c => c.slug);
  const cards = dump.cards.filter(o => idOf[o.v.book]).map(o => ({ slug: idOf[o.v.book], section: o.v.section, card: o.v.card, hoursAgo: Math.round((Date.now() - o.t) / 3600e3) + 1 }));
  writeFileSync(join(STATE, "chats.json"), JSON.stringify(chats, null, 1));
  writeFileSync(join(STATE, "cards.json"), JSON.stringify(cards, null, 1));
  console.log(`saved ${chats.length} conversations and ${cards.length} chapter cards; spend estimate $${spent.toFixed(3)}`);
}

// ---- command line ----
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), flag = n => { const i = args.indexOf(n); if (i < 0) return null; const [, v] = args.splice(i, 2); return v; };
  const liveFile = flag("--live"), base = flag("--base") || "http://127.0.0.1:47812/vicaria/next";
  const [epubDir, profile] = args;
  if (!epubDir || !profile) { console.error("usage: node e2e/demo-seed.mjs <epubDir> <profileDir> [--live <keyFile>] [--base <url>]"); process.exit(2); }
  await fetchBooks(epubDir);
  const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try { await seedDemo(ctx, { base, epubDir, live: liveFile ? { key: readFileSync(liveFile, "utf8").trim() } : null }); }
  finally { await ctx.close(); }
}

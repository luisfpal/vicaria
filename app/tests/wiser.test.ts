import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "../src/core/idb";
import { allOps } from "../src/core/ops";
import { weight, sample, rng, tierOf, bundledPick, latticeThought, highlightThought, seenAfter, spread, type Cand, type Source, type Seen } from "../src/wiser/pick";
import { room, spent, estimate, DAY_TOKENS, dayOf } from "../src/wiser/budget";
import { thoughtMessages, parseThought, lessonMessages, parseLesson, DEFAULT_TEMPLATE, BLUEPRINT, ITEM_CHARS, MAX_ITEMS } from "../src/wiser/prompts";
import { foldThoughts, foldLessons, foldPrefs, searchLessons, memoryFor, putThought, putLesson, putPrefs, DEFAULT_PREFS, type Lesson } from "../src/wiser/data";
import { todayThought, cachedToday } from "../src/wiser/today";
import { makeLesson, foldThread, needsSummary, chatMessages, saveThread, loadThread, LimitError, UnreadableError, THREAD_KEEP } from "../src/wiser/lesson";
import { thoughts as bundledEn, lessons as lessonsEn } from "../src/wiser/bundled-en";
import { thoughts as bundledEs, lessons as lessonsEs } from "../src/wiser/bundled-es";
import { routeById } from "../src/ai/providers";

// localStorage for the budget (the node test environment has none)
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, String(v)), removeItem: k => void mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0 };

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 22, 9);
const C = (id: string, over: Partial<Cand> = {}): Cand => ({ id, book: "b" + id, title: "Book " + id, author: "A" + id, text: "text of " + id, note: "", tags: [], made: NOW - 30 * DAY, ...over });
const book = (id: string, tags: string[], cluster = 0) => ({ id, title: "Book " + id, author: "A", tags, marks: tags.length, cluster });
const src = (items: Cand[], books = [book("1", ["x"]), book("2", ["y"], 1)]): Source => ({ items, books });
const say = (k: string, a: Record<string, string>) => `${k}:${Object.values(a).join("|")}`;
const ai = { route: routeById("deepseek")!, key: "sk-test-not-real" };
const reply = (json: object, usage = { prompt_tokens: 500, completion_tokens: 60 }) => (async () => new Response(new Blob([`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(json) } }] })}\n\ndata: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`]).stream(), { status: 200 })) as unknown as typeof fetch;
const wipe = async () => { await resetDb(); await new Promise<void>(ok => { const r = indexedDB.deleteDatabase("vicaria"); r.onsuccess = r.onerror = r.onblocked = () => ok(); }); mem.clear(); };
const LESSON_BODY = "**The idea.** " + "word ".repeat(60);

describe("selection and serendipity", () => {
  it("an old highlight outranks a new one, and what was just shown sinks", () => {
    const old = C("old", { made: NOW - 200 * DAY }), fresh = C("new", { made: NOW - DAY });
    expect(weight(old, {}, NOW, 0.5)).toBeGreaterThan(weight(fresh, {}, NOW, 0.5) * 10);
    const seen: Seen = { old: { n: 3, last: NOW - DAY } };
    expect(weight(old, seen, NOW, 0.5)).toBeLessThan(weight(fresh, seen, NOW, 0.5));
    // forgotten again: the same item shown long ago is worth far more than when it was shown yesterday
    expect(weight(old, { old: { n: 3, last: NOW - 200 * DAY } }, NOW, 0.5)).toBeGreaterThan(weight(old, seen, NOW, 0.5) * 50);
  });
  it("a note of the reader's own raises the weight by half", () => {
    expect(weight(C("a", { note: "mine" }), {}, NOW, 0.5) / weight(C("a"), {}, NOW, 0.5)).toBeCloseTo(1.5, 5);
  });
  it("is not always the newest: over many days every highlight comes up and the newest is not favoured", () => {
    const items = Array.from({ length: 12 }, (_, i) => C(String(i), { made: NOW - (12 - i) * 3 * DAY }));
    let seen: Seen = {}; const order: string[] = [];
    for (let d = 0; d < 36; d++) { const now = NOW + d * DAY, c = sample(items, seen, 1, now, rng("d" + d))[0]; order.push(c.id); seen = seenAfter(seen, [c.id], now); }
    expect(new Set(order).size).toBeGreaterThanOrEqual(11); // nearly all of them within 36 days
    const counts = order.reduce<Record<string, number>>((m, id) => (m[id] = (m[id] ?? 0) + 1, m), {});
    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(6);
  });
  it("the same day gives the same pick, another day another", () => {
    const items = Array.from({ length: 30 }, (_, i) => C(String(i)));
    const a = sample(items, {}, 3, NOW, rng("2026-11-22")).map(c => c.id), b = sample(items, {}, 3, NOW, rng("2026-11-22")).map(c => c.id);
    expect(a).toEqual(b); expect(new Set(a).size).toBe(3);
    expect(sample(items, {}, 3, NOW, rng("2026-11-23")).map(c => c.id)).not.toEqual(a);
  });
  it("sampling without replacement never returns more than there are, and spread puts different books first", () => {
    expect(sample([C("1"), C("2")], {}, 6, NOW, rng("x")).length).toBe(2);
    const s = spread([C("1", { book: "x" }), C("2", { book: "x" }), C("3", { book: "y" })]);
    expect(s.map(c => c.id)).toEqual(["1", "3", "2"]);
  });
  it("seen records grow and are capped, oldest dropped first", () => {
    let s: Seen = {}; for (let i = 0; i < 12; i++) s = seenAfter(s, ["k" + i], NOW + i, 10);
    expect(Object.keys(s).length).toBe(10); expect(s.k0).toBeUndefined(); expect(s.k11).toEqual({ n: 1, last: NOW + 11 });
    expect(seenAfter({ a: { n: 1, last: 5 } }, ["a"], 9).a).toEqual({ n: 2, last: 9 });
  });
});

describe("tiers and cold start", () => {
  it("one book or none is a cold start, with or without a key", () => {
    expect(tierOf({ items: [C("1")], books: [book("1", ["x"])] }, true)).toBe("bundled");
    expect(tierOf({ items: [], books: [] }, false)).toBe("bundled");
  });
  it("AI first, then the reader's highlights, then the lattice, then the bundled set", () => {
    expect(tierOf(src([C("1")]), true)).toBe("ai");
    expect(tierOf(src([C("1")]), false)).toBe("mine");
    expect(tierOf(src([]), false)).toBe("ideas");
    expect(tierOf(src([], [book("1", []), book("2", [])]), false)).toBe("bundled");
    expect(tierOf(src([], [book("1", ["a"]), book("2", ["b"])]), true)).toBe("ai"); // tags alone are material
  });
  it("bundled lines do not repeat until all were shown, then start over", () => {
    let seen: Seen = {}; const got: string[] = [];
    for (let d = 1; d <= bundledEn.length; d++) { const b = bundledPick(bundledEn, seen, `2026-11-${String(d).padStart(2, "0")}`); got.push(b.id); seen = seenAfter(seen, [b.id], NOW + d); }
    expect(new Set(got).size).toBe(bundledEn.length);
    expect(Object.values(seen).every(s => s.n === 1)).toBe(true);
    seenAfter(seen, [bundledPick(bundledEn, seen, "2026-12-01").id], NOW);
  });
  it("the bundled set is the five authors, in both languages with the same ids and no em dash", () => {
    expect(new Set(bundledEn.map(b => b.by))).toEqual(new Set(["Seneca", "Marcus Aurelius", "Epictetus", "Benjamin Franklin", "Michel de Montaigne"]));
    expect(bundledEs.map(b => b.id)).toEqual(bundledEn.map(b => b.id)); expect(lessonsEs.map(l => l.id)).toEqual(lessonsEn.map(l => l.id));
    for (const l of [...lessonsEn, ...lessonsEs]) { const n = l.body.split(/\s+/).length; expect(n, l.id).toBeGreaterThanOrEqual(140); expect(n, l.id).toBeLessThanOrEqual(310); }
    expect(JSON.stringify([bundledEn, bundledEs, lessonsEn, lessonsEs])).not.toMatch(/[\u2014\u2013]/);
  });
  it("the lattice thought joins books of different clusters, or two tags of one", () => {
    const s = src([], [book("1", ["habit", "sleep"], 0), book("2", ["stoic"], 1)]);
    const t = latticeThought(s, "2026-11-22", NOW, rng("a"), say)!;
    expect(t.src).toBe("ideas"); expect(t.text).toContain("Book 1"); expect(t.text).toContain("Book 2"); expect(t.from!.split(" · ").sort()).toEqual(["Book 1", "Book 2"]);
    const same = latticeThought(src([], [book("1", ["a"], 0), book("2", ["a"], 0)]), "d", NOW, rng("a"), say)!;
    expect(same.text.startsWith("ideas.pair")).toBe(true);
    expect(latticeThought(src([], [book("1", ["a"])]), "d", NOW, rng("a"), say)).toBeNull();
  });
  it("a highlight thought keeps the reader's words and note", () => {
    const t = highlightThought(C("1", { text: "x".repeat(900), note: "my note" }), "d", NOW);
    expect(t.text.length).toBeLessThanOrEqual(400); expect(t.act).toBe("my note"); expect(t.from).toBe("Book 1"); expect(t.id).toBe("h-1");
  });
});

describe("caps", () => {
  it("the budget refuses past the day's limit and restarts tomorrow", () => {
    let s = spent(null, "d1", DAY_TOKENS - 100);
    expect(room(s, "d1", 100)).toBe(true); expect(room(s, "d1", 101)).toBe(false); expect(room(s, "d2", 5000)).toBe(true);
    s = spent(s, "d1", 100); expect(room(s, "d1", 1)).toBe(false);
    expect(spent(s, "d2", 7)).toEqual({ day: "d2", used: 7 }); expect(estimate(350)).toBe(100);
  });
  it("what goes to the model is a few clipped highlights, never a book", () => {
    const items = Array.from({ length: 40 }, (_, i) => C(String(i), { text: "long ".repeat(500), note: "n ".repeat(300) }));
    const m = thoughtMessages(items, ["a", "b", "c", "d", "e", "f"], ["r1", "r2", "r3", "r4"], "en");
    const user = m[1].content as string;
    expect((user.match(/^\[\d+\]/gm) ?? []).length).toBe(MAX_ITEMS);
    expect(user.length).toBeLessThan(MAX_ITEMS * (ITEM_CHARS + 260) + 700);
    expect(user).not.toContain("f"); // five tags are cut to four: no "e", "f"
    expect(user.match(/r\d/g)!.length).toBe(3);
    const l = lessonMessages({ prefs: DEFAULT_PREFS, lang: "en", library: [], memory: [], items });
    expect((l[1].content as string).length).toBeLessThan(MAX_ITEMS * (ITEM_CHARS + 260) + 300);
  });
  it("past the daily budget the AI tier steps down without a call or a message", async () => {
    await wipe(); localStorage.setItem("vic:wiser:spend", JSON.stringify({ day: dayOf(NOW), used: DAY_TOKENS - 10 }));
    let calls = 0; const f = (async () => { calls++; return new Response("", { status: 500 }); }) as unknown as typeof fetch;
    const t = await todayThought({ load: async () => src([C("1")]), bundled: async () => bundledEn, say, lang: "en", ai, now: NOW, fetch: f });
    expect(calls).toBe(0); expect(t.tier).toBe("mine"); expect(t.thought.id).toBe("h-1");
  });
});

describe("today's thought", () => {
  beforeEach(wipe);
  it("AI tier: sends a clipped sample, shows the books it used, counts the spend, and keeps the day", async () => {
    let body = ""; const f = reply({ text: "Do the call you avoid; it weighs more unspoken.", uses: [2] }) as unknown as typeof fetch;
    const wrapped = (async (u: string, i: RequestInit) => { body = String(i.body); return (f as unknown as (u: string, i: RequestInit) => Promise<Response>)(u, i); }) as unknown as typeof fetch;
    const items = [C("1"), C("2"), C("3")];
    const t = await todayThought({ load: async () => src(items), bundled: async () => bundledEn, say, lang: "en", ai, now: NOW, fetch: wrapped });
    expect(t.tier).toBe("ai"); expect(t.thought.src).toBe("ai"); expect(t.thought.text).toContain("Do the call");
    expect(t.thought.from).toBeTruthy(); expect(JSON.parse(body).response_format).toEqual({ type: "json_object" }); expect(JSON.parse(body).max_tokens).toBe(160);
    expect(JSON.parse(localStorage.getItem("vic:wiser:spend")!)).toEqual({ day: dayOf(NOW), used: 560 });
    // the same day again: the kept one, no second call
    const again = await todayThought({ load: async () => { throw new Error("must not load"); }, bundled: async () => bundledEn, say, lang: "en", ai, now: NOW + 3600_000, fetch: (async () => { throw new Error("no call"); }) as never });
    expect(again.thought.text).toBe(t.thought.text);
    expect((await cachedToday(dayOf(NOW), "en"))?.thought.id).toBe(t.thought.id);
    expect(await cachedToday(dayOf(NOW), "es")).toBeNull(); expect(await cachedToday(dayOf(NOW + 2 * DAY), "en")).toBeNull();
  });
  it("a failing or garbled model falls back to the reader's own highlight", async () => {
    for (const f of [(async () => new Response("no", { status: 500 })) as never, reply({ nothing: 1 }) as never]) {
      await wipe();
      const t = await todayThought({ load: async () => src([C("1")]), bundled: async () => bundledEn, say, lang: "en", ai, now: NOW, fetch: f });
      expect(t.tier).toBe("mine"); expect(t.thought.text).toBe("text of 1");
    }
  });
  it("no key and no highlights: the lattice; one book: the bundled set; a thought later in the month is another one", async () => {
    const lat = await todayThought({ load: async () => src([]), bundled: async () => bundledEn, say, lang: "en", now: NOW });
    expect(lat.tier).toBe("ideas");
    await wipe();
    const cold = await todayThought({ load: async () => ({ items: [C("1")], books: [book("1", ["x"])] }), bundled: async () => bundledEn, say, lang: "en", now: NOW });
    expect(cold.tier).toBe("bundled"); expect(cold.thought.by).toBeTruthy();
    const next = await todayThought({ load: async () => ({ items: [], books: [] }), bundled: async () => bundledEn, say, lang: "en", now: NOW + DAY });
    expect(next.thought.id).not.toBe(cold.thought.id);
  });
  it("shown highlights come back later than unseen ones", async () => {
    const items = [C("1"), C("2")]; const seen: string[] = [];
    for (let d = 0; d < 2; d++) seen.push((await todayThought({ load: async () => src(items), bundled: async () => bundledEn, say, lang: "en", now: NOW + d * DAY })).thought.id);
    expect(new Set(seen).size).toBe(2);
  });
});

describe("saved thoughts, lessons and memory (ops)", () => {
  beforeEach(wipe);
  const L = (id: string, over: Partial<Lesson> = {}): Lesson => ({ id, title: "T " + id, body: LESSON_BODY, people: ["Seneca"], models: ["opportunity cost"], summary: "about time " + id, topics: [], lang: "en", src: "ai", made: NOW, ...over });
  it("a saved thought, un-saved and saved again, folds to the newest", async () => {
    const t = { id: "ai-d", text: "hello", src: "ai" as const, day: "d", made: NOW };
    await putThought(t); expect(foldThoughts(await allOps()).map(x => x.id)).toEqual(["ai-d"]);
    await putThought({ ...t, gone: true }); expect(foldThoughts(await allOps())).toEqual([]);
    await putThought(t); expect(foldThoughts(await allOps())[0].text).toBe("hello");
  });
  it("lessons keep their memory, are searchable, and the newest versions win", async () => {
    await putLesson(L("a", { title: "Franklin's ledger", people: ["Benjamin Franklin"], models: ["feedback loop"], made: NOW - 5 })); await putLesson(L("b", { title: "Inversión", people: ["Jacobi"], models: ["inversion"], made: NOW }));
    const ls = foldLessons(await allOps());
    expect(ls.map(l => l.id)).toEqual(["b", "a"]);
    expect(searchLessons(ls, "franklin").map(l => l.id)).toEqual(["a"]); expect(searchLessons(ls, "FEEDBACK loop").map(l => l.id)).toEqual(["a"]);
    expect(searchLessons(ls, "inversion").map(l => l.id)).toEqual(["b"]); expect(searchLessons(ls, "nobody")).toEqual([]);
    await putLesson({ ...ls[1], fav: true }); expect(foldLessons(await allOps()).find(l => l.id === "a")!.fav).toBe(true);
    await putLesson({ ...ls[1], gone: true }); expect(foldLessons(await allOps()).map(l => l.id)).toEqual(["b"]);
    expect(memoryFor(foldLessons(await allOps()), 1)).toEqual([{ title: "Inversión", people: ["Jacobi"], models: ["inversion"], summary: "about time b" }]);
  });
  it("preferences fold to the newest op and ignore junk", async () => {
    expect(foldPrefs(await allOps())).toEqual(DEFAULT_PREFS);
    await putPrefs({ ...DEFAULT_PREFS, people: ["Seneca"], tone: "warm" }); await putPrefs({ ...DEFAULT_PREFS, people: ["Seneca", "Ada Lovelace"], tone: "blunt", length: "long", outside: false });
    expect(foldPrefs(await allOps())).toMatchObject({ people: ["Seneca", "Ada Lovelace"], tone: "blunt", length: "long", outside: false });
    expect(foldPrefs([{ id: "d.1", dev: "d", t: 1, k: "wiser", v: { tone: "loud", length: 7, people: [1, "x"] } }])).toMatchObject({ tone: "plain", length: "medium", people: ["x"] });
  });
  it("a new lesson is written with the earlier ones in its prompt and saved, so the next one builds on it", async () => {
    let sys = "";
    const f = (async (_u: string, i: RequestInit) => { sys = JSON.parse(String(i.body)).messages[0].content; return reply({ title: "Second", body: LESSON_BODY, people: ["Epictetus"], models: ["control"], summary: "s" })(_u, i); }) as unknown as typeof fetch;
    await putLesson(L("first", { title: "First lesson", summary: "ledger and feedback" }));
    const ls = foldLessons(await allOps());
    const made = await makeLesson({ prefs: { ...DEFAULT_PREFS, people: ["Epictetus"], tone: "blunt", topics: ["work"] }, lessons: ls, load: async () => src([C("1")]), lang: "es", ai, now: NOW + 1000, fetch: f });
    expect(sys).toContain("First lesson"); expect(sys).toContain("ledger and feedback"); expect(sys).toContain("Epictetus"); expect(sys).toContain("blunt"); expect(sys).toContain("work");
    expect(sys).toContain("Spanish"); expect(sys).toContain(BLUEPRINT.split("\n")[0]); expect(sys).not.toMatch(/[\u2014\u2013]/);
    expect(made.lang).toBe("es"); expect(foldLessons(await allOps()).map(l => l.title)).toEqual(["Second", "First lesson"]);
  });
  it("a lesson over the daily budget is refused before any call; an unreadable reply is an error, not a saved lesson", async () => {
    localStorage.setItem("vic:wiser:spend", JSON.stringify({ day: dayOf(NOW), used: DAY_TOKENS }));
    await expect(makeLesson({ prefs: DEFAULT_PREFS, lessons: [], load: async () => src([]), lang: "en", ai, now: NOW, fetch: (async () => { throw new Error("no call"); }) as never })).rejects.toBeInstanceOf(LimitError);
    mem.clear();
    await expect(makeLesson({ prefs: DEFAULT_PREFS, lessons: [], load: async () => src([]), lang: "en", ai, now: NOW, fetch: reply({ title: "x", body: "too short" }) })).rejects.toBeInstanceOf(UnreadableError);
    expect(foldLessons(await allOps())).toEqual([]);
  });
  it("the prompt template can be edited; the blueprint stays", () => {
    const m = lessonMessages({ prefs: { ...DEFAULT_PREFS, template: "Be a pirate. {tone} {nothing}" }, lang: "en", library: [{ author: "Seneca", title: "Letters" }], memory: [], items: [] });
    const s = m[0].content as string;
    expect(s).toContain("Be a pirate."); expect(s).toContain("{nothing}"); expect(s).not.toContain(DEFAULT_TEMPLATE.split("\n")[0]); expect(s).toContain(BLUEPRINT);
    expect(lessonMessages({ prefs: { ...DEFAULT_PREFS, outside: false, people: ["Seneca"] }, lang: "en", library: [], memory: [], items: [] })[0].content).toContain("Stay with these people");
  });
});

describe("replies", () => {
  it("reads JSON, fenced JSON and plain text; refuses empty or runaway text", () => {
    expect(parseThought('{"text":" Do it. ","uses":[1,"x",2]}')).toEqual({ text: "Do it.", uses: [1, 2] });
    expect(parseThought('```json\n{"text":"Fenced."}\n```')?.text).toBe("Fenced.");
    expect(parseThought("Just a sentence.")?.text).toBe("Just a sentence.");
    expect(parseThought('{"text":""}')).toBeNull(); expect(parseThought("x".repeat(700))).toBeNull();
    expect(parseLesson(JSON.stringify({ title: "T", body: LESSON_BODY, people: ["a", 3], models: [], summary: "" }))).toMatchObject({ title: "T", people: ["a"] });
    expect(parseLesson("not json")).toBeNull();
  });
});

describe("lesson chat", () => {
  beforeEach(wipe);
  const t = (n: number, role: "user" | "assistant" = n % 2 ? "assistant" : "user") => ({ role, text: "turn " + n, at: n });
  it("lives under Ask's storage, keyed by lesson", async () => {
    await saveThread("les-1", [t(0), t(1)]);
    expect((await loadThread("les-1")).length).toBe(2); expect(await loadThread("les-2")).toEqual([]);
    const { get } = await import("../src/core/idb"); expect(await get("kv", "chat:lesson:les-1")).toBeTruthy();
  });
  it("a long thread folds its older part into one summary, keeping the newest turns", () => {
    const turns = Array.from({ length: 24 }, (_, i) => t(i));
    expect(needsSummary(turns)).toBe(true); expect(needsSummary(turns.slice(0, 20))).toBe(false);
    const f = foldThread(turns, "They asked about X.");
    expect(f.length).toBe(THREAD_KEEP + 1); expect(f[0]).toMatchObject({ role: "assistant", text: "They asked about X.", summary: true }); expect(f[1].text).toBe("turn 16"); expect(foldThread(turns.slice(0, 5), "s").length).toBe(5);
    const m = chatMessages({ id: "l", title: "T", body: "BODY", people: [], models: [], summary: "", topics: [], lang: "en", src: "ai", made: 1 }, f, "and then?", "en");
    expect(m[0].content).toContain("BODY"); expect(m[1].content).toContain("Summary of the earlier conversation"); expect(m[m.length - 1]).toEqual({ role: "user", content: "and then?" });
  });
});

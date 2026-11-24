// Today's thought: the first tier that can run (docs/design/wiser.md), kept for the day so reopening the app, a second
// tab or a reload never costs another call. Anything that goes wrong with the model falls through to the next tier
// without a message: the card is a gift, not a status screen.
import { get, put } from "../core/idb";
import { stream, type Route } from "../ai/providers";
import { THOUGHT_MAX_OUT, estimate, room, spent, loadSpend, saveSpend, dayOf } from "./budget";
import { thoughtMessages, parseThought, MAX_ITEMS, MAX_TAGS } from "./prompts";
import { tierOf, sample, spread, rng, seenAfter, highlightThought, latticeThought, bundledPick, bundledThought, type Source, type Seen, type Tier, type Say } from "./pick";
import type { BundledThought, Thought } from "./data";

export interface Today { thought: Thought; tier: Tier; lang: string }
export interface TodayDeps {
  load: () => Promise<Source>; bundled: () => Promise<BundledThought[]>; say: Say; lang: string;
  ai?: { route: Route; key: string } | null; recent?: string[]; now?: number; fetch?: typeof fetch; timeoutMs?: number;
}
const SEEN = "wiser:seen", TODAY = "wiser:today";
export const loadSeen = async () => (await get<Seen>("kv", SEEN)) ?? {};
export async function cachedToday(day: string, lang: string): Promise<Today | null> {
  const c = await get<{ day: string; today: Today }>("kv", TODAY);
  return c && c.day === day && c.today.lang === lang ? c.today : null;
}

export async function todayThought(d: TodayDeps): Promise<Today> {
  const now = d.now ?? Date.now(), day = dayOf(now), hit = await cachedToday(day, d.lang);
  if (hit) return hit;
  const src = await d.load(), seen = await loadSeen(), rand = rng(day);
  let tier = tierOf(src, !!d.ai), thought: Thought | null = null, used: string[] = [];
  if (tier === "ai") {
    const got = await viaModel(d, src, seen, day, now, rand).catch(() => null);
    if (got) ({ thought, used } = got); else tier = src.items.length ? "mine" : "ideas";
  }
  if (!thought && tier === "mine") { const c = sample(src.items, seen, 1, now, rand)[0]; if (c) { thought = highlightThought(c, day, now); used = [c.id]; } else tier = "ideas"; }
  if (!thought && tier === "ideas") { thought = latticeThought(src, day, now, rand, d.say); if (!thought) tier = "bundled"; }
  if (!thought) { const b = bundledPick(await d.bundled(), seen, day); thought = bundledThought(b, day, now); used = [b.id]; tier = "bundled"; }
  const today: Today = { thought, tier: thought.src === "ai" ? "ai" : tier, lang: d.lang };
  await put("kv", seenAfter(seen, used, now), SEEN);
  await put("kv", { day, today }, TODAY);
  return today;
}

async function viaModel(d: TodayDeps, src: Source, seen: Seen, day: string, now: number, rand: () => number): Promise<{ thought: Thought; used: string[] } | null> {
  if (!d.ai) return null;
  const items = spread(sample(src.items, seen, MAX_ITEMS, now, rand));
  const tags = [...new Set(src.books.flatMap(b => b.tags))].sort((a, b) => rand() - 0.5 || (a < b ? -1 : 1)).slice(0, MAX_TAGS);
  const msgs = thoughtMessages(items, tags, d.recent ?? [], d.lang);
  const need = estimate(msgs.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0)) + THOUGHT_MAX_OUT;
  if (!room(loadSpend(), day, need)) return null;
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), d.timeoutMs ?? 12_000);
  try {
    const r = await stream(d.ai.route, d.ai.key, msgs, { json: true, maxTokens: THOUGHT_MAX_OUT, signal: ac.signal, fetch: d.fetch });
    saveSpend(spent(loadSpend(), day, r.usage ? r.usage.input + r.usage.output : need));
    const p = parseThought(r.text); if (!p) return null;
    const mine = p.uses.map(n => items[n - 1]).filter(Boolean), titles = [...new Set(mine.map(c => c.title))];
    return { thought: { id: `ai-${day}`, text: p.text, ...(titles.length ? { from: titles.join(" · ") } : {}), src: "ai", day, made: now }, used: (mine.length ? mine : items).map(c => c.id) };
  } finally { clearTimeout(timer); }
}

// Sync protocol: devices that write while apart, then meet over a network that drops, duplicates, reorders and cuts
// messages, end with byte-identical logs once they meet over a working connection. Book files arrive whole and
// checked, also after a cut in the middle.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { Session, summarize, missingFor, numOf, prioritize, batches, encode, decode, type SyncStore, type BookHave } from "../src/sync/protocol";
import { clean } from "../src/core/ops";
import type { Op } from "../src/core/types";

const canon = (ops: Op[]) => ops.map(o => JSON.stringify(clean(o))).sort().join("\n");
class Mem implements SyncStore {
  log = new Map<string, Op>(); files = new Map<string, Uint8Array>(); parts = new Map<string, Map<number, Uint8Array>>(); n = 0;
  constructor(public dev: string, public lib = "cp-test") {}
  write(k: Op["k"], v: Record<string, unknown>, t: number): Op { const o = clean({ id: `${this.dev}.${++this.n}`, dev: this.dev, t, k, v })!; this.log.set(o.id, o); return o; }
  async ops() { return [...this.log.values()]; }
  async merge(ops: Op[]) { const f: Op[] = []; for (const o of ops) if (!this.log.has(o.id)) { this.log.set(o.id, o); f.push(o); } return f; }
  async books(): Promise<BookHave[]> { return [...this.files].map(([sha, b]) => ({ sha, size: b.length })); }
  async wants(offered: BookHave[]) { return offered.filter(b => !this.files.has(b.sha)).sort((a, b) => a.size - b.size).map(b => b.sha); }
  async readOriginal(sha: string) { return this.files.get(sha) ?? null; }
  async partials(sha: string) { return [...(this.parts.get(sha)?.keys() ?? [])].sort((a, b) => a - b); }
  async putPartial(sha: string, i: number, b: Uint8Array) { let m = this.parts.get(sha); if (!m) this.parts.set(sha, m = new Map()); m.set(i, b); }
  async assemble(sha: string, n: number) { const m = this.parts.get(sha); if (!m) return null; const ps = Array.from({ length: n }, (_, i) => m.get(i)); if (ps.some(p => !p)) return null; const out = new Uint8Array(ps.reduce((s, p) => s + p!.length, 0)); let at = 0; for (const p of ps) { out.set(p!, at); at += p!.length; } return out; }
  async dropPartials(sha: string) { this.parts.delete(sha); }
  async addBook(sha: string, b: Uint8Array) { this.files.set(sha, b); }
  async sha256(b: Uint8Array) { return createHash("sha256").update(b).digest("hex"); }
}
const shaOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// a network of sessions; faults: drop, dup, reorder, cut (a connection ends mid-transfer)
type Faults = { drop?: number; dup?: number; reorder?: boolean; cutAfter?: number; corrupt?: number };
async function meet(a: { s: Session; m: Mem }, b: { s: Session; m: Mem }, rnd: () => number, f: Faults = {}) {
  const q: { to: "a" | "b"; data: Uint8Array }[] = [];
  let sent = 0, cut = false;
  const wire = (to: "a" | "b") => ({ send: async (_p: string, data: Uint8Array) => {
    if (cut) throw new Error("closed");
    sent++; if (f.cutAfter !== undefined && sent > f.cutAfter) { cut = true; throw new Error("closed"); }
    if (f.drop && rnd() < f.drop) return;
    let d = data;
    if (f.corrupt && rnd() < f.corrupt && d.length > 200) { d = d.slice(); d[d.length - 1] ^= 0xff; }
    q.push({ to, data: d }); if (f.dup && rnd() < f.dup) q.push({ to, data: d });
  } });
  // each session sends through its own wire to the other side
  (a.s as unknown as { w: unknown }).w = wire("b"); (b.s as unknown as { w: unknown }).w = wire("a");
  await a.s.join("B").catch(() => {});
  for (let steps = 0; q.length && steps < 200_000; steps++) {
    const i = f.reorder ? Math.floor(rnd() * q.length) : 0;
    const [x] = q.splice(i, 1);
    await (x.to === "a" ? a.s.receive("B", x.data) : b.s.receive("A", x.data));
  }
  a.s.leave("B"); b.s.leave("A");
}
const device = (dev: string) => { const m = new Mem(dev); return { m, s: new Session(m, { send: async () => {} }, { chunk: 1024, batch: 2048 }) }; };
const prng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

describe("sync summaries", () => {
  it("count numbers only for 1.0 ids", () => {
    expect(numOf("dab.17", "dab")).toBe(17);
    expect(numOf("dev-x.1700000000123456789", "dev-x")).toBeNull();
    expect(numOf("dab.017", "dab")).toBeNull();
  });
  it("send exactly what the other side lacks (1.0 ids), and everything differing for 0.x ids", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { maxLength: 120 }), fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { maxLength: 120 }), (xs, ys) => {
      const op = (n: number): Op => ({ id: `dab.${n}`, dev: "dab", t: n, k: "reader", v: {} });
      const mine = xs.map(op), peer = ys.map(op);
      const got = new Set(missingFor(summarize(peer), mine).map(o => o.id));
      expect(got).toEqual(new Set(xs.filter(x => !ys.includes(x)).map(n => `dab.${n}`)));
    }), { numRuns: 400 });
    const old = (n: number): Op => ({ id: `dev-old.1700000000${String(n).padStart(9, "0")}`, dev: "dev-old", t: n, k: "pos", v: {} });
    expect(missingFor(summarize([old(1)]), [old(1)])).toEqual([]);
    expect(missingFor(summarize([old(1)]), [old(1), old(2)]).length).toBe(2);
  });
  it("orders the open book first, then marks, newest first; batches stay under the limit", () => {
    const o = (id: string, k: Op["k"], book: string, t: number): Op => ({ id, dev: "d", t, k, v: { book } });
    const ord = prioritize([o("d.1", "reader", "x", 9), o("d.2", "mark", "y", 1), o("d.3", "mark", "x", 2), o("d.4", "pos", "x", 3)], new Set(["x"])).map(x => x.id);
    expect(ord).toEqual(["d.3", "d.4", "d.1", "d.2"]);
    const many = Array.from({ length: 500 }, (_, i) => o(`d.${i + 1}`, "mark", "x", i));
    const bs = batches(many, 4096);
    expect(bs.flat().length).toBe(500);
    for (const b of bs) expect(b.map(x => JSON.stringify(x).length + 1).reduce((s, n) => s + n, 0)).toBeLessThanOrEqual(4096);
  });
  it("frames round trip and garbage is ignored", () => {
    const body = new Uint8Array([1, 2, 3]);
    const d = decode(encode({ t: "chunk", sha: "ab", i: 0, n: 1, size: 3 }, body))!;
    expect(d.m).toEqual({ t: "chunk", sha: "ab", i: 0, n: 1, size: 3 }); expect([...d.body]).toEqual([1, 2, 3]);
    expect(decode(new Uint8Array([0, 0, 0, 99, 1]))).toBeNull();
    expect(decode(new Uint8Array([1]))).toBeNull();
  });
});

describe("sync sessions", () => {
  it("devices converge byte for byte after faulty meetings and one clean round", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 4 }), fc.integer({ min: 1, max: 1e9 }), fc.array(fc.tuple(fc.nat(3), fc.nat(3), fc.nat(4)), { maxLength: 12 }), async (n, seed, meetings) => {
      const rnd = prng(seed);
      const ds = Array.from({ length: n }, (_, i) => device(`dv${i}x`));
      let t = 1;
      const writeSome = () => { for (const d of ds) { const k = Math.floor(rnd() * 6); for (let j = 0; j < k; j++) d.m.write(rnd() < 0.5 ? "mark" : "pos", { id: `m${Math.floor(rnd() * 20)}`, book: `b${Math.floor(rnd() * 3)}`, set: { color: "yellow" }, note: "x".repeat(Math.floor(rnd() * 3000)) }, t++); } };
      writeSome();
      for (const [x, y, fault] of meetings) {
        if (x % n === y % n) continue;
        const faults: Faults[] = [{}, { drop: 0.3 }, { dup: 0.3, reorder: true }, { cutAfter: Math.floor(rnd() * 6) }, { drop: 0.2, dup: 0.2, reorder: true }];
        await meet(ds[x % n], ds[y % n], rnd, faults[fault]);
        writeSome();
      }
      // one clean round in a chain: everything reaches everyone
      for (let i = 0; i + 1 < n; i++) await meet(ds[i], ds[i + 1], rnd);
      for (let i = n - 1; i > 0; i--) await meet(ds[i], ds[i - 1], rnd);
      const want = canon(await ds[0].m.ops());
      for (const d of ds) expect(canon(await d.m.ops())).toBe(want);
      expect(want.split("\n").filter(Boolean).length).toBe(new Set(ds.flatMap(d => [...d.m.log.keys()])).size);
    }), { numRuns: 120 });
  }, 120_000);

  it("a book arrives whole and checked, resuming after cuts, and a damaged copy is refused", async () => {
    const rnd = prng(5);
    const a = device("daaa"), b = device("dbbb");
    const book = new Uint8Array(50_000).map((_, i) => (i * 31 + (i >> 7)) & 0xff), sha = shaOf(book);
    a.m.files.set(sha, book);
    await meet(a, b, rnd, { cutAfter: 12 });
    expect(b.m.files.has(sha)).toBe(false);
    const kept = (await b.m.partials(sha)).length;
    expect(kept).toBeGreaterThan(0);
    // corrupted chunks: the assembled file fails its SHA-256 and is not added
    await meet(a, b, rnd, { corrupt: 1 });
    expect(b.m.files.has(sha)).toBe(false);
    // a working connection: resumes and finishes; the stored file is the same bytes
    await meet(a, b, rnd);
    expect(b.m.files.get(sha)).toEqual(book);
    expect(b.m.parts.size).toBe(0);
  });

  it("resumes from the chunks already kept, without sending them again", async () => {
    const rnd = prng(9);
    const a = device("daaa"), b = device("dbbb");
    const book = new Uint8Array(20 * 1024).map((_, i) => i & 0xff), sha = shaOf(book);
    a.m.files.set(sha, book);
    await meet(a, b, rnd, { cutAfter: 8 });
    const kept = (await b.m.partials(sha)).length;
    let chunks = 0;
    const orig = b.s.receive.bind(b.s);
    b.s.receive = async (p, d) => { if (decode(d)?.m.t === "chunk") chunks++; return orig(p, d); };
    await meet(a, b, rnd);
    expect(b.m.files.get(sha)).toEqual(book);
    expect(chunks).toBe(20 - kept);
  });

  it("chunks handled at the same time (as the network delivers them) finish the book once", async () => {
    const a = device("daaa"), b = device("dbbb");
    const book = new Uint8Array(16 * 1024).map((_, i) => (i * 7) & 0xff), sha = shaOf(book);
    a.m.files.set(sha, book);
    let adds = 0, bad = 0; const add = b.m.addBook.bind(b.m);
    b.m.addBook = async (s2, bytes) => { adds++; await new Promise(r => setTimeout(r, 5)); return add(s2, bytes); };
    (b.s as unknown as { ev: (e: { e: string }) => void }).ev = e => { if (e.e === "bookbad") bad++; };
    // collect what A sends, then hand B every chunk at once, the way message handlers overlap in the browser
    const toB: Uint8Array[] = [], toA: Uint8Array[] = [];
    (a.s as unknown as { w: unknown }).w = { send: async (_p: string, d: Uint8Array) => { toB.push(d); } };
    (b.s as unknown as { w: unknown }).w = { send: async (_p: string, d: Uint8Array) => { toA.push(d); } };
    await a.s.join("B");
    for (let round = 0; round < 6 && (toA.length || toB.length); round++) {
      const forA = toA.splice(0), forB = toB.splice(0);
      await Promise.all([...forA.map(d => a.s.receive("B", d)), ...forB.map(d => b.s.receive("A", d))]);
    }
    expect(b.m.files.get(sha)).toEqual(book);
    expect(adds).toBe(1); expect(bad).toBe(0);
  });

  it("a change made on one device reaches a device it is not connected to, through a device connected to both", async () => {
    const ms = ["daaa", "dbbb", "dccc"].map(d => new Mem(d));
    const q: [number, string, Uint8Array][] = [];
    const names = ["A", "B", "C"];
    const ss = ms.map((m, i) => new Session(m, { send: async (p, d) => { q.push([names.indexOf(p), names[i], d]); } }));
    const pump = async () => { while (q.length) { const [to, from, d] = q.shift()!; await ss[to].receive(from, d); } };
    await ss[0].join("B"); await ss[2].join("B"); await pump(); // A-B and B-C connected, A and C not
    const o = ms[0].write("mark", { id: "m1", book: "b", set: { color: "green" } }, 5);
    await ss[0].local([o]); await pump();
    expect(ms[2].log.get(o.id)).toEqual(o);
  });

  it("a note at the 64 KB limit travels whole in its own batch", async () => {
    const rnd = prng(3); const a = device("daaa"), b = device("dbbb");
    const big = "ñ".repeat(32 * 1024); // 64 KiB of UTF-8
    a.m.write("mark", { id: "m", book: "x", note: big, base: null }, 1);
    for (let i = 0; i < 50; i++) a.m.write("pos", { book: "x", section: i }, 2 + i);
    await meet(a, b, rnd, { reorder: true });
    expect(canon(await b.m.ops())).toBe(canon(await a.m.ops()));
    expect((await b.m.ops()).length).toBe(51);
  });

  // the counterexample TLC found for the earlier hello rule (spec/SyncHello.tla, Old.cfg): one side drops the
  // connection and rejoins alone while the other still thinks it is connected
  it("a side that drops and rejoins alone is answered, and crossing hellos send the missing ops once", async () => {
    const sent = { A: 0, B: 0 };
    const a = { m: new Mem("daaa") }, b = { m: new Mem("dbbb") };
    const q: { to: "A" | "B"; data: Uint8Array }[] = [];
    const sa = new Session(a.m, { send: async (_p, data) => { q.push({ to: "B", data }); } }, { on: e => { if (e.e === "sent" && e.ops) sent.A++; } });
    const sb = new Session(b.m, { send: async (_p, data) => { q.push({ to: "A", data }); } }, { on: e => { if (e.e === "sent" && e.ops) sent.B++; } });
    const drain = async () => { while (q.length) { const x = q.shift()!; await (x.to === "A" ? sa.receive("B", x.data) : sb.receive("A", x.data)); } };
    a.m.write("pos", { book: "x", section: 1 }, 1); b.m.write("pos", { book: "y", section: 2 }, 2);
    await sa.join("B"); await sb.join("A"); // both see the connection at once: hellos cross
    await drain();
    expect(sent).toEqual({ A: 1, B: 1 });
    expect(canon(await a.m.ops())).toBe(canon(await b.m.ops()));
    // A drops and rejoins; what was in flight to A is lost; B never noticed
    await sb.local([b.m.write("pos", { book: "y", section: 3 }, 3)]);
    sa.leave("B"); for (let i = q.length - 1; i >= 0; i--) if (q[i].to === "A") q.splice(i, 1);
    a.m.write("pos", { book: "x", section: 4 }, 4);
    await sa.join("B"); await drain();
    expect(canon(await a.m.ops())).toBe(canon(await b.m.ops()));
    expect((await a.m.ops()).length).toBe(4);
    // and both still pass new ops on
    await sa.local([a.m.write("pos", { book: "x", section: 5 }, 5)]); await drain();
    expect((await b.m.ops()).length).toBe(5);
  });
});

describe("signalling relays", () => {
  it("include the five a 0.x device picks, so the two versions still meet", async () => {
    const { defaultRelayUrls } = await import("trystero");
    // an internal module: the same code 0.x runs (its bundle has the same list and pick)
    const u = await import("../node_modules/@trystero-p2p/core/dist/utils.mjs" as string) as { shuffle: (x: string[], s: number) => string[]; strToNum: (s: string) => number };
    const { OLD_SIGNAL } = await import("../src/sync/client");
    expect(u.shuffle([...defaultRelayUrls], u.strToNum("excerpta-v1")).slice(0, 5)).toEqual(OLD_SIGNAL);
  });
});

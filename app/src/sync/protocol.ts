// Sync between one reader's devices: the same op log everywhere, byte for byte, and the original book files.
//
// Every device keeps a grow-only set of ops (ops.ts). Two devices that meet swap a summary of what they hold, per
// writing device: how many ops, a hash of their ids, and (for 1.0 devices, whose op ids count up) the highest number
// below which nothing is missing. Each side then sends the ops the other lacks, most useful first (the open book,
// then marks, then positions, then settings), in batches the receiver stores as they arrive. A transfer that stops
// halfway keeps what arrived; the next meeting sends only the rest. Book files travel in 64 KB chunks kept as they
// arrive and checked against their SHA-256 at the end, so a cut connection resumes where it stopped.
//
// Pure logic plus a session over two small interfaces (Wire and SyncStore), so the same code runs with WebRTC, with
// a test network that drops, duplicates and reorders messages, and with in-memory stores.
import type { Op } from "../core/types";
import { clean } from "../core/ops";

export const PROTO = 2;
export const CHUNK = 64 * 1024;
export const BATCH_BYTES = 192 * 1024;
const ABOVE_MAX = 2000;

// ---- summaries ----
// per writing device: [count, floor, xor of id hashes, numbers above floor (when few)]
export type DevSum = [number, number, number, number[]?];
export type Sum = Record<string, DevSum>;
export function fnv(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
// the counting part of an op id ("dev.17" -> 17); 0.x ids carry nanoseconds, too big to count: null
export function numOf(id: string, dev: string): number | null {
  const s = id.slice(dev.length + 1);
  return /^[1-9]\d{0,14}$/.test(s) ? +s : null;
}
export function summarize(ops: Iterable<Pick<Op, "id" | "dev">>): Sum {
  const by = new Map<string, { n: number; x: number; nums: number[]; odd: boolean }>();
  for (const o of ops) {
    let d = by.get(o.dev); if (!d) by.set(o.dev, d = { n: 0, x: 0, nums: [], odd: false });
    d.n++; d.x = (d.x ^ fnv(o.id)) >>> 0;
    const k = numOf(o.id, o.dev); if (k === null) d.odd = true; else d.nums.push(k);
  }
  const out: Sum = {};
  for (const [dev, d] of by) {
    let floor = 0;
    if (!d.odd) {
      d.nums.sort((a, b) => a - b);
      for (const k of d.nums) { if (k === floor + 1) floor = k; else if (k > floor + 1) break; }
    }
    const above = d.odd ? [] : d.nums.filter(k => k > floor);
    out[dev] = above.length && above.length <= ABOVE_MAX ? [d.n, floor, d.x, above] : [d.n, floor, d.x];
  }
  return out;
}
// the ops in `mine` the peer (summary `peer`) does not hold. Exact for 1.0 devices; for a device whose ids cannot be
// counted (0.x) every op of that device is sent when the two summaries differ, and the receiver drops duplicates.
export function missingFor(peer: Sum, mine: Op[], mySum: Sum = summarize(mine)): Op[] {
  const out: Op[] = [];
  const aboveSets = new Map<string, Set<number>>();
  for (const o of mine) {
    const p = peer[o.dev], m = mySum[o.dev];
    if (!p) { out.push(o); continue; }
    if (m && p[0] === m[0] && p[2] === m[2]) continue; // same ops from this device
    const k = numOf(o.id, o.dev);
    if (k !== null && k <= p[1]) continue;
    if (k !== null && p[3]) {
      let s = aboveSets.get(o.dev); if (!s) aboveSets.set(o.dev, s = new Set(p[3]));
      if (s.has(k)) continue;
    }
    out.push(o);
  }
  return out;
}

// ---- order and batches ----
const RANK: Record<string, number> = { mark: 0, hl: 0, "hl-": 0, alias: 0, card: 0, shelf: 1, pos: 1, bg: 2, reader: 2, listen: 2, session: 3 };
export const bookKey = (o: Op) => (typeof o.v.book === "string" ? o.v.book : o.b) ?? "";
// the open book first, then by kind, then newest first
export function prioritize(ops: Op[], focus?: Set<string>): Op[] {
  const f = (o: Op) => (focus?.has(bookKey(o)) ? 0 : 1);
  return ops.slice().sort((a, b) => f(a) - f(b) || (RANK[a.k] ?? 3) - (RANK[b.k] ?? 3) || b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export function batches(ops: Op[], max = BATCH_BYTES): Op[][] {
  const out: Op[][] = []; let cur: Op[] = [], size = 0;
  for (const o of ops) {
    const n = JSON.stringify(o).length + 1;
    if (cur.length && size + n > max) { out.push(cur); cur = []; size = 0; }
    cur.push(o); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---- messages ----
export interface BookHave { sha: string; size: number; t?: number } // t: newest op time for that book (priority)
export type Msg =
  | { t: "hello"; proto: number; lib: string; dev: string; sum: Sum; books: BookHave[]; n: string; ack: string } // n: this connection's nonce, ack: the last nonce got from the receiver
  | { t: "ops"; ops: Op[]; left: number }               // left: ops still to come in this round
  | { t: "want"; sha: string; have: number[] }           // chunk numbers already here
  | { t: "chunk"; sha: string; i: number; n: number; size: number }
  | { t: "nobook"; sha: string };
const te = new TextEncoder(), td = new TextDecoder();
// one frame: 4-byte header length, header JSON, then the chunk bytes for "chunk"
export function encode(m: Msg, body?: Uint8Array): Uint8Array {
  const h = te.encode(JSON.stringify(m)), out = new Uint8Array(4 + h.length + (body?.length ?? 0));
  new DataView(out.buffer).setUint32(0, h.length); out.set(h, 4); if (body) out.set(body, 4 + h.length);
  return out;
}
export function decode(u8: Uint8Array): { m: Msg; body: Uint8Array } | null {
  try {
    if (u8.length < 4) return null;
    const n = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(0);
    if (n > u8.length - 4) return null;
    const m = JSON.parse(td.decode(u8.subarray(4, 4 + n))) as Msg;
    return m && typeof m.t === "string" ? { m, body: u8.subarray(4 + n) } : null;
  } catch { return null; }
}

// ---- session ----
export interface Wire { send(peer: string, data: Uint8Array): Promise<void> }
export interface SyncStore {
  lib: string; dev: string;
  ops(): Promise<Op[]>;
  merge(ops: Op[]): Promise<Op[]>;                       // returns the ops that were new
  books(): Promise<BookHave[]>;                          // originals this device can send
  wants(offered: BookHave[]): Promise<string[]>;         // of the offered books, which to fetch, most wanted first
  readOriginal(sha: string): Promise<Uint8Array | null>;
  partials(sha: string): Promise<number[]>;
  putPartial(sha: string, i: number, bytes: Uint8Array): Promise<void>;
  assemble(sha: string, n: number): Promise<Uint8Array | null>;
  dropPartials(sha: string): Promise<void>;
  addBook(sha: string, bytes: Uint8Array): Promise<void>;
  sha256(bytes: Uint8Array): Promise<string>;
}
export type SyncEvent =
  | { e: "peer"; peer: string; dev: string }
  | { e: "ops"; peer: string; got: number; fresh: number; left: number }
  | { e: "sent"; peer: string; ops: number }
  | { e: "book"; sha: string; done: number; n: number }
  | { e: "bookdone"; sha: string } | { e: "bookbad"; sha: string } | { e: "error"; msg: string };

export class Session {
  private hello = new Map<string, Extract<Msg, { t: "hello" }>>();
  private fetching = new Map<string, string>(); // sha -> peer
  private bad = new Map<string, number>(); // sha -> failed checks on the current connections
  // Hello rule (checked with TLC in spec/SyncHello.tla): each side picks a nonce per connection; a hello whose ack is
  // not this side's current nonce is answered, so a side that dropped and rejoined alone is always answered; the
  // missing ops are sent once per peer nonce, so the usual crossing hellos do not send them twice.
  private mine = new Map<string, string>();   // my nonce for this connection to the peer
  private theirs = new Map<string, string>(); // the peer's nonce, from its last hello
  private sentFor = new Map<string, string>(); // the peer nonce the missing ops were sent for
  constructor(private s: SyncStore, private w: Wire, private o: { focus?: () => Set<string>; on?: (e: SyncEvent) => void; chunk?: number; batch?: number } = {}) {}
  private ev(e: SyncEvent) { try { this.o.on?.(e); } catch { /* a listener never breaks sync */ } }
  peers() { return [...this.hello.keys()]; }
  async join(peer: string) {
    let n = this.mine.get(peer); if (!n) this.mine.set(peer, n = Math.random().toString(36).slice(2, 12));
    const ops = await this.s.ops();
    await this.w.send(peer, encode({ t: "hello", proto: PROTO, lib: this.s.lib, dev: this.s.dev, sum: summarize(ops), books: await this.s.books(), n, ack: this.theirs.get(peer) ?? "" }));
  }
  leave(peer: string) {
    this.hello.delete(peer); this.mine.delete(peer); this.theirs.delete(peer); this.sentFor.delete(peer);
    if (!this.hello.size) this.bad.clear(); // a new connection gets new tries
    for (const [sha, p] of this.fetching) if (p === peer) this.fetching.delete(sha);
  }
  // a new op written here (or arrived from one peer): pass it to every peer that said hello
  async local(ops: Op[], except?: string) {
    if (!ops.length) return;
    for (const p of this.hello.keys()) if (p !== except) for (const b of batches(ops, this.o.batch)) await this.w.send(p, encode({ t: "ops", ops: b, left: 0 })).catch(() => {});
  }
  // Messages are handled one at a time, in the order they arrived. The network hands them over without waiting, and
  // handled side by side the last chunks of a book each saw the book complete and each stored it (16 times at once
  // in a unit test; under load in the browser, overlapping writes of a 50 MB original).
  private queue: Promise<void> = Promise.resolve();
  receive(peer: string, data: Uint8Array): Promise<void> {
    const run = this.queue.then(() => this.handle(peer, data));
    this.queue = run.catch(() => {});
    return run;
  }
  private async handle(peer: string, data: Uint8Array) {
    const d = decode(data); if (!d) return;
    const { m, body } = d;
    try {
      if (m.t === "hello") {
        if (m.lib !== this.s.lib || m.dev === this.s.dev || typeof m.sum !== "object") return;
        this.hello.set(peer, m);
        this.ev({ e: "peer", peer, dev: m.dev });
        const n = typeof m.n === "string" ? m.n : "";
        this.theirs.set(peer, n);
        if (!this.mine.has(peer) || m.ack !== this.mine.get(peer)) await this.join(peer); // it has not got my current hello
        if (this.sentFor.get(peer) !== n) {
          this.sentFor.set(peer, n);
          const mine = await this.s.ops();
          const send = prioritize(missingFor(m.sum, mine), this.o.focus?.());
          const bs = batches(send, this.o.batch);
          let left = send.length;
          for (const b of bs) { left -= b.length; await this.w.send(peer, encode({ t: "ops", ops: b, left })); }
          this.ev({ e: "sent", peer, ops: send.length });
        }
        await this.fetchNext(peer);
      } else if (m.t === "ops") {
        if (!this.hello.has(peer) || !Array.isArray(m.ops)) return;
        const fresh = await this.s.merge(m.ops.map(o => clean(o)).filter((o): o is Op => !!o));
        this.ev({ e: "ops", peer, got: m.ops.length, fresh: fresh.length, left: m.left });
        await this.local(fresh, peer); // pass on to devices that have not got them (a chain of devices converges)
      } else if (m.t === "want") {
        if (!this.hello.has(peer)) return;
        const bytes = await this.s.readOriginal(m.sha);
        if (!bytes) { await this.w.send(peer, encode({ t: "nobook", sha: m.sha })); return; }
        const size = this.o.chunk ?? CHUNK, n = Math.max(1, Math.ceil(bytes.length / size)), have = new Set(m.have);
        for (let i = 0; i < n; i++) if (!have.has(i)) await this.w.send(peer, encode({ t: "chunk", sha: m.sha, i, n, size: bytes.length }, bytes.subarray(i * size, (i + 1) * size)));
      } else if (m.t === "chunk") {
        if (this.fetching.get(m.sha) !== peer || !Number.isInteger(m.i) || !Number.isInteger(m.n) || m.i < 0 || m.i >= m.n) return;
        await this.s.putPartial(m.sha, m.i, body.slice());
        const have = await this.s.partials(m.sha);
        this.ev({ e: "book", sha: m.sha, done: have.length, n: m.n });
        if (have.length >= m.n) {
          const bytes = await this.s.assemble(m.sha, m.n);
          await this.s.dropPartials(m.sha);
          this.fetching.delete(m.sha);
          if (bytes && bytes.length === m.size && await this.s.sha256(bytes) === m.sha) { await this.s.addBook(m.sha, bytes); this.ev({ e: "bookdone", sha: m.sha }); }
          else { this.bad.set(m.sha, (this.bad.get(m.sha) ?? 0) + 1); this.ev({ e: "bookbad", sha: m.sha }); }
          await this.fetchNext(peer);
        }
      } else if (m.t === "nobook") {
        if (this.fetching.get(m.sha) === peer) { this.fetching.delete(m.sha); this.bad.set(m.sha, 9); await this.fetchNext(peer); }
      }
    } catch (e) { this.ev({ e: "error", msg: (e as Error).message }); }
  }
  // one book at a time from each peer, most wanted first; a book that failed its check twice is not asked again
  private async fetchNext(peer: string) {
    if ([...this.fetching.values()].includes(peer)) return;
    const h = this.hello.get(peer); if (!h || !Array.isArray(h.books)) return;
    const offered = h.books.filter(b => !this.fetching.has(b.sha) && (this.bad.get(b.sha) ?? 0) < 2);
    const [sha] = await this.s.wants(offered); if (!sha) return;
    this.fetching.set(sha, peer);
    await this.w.send(peer, encode({ t: "want", sha, have: await this.s.partials(sha) }));
  }
}

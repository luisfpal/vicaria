// Sync in the browser: WebRTC between this reader's devices (Trystero, found through public Nostr relays, the same
// room as 0.x), and an encrypted mailbox on public relays for devices that are not online at the same time.
// Loaded only on a paired device. One tab per device runs it (Web Locks); the others hand their changes over
// through the op channel (ops.ts).
import { busy } from "../core/busy";
import { joinRoom, defaultRelayUrls } from "trystero";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { Session, type SyncEvent } from "./protocol";
import { idbStore } from "./idb-store";
import { toLegacy, fromLegacy, oldKeys } from "./legacy-snap";
import { b64, pairing, type Pairing } from "./pairing";
import { allOps, mergeOps, onOp, device, clean, addOp } from "../core/ops";
import { cardOp } from "../core/legacy";
import { listBooks } from "../core/read";
import type { Op } from "../core/types";

export const RELAYS = ["wss://relay.primal.net", "wss://relay.nostr.net", "wss://offchain.pub", "wss://relay.snort.social", "wss://relay.ditto.pub", "wss://nostr.overmind.lol"];
// the signalling relays a 0.x device without its own relay list uses: Trystero's pick of 5 from its defaults for the
// app id "excerpta-v1" (tests/sync.test.ts recomputes it); with these the two versions meet without opening all 30
export const OLD_SIGNAL = ["wss://nostr.liberty.fans", "wss://relay.wavlake.com", "wss://nostr-01.yakihonne.com", "wss://nostr.overmind.lol", "wss://relay.dwadziesciajeden.pl"];
// browsers open WebSockets to the same address one at a time, so a relay can take several seconds to answer
const RELAY_WAIT = 12_000;
const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
const KIND = 30078, CHUNK_CHARS = 30000, KEEP_DAYS = 30;
const te = new TextEncoder(), td = new TextDecoder();

export interface Status { on: boolean; peers: { id: string; dev?: string; old?: boolean }[]; direct?: number; relay?: number; books: Record<string, { done: number; n: number }>; log: string[]; error?: string }
type Hooks = { addBook(bytes: Uint8Array): Promise<{ id: string; sha256: string } | void>; afterMerge(): void; status(s: Status): void; focus(): Set<string>; relays?: string[] };

const hex = (u8: Uint8Array) => [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
const sha = async (...parts: string[]) => new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(parts.join("|"))));
const pipe = async (u8: Uint8Array, T: typeof CompressionStream | typeof DecompressionStream) => new Uint8Array(await new Response(new Blob([u8 as BlobPart]).stream().pipeThrough(new T("gzip"))).arrayBuffer());

export async function keysOf(p: Pairing) {
  return {
    aes: await crypto.subtle.importKey("raw", b64.from(p.key) as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]),
    room: hex(await sha("excerpta-room", p.key)).slice(0, 32), tag: hex(await sha("excerpta-tag", p.key)).slice(0, 24),
    nsk: await sha("excerpta-nostr", p.key),
  };
}
type Keys = Awaited<ReturnType<typeof keysOf>>;
export const seal = async (k: Keys, u8: Uint8Array) => { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k.aes, u8 as BufferSource)); const o = new Uint8Array(12 + ct.length); o.set(iv); o.set(ct, 12); return o; };
export const unseal = async (k: Keys, u8: Uint8Array) => new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u8.subarray(0, 12) as BufferSource }, k.aes, u8.subarray(12) as BufferSource));

// what 1.0 publishes to the mailbox: every op, compressed and sealed
export async function v2Snapshot(lib: string, dev: string, ops: Op[]) { return pipe(te.encode(JSON.stringify({ v: 2, lib, dev, sent: Date.now(), ops: ops.map(o => clean(o)).filter(Boolean) })), CompressionStream); }
export async function legacySnapshot(lib: string, dev: string, ops: Op[]) {
  const books = (await listBooks()).filter(b => b.format !== "pdf").map(b => ({ id: b.id, title: b.title })); // 0.x reads EPUB only
  return pipe(te.encode(JSON.stringify(toLegacy(ops, lib, dev, books))), CompressionStream);
}
// a snapshot from either version, already opened: the ops to merge
export async function opsOfSnapshot(gz: Uint8Array, lib: string, dev: string): Promise<{ ops: Op[]; from: string; old: boolean; have: { id: string; title: string }[] } | null> {
  const msg = JSON.parse(td.decode(await pipe(gz, DecompressionStream)));
  if (!msg || msg.dev === dev) return null;
  if (msg.v === 2) return msg.lib === lib && Array.isArray(msg.ops) ? { ops: msg.ops.map((o: unknown) => clean(o)).filter(Boolean), from: msg.dev, old: false, have: [] } : null;
  const got = await fromLegacy(msg, lib, cardOp);
  return got ? { ops: got.ops, from: String(msg.dev), old: true, have: got.have } : null;
}

export class SyncClient {
  private room: ReturnType<typeof joinRoom> | null = null;
  private pool: SimplePool | null = null;
  private sub: { close(): void } | null = null;
  private k!: Keys;
  private session!: Session;
  private dev = "";
  private st: Status = { on: false, peers: [], books: {}, log: [] };
  private stops: (() => void)[] = [];
  private pubTimer: ReturnType<typeof setTimeout> | undefined;
  private lastAt = 0;
  private asked = new Set<string>();
  private done = new Set<string>(JSON.parse(localStorage.getItem("vic:syncSeen") || "[]"));
  constructor(private p: Pairing, private h: Hooks) {}
  private status(patch: Partial<Status> = {}) { this.st = { ...this.st, ...patch }; this.h.status(this.st); }
  private note(s: string) { this.status({ log: [`${new Date().toLocaleTimeString()} ${s}`, ...this.st.log].slice(0, 12) }); }
  // "vic:relaysOnly": use just these relays (tests with a local relay, or a reader who runs their own)
  private only = (() => { try { const l = JSON.parse(localStorage.getItem("vic:relaysOnly") || "null"); return Array.isArray(l) && l.length ? l.map(String) : null; } catch { return null; } })();
  private relays() { return this.only ?? [...new Set([...(this.h.relays ?? []), ...(this.p.relays || []), ...RELAYS])]; }

  async start() {
    this.k = await keysOf(this.p);
    this.dev = await device();
    const store = await idbStore(this.p.lib, async b => { await this.h.addBook(b); });
    let merged: ReturnType<typeof setTimeout> | undefined;
    const onEv = (e: SyncEvent) => {
      if (e.e === "ops" && e.fresh) { this.status({ direct: Date.now() }); clearTimeout(merged); merged = setTimeout(() => this.h.afterMerge(), 600); }
      if (e.e === "ops" && e.left === 0 && e.got) this.note(`Up to date with a device (${e.fresh} new change${e.fresh === 1 ? "" : "s"})`);
      if (e.e === "book") this.status({ books: { ...this.st.books, [e.sha]: { done: e.done, n: e.n } } });
      if (e.e === "bookdone") { const b = { ...this.st.books }; delete b[e.sha]; this.status({ books: b }); this.note("A book arrived from your other device"); this.h.afterMerge(); }
      if (e.e === "bookbad") this.note("A book arrived damaged and was not added; it will be asked for again");
      if (e.e === "peer") this.status({ peers: this.st.peers.map(p => p.id === e.peer ? { ...p, dev: e.dev, old: false } : p) });
      if (e.e === "error") this.note("Sync problem: " + e.msg);
    };
    this.relaysOn(); // the mailbox first, so its sockets are not queued behind the signalling ones
    const room = this.room = joinRoom({ appId: "excerpta-v1", password: this.p.key, rtcConfig: { iceServers: STUN }, relayConfig: { urls: this.only ?? [...new Set([...this.relays(), ...(this.p.relays?.length ? defaultRelayUrls : OLD_SIGNAL)])] } } as never, this.k.room);
    const v2 = room.makeAction<Uint8Array>("v2"), snap = room.makeAction<Uint8Array>("snap"), want = room.makeAction<{ id: string }>("want"), file = room.makeAction<Uint8Array>("epub");
    this.session = new Session(store, { send: (peer, data) => v2.send(data, { target: peer }) }, { on: onEv, focus: this.h.focus });
    const spoke = new Set<string>();
    room.onPeerJoin(({ peerId }) => {
      this.status({ peers: [...this.st.peers.filter(p => p.id !== peerId), { id: peerId }] });
      this.session.join(peerId).catch(e => this.note("Could not greet a device: " + e.message));
      // a device that does not answer in the new protocol is on 0.x: it gets the snapshot it understands
      setTimeout(async () => { if (!spoke.has(peerId) && room.getPeers()[peerId]) { await snap.send(await legacySnapshot(this.p.lib, this.dev, await allOps()), { target: peerId }); this.status({ peers: this.st.peers.map(p => p.id === peerId ? { ...p, old: true } : p) }); } }, 2500);
    });
    room.onPeerLeave(({ peerId }) => { this.session.leave(peerId); spoke.delete(peerId); this.status({ peers: this.st.peers.filter(p => p.id !== peerId) }); });
    v2.onMessage((d, ctx) => { spoke.add(ctx.peerId); this.session.receive(ctx.peerId, new Uint8Array(d)); });
    snap.onMessage(async (d, ctx) => {
      try {
        const got = await this.take(new Uint8Array(d), "direct", true);
        // books the 0.x device has that this one does not know yet: ask for the files (they come back as "epub")
        if (got) {
          const keys = new Set(oldKeys(await allOps()).values()), mine = new Set((await listBooks()).map(b => b.id));
          for (const h of got.have) if (!keys.has(h.id) && !mine.has(h.id) && !this.asked.has(h.id)) { this.asked.add(h.id); await want.send({ id: h.id }, { target: ctx.peerId }); }
        }
      } catch (e) { this.note("Could not read an update: " + (e as Error).message); }
    });
    // a 0.x device asks for a book by its own key: the original file, prefixed with the key, as 0.x expects
    want.onMessage(async (m, ctx) => {
      const keys = oldKeys(await allOps());
      const b = (await listBooks()).find(x => (keys.get(x.id) ?? x.id) === m.id); if (!b) return;
      const bytes = await store.readOriginal(b.sha256); if (!bytes) return;
      const id = te.encode(m.id), out = new Uint8Array(1 + id.length + bytes.length); out[0] = id.length; out.set(id, 1); out.set(bytes, 1 + id.length);
      await file.send(out, { target: ctx.peerId });
    });
    file.onMessage(async d => {
      const u8 = new Uint8Array(d), key = td.decode(u8.subarray(1, 1 + u8[0]));
      const b = await this.h.addBook(u8.subarray(1 + u8[0]));
      // the 0.x key now means this book: its positions, highlights and cards attach here
      if (b && key !== b.id && !oldKeys(await allOps()).has(b.id)) await addOp("alias", { old: key, book: b.id, sha256: b.sha256 });
      this.note("A book arrived from your other device"); this.h.afterMerge();
    });
    // changes made here (any tab or the worker) go to connected devices at once and to the mailbox shortly after
    this.stops.push(onOp(o => { this.session.local([o]).catch(() => {}); this.schedule(); }));
    const flush = () => { if (this.pubTimer) { clearTimeout(this.pubTimer); this.pubTimer = undefined; this.publish().catch(() => {}); } };
    // back on screen: look for changes; leaving the screen (a phone app switch): write a pending change now
    const again = () => { if (document.visibilityState === "visible") this.fetchRelays().catch(() => {}); else flush(); };
    addEventListener("online", again); document.addEventListener("visibilitychange", again); addEventListener("pagehide", flush);
    const retry = setTimeout(() => { if (!this.st.relay) this.fetchRelays().catch(() => {}); }, 20_000);
    this.stops.push(() => { removeEventListener("online", again); document.removeEventListener("visibilitychange", again); removeEventListener("pagehide", flush); clearTimeout(retry); });
    this.status({ on: true });
  }
  async stop() {
    this.stops.forEach(f => f()); this.stops = []; clearTimeout(this.pubTimer); this.pubTimer = undefined; this.unsent?.(); this.unsent = undefined;
    clearTimeout(this.pubTimer);
    try { await this.room?.leave(); this.sub?.close(); this.pool?.close(this.relays()); } catch { /* already closed */ }
    this.room = null; this.pool = null; this.sub = null;
    this.status({ on: false, peers: [] });
  }
  private async take(gz: Uint8Array, via: "direct" | "relay" | "file"): Promise<number>;
  private async take(gz: Uint8Array, via: "direct" | "relay" | "file", full: true): Promise<{ fresh: number; have: { id: string; title: string }[] } | null>;
  private async take(gz: Uint8Array, via: "direct" | "relay" | "file", full = false): Promise<number | { fresh: number; have: { id: string; title: string }[] } | null> {
    const got = await opsOfSnapshot(gz, this.p.lib, this.dev); if (!got) return full ? null : 0;
    const fresh = await mergeOps(got.ops);
    this.status(via === "relay" ? { relay: Date.now() } : { direct: Date.now() });
    if (fresh.length) { this.note(`${via === "relay" ? "From the relays" : via === "file" ? "From the sync file" : "From a device on the previous version"}: ${fresh.length} new change${fresh.length === 1 ? "" : "s"}`); this.h.afterMerge(); }
    return full ? { fresh: fresh.length, have: got.have } : fresh.length;
  }

  // ---- mailbox on public relays ----
  private unsent?: () => void; // changes not yet on the relays keep an update from reloading the page
  private schedule() {
    clearTimeout(this.pubTimer); this.unsent ??= busy("sync");
    this.pubTimer = setTimeout(() => { this.pubTimer = undefined; this.publish().catch(e => this.note("Relays: " + e.message)).finally(() => { if (!this.pubTimer) { this.unsent?.(); this.unsent = undefined; } }); }, 1500);
  }
  async publish() {
    if (!this.pool) return false;
    const ops = await allOps();
    // every event goes out at once: waiting on the slowest relay before sending the next would leave the manifest
    // unsent when a phone closes the tab a moment after a change
    const all: ReturnType<typeof finalizeEvent>[] = [];
    for (const [suffix, gz, m] of [[":v2", await v2Snapshot(this.p.lib, this.dev, ops), "2"], ["", await legacySnapshot(this.p.lib, this.dev, ops), "1"]] as const) {
      const ct = await seal(this.k, gz), s = b64.to(ct), h = hex(await sha(s)).slice(0, 16), n = Math.ceil(s.length / CHUNK_CHARS);
      const exp = String(Math.floor(Date.now() / 1000) + KEEP_DAYS * 86400), at = this.lastAt = Math.max(Math.floor(Date.now() / 1000), this.lastAt + 1);
      const ev = (d: string, content: string, extra: string[][] = []) => finalizeEvent({ kind: KIND, created_at: at, content, tags: [["d", d], ["t", this.k.tag], ["h", h], ["expiration", exp], ...extra] }, this.k.nsk);
      const evs = [];
      for (let i = 0; i < n; i++) evs.push(ev(`${this.k.tag}:${this.dev}${suffix}:${i}`, s.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS), [["i", String(i)]]));
      evs.push(ev(`${this.k.tag}:${this.dev}${suffix}`, JSON.stringify({ n, h, dev: this.dev }), [["m", m]]));
      all.push(...evs);
    }
    const pool = this.pool, urls = this.relays();
    const ok = (await Promise.all(all.map(async e => (await Promise.allSettled(pool.publish(urls, e))).some(r => r.status === "fulfilled")))).every(Boolean);
    this.note(ok ? "Saved on the relays for your other devices" : "Relays did not take the update; will retry");
    if (!ok) setTimeout(() => this.schedule(), 30_000);
    return ok;
  }
  async fetchRelays() {
    if (!this.pool) return 0;
    const evs = await this.pool.querySync(this.relays(), { kinds: [KIND], authors: [getPublicKey(this.k.nsk)], "#t": [this.k.tag] }, { maxWait: RELAY_WAIT });
    const tag = (e: { tags: string[][] }, k: string) => e.tags.find(t => t[0] === k)?.[1];
    const mans = evs.filter(e => tag(e, "m")).map(e => ({ e, m: tag(e, "m")!, man: JSON.parse(e.content) as { n: number; h: string; dev: string } }));
    const newDevs = new Set(mans.filter(x => x.m === "2").map(x => x.man.dev));
    let n = 0;
    for (const { m, man } of mans) {
      if (man.dev === this.dev || this.done.has(man.h) || (m === "1" && newDevs.has(man.dev))) continue;
      const parts = new Map(evs.filter(e => tag(e, "h") === man.h && tag(e, "i") !== undefined).map(e => [+tag(e, "i")!, e.content]));
      if (parts.size < man.n) continue;
      try { n += await this.take(await unseal(this.k, b64.from([...Array(man.n).keys()].map(i => parts.get(i)).join(""))), "relay"); this.done.add(man.h); localStorage.setItem("vic:syncSeen", JSON.stringify([...this.done].slice(-200))); }
      catch (e) { this.note("A relay copy could not be opened: " + (e as Error).message); }
    }
    return n;
  }
  private relaysOn() {
    this.pool = new SimplePool({ maxWaitForConnection: RELAY_WAIT } as never);
    this.fetchRelays().catch(() => {});
    let t: ReturnType<typeof setTimeout> | undefined;
    this.sub = this.pool.subscribeMany(this.relays(), { kinds: [KIND], authors: [getPublicKey(this.k.nsk)], "#t": [this.k.tag], since: Math.floor(Date.now() / 1000) - 5 } as never,
      { onevent: (e: { tags: string[][] }) => { if (e.tags.some(x => x[0] === "m")) { clearTimeout(t); t = setTimeout(() => this.fetchRelays().catch(() => {}), 1200); } } });
    this.schedule();
  }
  syncNow() { return Promise.allSettled([this.publish(), this.fetchRelays(), ...Object.keys(this.room?.getPeers() ?? {}).map(p => this.session.join(p))]); }
  // a sealed file for when nothing else works (same format as 0.x, readable by both)
  async exportFile() { const u8 = await seal(this.k, await v2Snapshot(this.p.lib, this.dev, await allOps())); return new Blob([te.encode("VICARIA-SYNC-1\n"), te.encode(b64.to(u8))], { type: "text/plain" }); }
  async importFile(text: string) { return this.take(await unseal(this.k, b64.from(text.trim().replace(/^(EXCERPTA|VICARIA)-SYNC-1\s*/, ""))), "file"); }
}

export function currentPairing() { return pairing(); }

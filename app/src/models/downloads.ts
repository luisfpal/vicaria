// Downloading large model files in the background: one file at a time, written as it arrives, resumed from the
// last byte written after a reload or a lost connection (HTTP Range), and checked against its known size before it
// counts as there. Storage and network are passed in, so the same code runs in the models worker (OPFS) and in tests.
export interface ModelFile { url: string; size: number }
export interface Model { id: string; files: ModelFile[] }
export type Status = "idle" | "queued" | "downloading" | "paused" | "done" | "error";
export interface Progress { id: string; status: Status; got: number; total: number; error?: string }

export interface Store {
  size(name: string): Promise<number>;                       // bytes written so far (0 when missing)
  write(name: string, at: number, bytes: Uint8Array): Promise<void>;
  truncate(name: string, n: number): Promise<void>;
  remove(name: string): Promise<void>;
  isDone(name: string): Promise<boolean>;
  markDone(name: string, done: boolean): Promise<void>;
}
export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

// file name in storage: the URL's path after the host, safe for a flat directory
export const nameOf = (url: string) => url.replace(/^https?:\/\/[^/]+\//, "").replace(/[^\w.-]+/g, "_").slice(-180);
const FLUSH = 4 << 20; // write in 4 MB pieces: few writes, little memory, at most 4 MB to fetch again after a cut

export class Downloads {
  private state = new Map<string, Progress>();
  private queue: Model[] = [];
  private running: { id: string; ctl: AbortController } | null = null;
  // lock: runs a model's download so no other tab or worker downloads the same model at the same time
  constructor(private store: Store, private fetch: Fetch, private emit: (p: Progress) => void, private flushAt = FLUSH,
    private lock: <T>(id: string, f: () => Promise<T>) => Promise<T> = (_id, f) => f()) {}

  get(id: string): Progress | undefined { return this.state.get(id); }
  private set(p: Progress) { this.state.set(p.id, p); this.emit(p); }

  // what is already on the device, without downloading anything
  async check(m: Model): Promise<Progress> {
    let got = 0, done = true;
    for (const f of m.files) { const n = nameOf(f.url); if (await this.store.isDone(n)) got += f.size; else { done = false; got += Math.min(f.size, await this.store.size(n)); } }
    const total = m.files.reduce((s, f) => s + f.size, 0);
    const prev = this.state.get(m.id);
    const p: Progress = { id: m.id, status: done ? "done" : prev?.status === "queued" || prev?.status === "downloading" ? prev.status : got ? "paused" : "idle", got, total };
    this.set(p); return p;
  }

  start(m: Model): void {
    if (this.running?.id === m.id || this.queue.some(q => q.id === m.id)) return;
    this.queue.push(m);
    const p = this.state.get(m.id);
    this.set({ id: m.id, status: "queued", got: p?.got ?? 0, total: m.files.reduce((s, f) => s + f.size, 0) });
    void this.pump();
  }
  pause(id: string): void {
    this.queue = this.queue.filter(q => q.id !== id);
    if (this.running?.id === id) this.running.ctl.abort();
    const p = this.state.get(id); if (p && p.status !== "done") this.set({ ...p, status: "paused" });
  }
  pauseAll(): void { for (const q of [...this.queue]) this.pause(q.id); if (this.running) this.pause(this.running.id); }
  async remove(m: Model): Promise<void> {
    this.pause(m.id);
    for (const f of m.files) { const n = nameOf(f.url); await this.store.markDone(n, false); await this.store.remove(n); }
    this.set({ id: m.id, status: "idle", got: 0, total: m.files.reduce((s, f) => s + f.size, 0) });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const m = this.queue.shift(); if (!m) return;
    const ctl = new AbortController(); this.running = { id: m.id, ctl };
    try {
      await this.lock(m.id, () => this.download(m, ctl.signal));
      if (!ctl.signal.aborted) this.set({ ...this.state.get(m.id)!, status: "done" });
    } catch (e) {
      if (!ctl.signal.aborted) this.set({ ...this.state.get(m.id)!, status: "error", error: (e as Error).message || String(e) });
    } finally { this.running = null; void this.pump(); }
  }

  private async download(m: Model, signal: AbortSignal): Promise<void> {
    const total = m.files.reduce((s, f) => s + f.size, 0);
    let before = 0;
    for (const f of m.files) {
      const name = nameOf(f.url);
      if (await this.store.isDone(name)) { before += f.size; continue; }
      let at = await this.store.size(name);
      if (at > f.size) { await this.store.truncate(name, 0); at = 0; } // not this file: start over
      if (at < f.size) {
        const res = await this.fetch(f.url, { headers: at ? { Range: `bytes=${at}-` } : {}, signal });
        if (res.status === 200 && at) { await this.store.truncate(name, 0); at = 0; }        // the server ignored the range
        else if (res.status === 416) { await this.store.truncate(name, 0); throw new Error("The download arrived damaged; it starts again next time."); }
        else if (res.status !== 200 && res.status !== 206) throw new Error(`The download failed (${res.status}).`);
        const reader = res.body!.getReader(); let buf: Uint8Array[] = [], held = 0;
        const flush = async () => { if (!held) return; const b = join(buf, held); await this.store.write(name, at, b); at += held; buf = []; held = 0; };
        this.set({ id: m.id, status: "downloading", got: before + at, total });
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf.push(value); held += value.length;
            if (held >= this.flushAt) { await flush(); this.set({ id: m.id, status: "downloading", got: before + at, total }); }
            if (signal.aborted) break;
          }
        } finally { await flush(); } // what arrived before a cut or a pause is kept, so the next try resumes there
        if (signal.aborted) return;
      }
      // the file is pinned to one revision, so what arrived is the start of it: kept, and the next try goes on from there
      if (at < f.size) throw new Error("The download stopped before the end; it goes on from there next time.");
      await this.store.markDone(name, true);
      before += f.size;
      this.set({ id: m.id, status: "downloading", got: before, total });
    }
  }
}
function join(parts: Uint8Array[], n: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

// Whether to wait for Wi-Fi: only where the browser says the connection is metered or data saving is on
export function shouldWait(c?: { saveData?: boolean; type?: string; metered?: boolean }): boolean {
  return !!c && (c.saveData === true || c.metered === true || c.type === "cellular");
}

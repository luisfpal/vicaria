import { describe, it, expect } from "vitest";
import { Downloads, nameOf, shouldWait, type Store, type Model, type Progress } from "../src/models/downloads";

function memStore(): Store & { files: Map<string, Uint8Array>; done: Set<string> } {
  const files = new Map<string, Uint8Array>(), done = new Set<string>();
  return {
    files, done,
    async size(n) { return files.get(n)?.length ?? 0; },
    async write(n, at, b) { const old = files.get(n) ?? new Uint8Array(0); const out = new Uint8Array(Math.max(old.length, at + b.length)); out.set(old); out.set(b, at); files.set(n, out); },
    async truncate(n, k) { files.set(n, (files.get(n) ?? new Uint8Array(0)).slice(0, k)); },
    async remove(n) { files.delete(n); },
    async isDone(n) { return done.has(n); },
    async markDone(n, d) { if (d) done.add(n); else done.delete(n); },
  };
}
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
// a server holding these files; cutAfter: the connection drops after that many bytes of a response
function server(data: Record<string, Uint8Array>, o: { cutAfter?: number; ignoreRange?: boolean } = {}) {
  const log: string[] = [];
  const f = async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    const all = data[url]; const r = init.headers.Range; log.push(r ?? "full");
    const from = r && !o.ignoreRange ? +r.slice(6, -1) : 0; const body = all.slice(from);
    const cut = o.cutAfter; if (cut != null) o.cutAfter = undefined;
    let i = 0; const end = cut ?? body.length;
    // pulled piece by piece, as a network stream is (an error in start would drop the pieces already queued)
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (i < end) { c.enqueue(body.slice(i, Math.min(end, i + 1000))); i += 1000; } else if (cut != null) c.error(new Error("connection lost")); else c.close(); } }, { highWaterMark: 0 });
    return new Response(stream, { status: from ? 206 : 200 });
  };
  return { f, log };
}
const until = (d: Downloads, id: string, s: string[]) => new Promise<Progress>(ok => { const t = setInterval(() => { const p = d.get(id); if (p && s.includes(p.status)) { clearInterval(t); ok(p); } }, 2); });

const A = "https://hf.example/a/model.onnx", B = "https://hf.example/a/config.json";
const model: Model = { id: "voice-en", files: [{ url: A, size: 10_000 }, { url: B, size: 300 }] };

describe("downloads", () => {
  it("downloads every file of a model, reports progress and stores the exact bytes", async () => {
    const st = memStore(), srv = server({ [A]: bytes(10_000), [B]: bytes(300, 7) }), seen: Progress[] = [];
    const d = new Downloads(st, srv.f, p => seen.push(p));
    d.start(model); const p = await until(d, "voice-en", ["done", "error"]);
    expect(p).toMatchObject({ status: "done", got: 10_300, total: 10_300 });
    expect(st.files.get(nameOf(A))).toEqual(bytes(10_000)); expect(st.files.get(nameOf(B))).toEqual(bytes(300, 7));
    expect(seen.map(s => s.status)).toContain("queued");
  });
  it("after a lost connection, starts again from the last byte written, not from zero", async () => {
    const st = memStore(), srv = server({ [A]: bytes(10_000), [B]: bytes(300, 7) }, { cutAfter: 6_000 });
    const d = new Downloads(st, srv.f, () => {}, 2_500);
    d.start(model); expect((await until(d, "voice-en", ["done", "error"])).status).toBe("error");
    const kept = st.files.get(nameOf(A))?.length ?? 0;
    expect(kept).toBe(6_000); // everything received before the cut
    const d2 = new Downloads(st, srv.f, () => {}); // a reload: a new manager over the same storage
    expect((await d2.check(model))).toMatchObject({ status: "paused", got: 6_000 });
    d2.start(model); expect((await until(d2, "voice-en", ["done", "error"])).status).toBe("done");
    expect(st.files.get(nameOf(A))).toEqual(bytes(10_000));
    expect(srv.log).toEqual(["full", "bytes=6000-", "full"]);
  });
  it("resumes a partial file with a range request", async () => {
    const st = memStore(), srv = server({ [A]: bytes(10_000), [B]: bytes(300, 7) });
    await st.write(nameOf(A), 0, bytes(10_000).slice(0, 4_000));
    const d = new Downloads(st, srv.f, () => {});
    expect((await d.check(model))).toMatchObject({ status: "paused", got: 4_000 });
    d.start(model); await until(d, "voice-en", ["done"]);
    expect(srv.log[0]).toBe("bytes=4000-"); expect(st.files.get(nameOf(A))).toEqual(bytes(10_000));
  });
  it("starts over when the server ignores the range", async () => {
    const st = memStore(), srv = server({ [A]: bytes(10_000), [B]: bytes(300, 7) }, { ignoreRange: true });
    await st.write(nameOf(A), 0, bytes(10_000).slice(0, 4_000));
    const d = new Downloads(st, srv.f, () => {}); d.start(model); await until(d, "voice-en", ["done"]);
    expect(st.files.get(nameOf(A))).toEqual(bytes(10_000));
  });
  it("a file that ends early never counts as downloaded, and the next try goes on from where it ended", async () => {
    const data = { [A]: bytes(9_000), [B]: bytes(300, 7) }, st = memStore(), srv = server(data);
    const d = new Downloads(st, srv.f, () => {}); d.start(model);
    const p = await until(d, "voice-en", ["done", "error"]);
    expect(p.status).toBe("error"); expect(st.done.has(nameOf(A))).toBe(false); expect(st.files.get(nameOf(A))?.length).toBe(9_000);
    data[A] = bytes(10_000); d.start(model); await until(d, "voice-en", ["done"]);
    expect(srv.log.at(-2)).toBe("bytes=9000-"); expect(st.files.get(nameOf(A))).toEqual(bytes(10_000));
  });
  it("a stored piece longer than the file is thrown away", async () => {
    const st = memStore(), srv = server({ [A]: bytes(10_000), [B]: bytes(300, 7) });
    await st.write(nameOf(A), 0, bytes(12_000));
    const d = new Downloads(st, srv.f, () => {}); d.start(model); await until(d, "voice-en", ["done"]);
    expect(st.files.get(nameOf(A))).toEqual(bytes(10_000));
  });
  it("one model at a time, in the order asked; a paused one leaves the queue", async () => {
    const C = "https://hf.example/b/emb.onnx", other: Model = { id: "emb", files: [{ url: C, size: 2_000 }] };
    const st = memStore(), srv = server({ [A]: bytes(10_000), [B]: bytes(300, 7), [C]: bytes(2_000) }), order: string[] = [];
    const d = new Downloads(st, srv.f, p => { if (p.status === "downloading" && order.at(-1) !== p.id) order.push(p.id); });
    d.start(model); d.start(other); d.start(model);
    await until(d, "emb", ["done"]); expect(order).toEqual(["voice-en", "emb"]);
    const third: Model = { id: "stt", files: [{ url: "https://hf.example/c/x", size: 5 }] };
    d.start(third); d.pause("stt"); expect(d.get("stt")?.status).toBe("paused");
  });
  it("removing a model deletes its files", async () => {
    const st = memStore(), srv = server({ [A]: bytes(10_000), [B]: bytes(300, 7) });
    const d = new Downloads(st, srv.f, () => {}); d.start(model); await until(d, "voice-en", ["done"]);
    await d.remove(model); expect(st.files.size).toBe(0); expect((await d.check(model)).status).toBe("idle");
  });
  it("waits for Wi-Fi only when the browser says the connection is metered", () => {
    expect(shouldWait(undefined)).toBe(false); expect(shouldWait({ type: "wifi" })).toBe(false);
    expect(shouldWait({ type: "cellular" })).toBe(true); expect(shouldWait({ saveData: true })).toBe(true);
  });
});

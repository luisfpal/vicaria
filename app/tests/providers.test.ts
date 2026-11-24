import { describe, it, expect } from "vitest";
import { stream, sse, AiError, type Route } from "../src/ai/providers";

const te = new TextEncoder();
// a body that arrives in awkward pieces (split inside events and inside UTF-8 characters)
function body(text: string, cuts = [3, 17, 40]): ReadableStream<Uint8Array> {
  const bytes = te.encode(text); const pts = [0, ...cuts.filter(c => c < bytes.length), bytes.length];
  return new ReadableStream({ start(c) { for (let i = 1; i < pts.length; i++) c.enqueue(bytes.slice(pts[i - 1], pts[i])); c.close(); } });
}
const oa: Route = { id: "t", name: "Test", kind: "openai", base: "https://x", model: "m", vision: true, keyUrl: "" };
const an: Route = { ...oa, kind: "anthropic" };
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe("providers", () => {
  it("parse server-sent events split anywhere", async () => {
    const out: string[] = [];
    for await (const d of sse(body("data: a\n\ndata: ñb\r\n\r\n: comment\n\ndata: c", [1, 6, 9, 12, 13]))) out.push(d);
    expect(out).toEqual(["a", "ñb", "c"]);
  });
  it("stream OpenAI-format text, usage, and send images as data URLs", async () => {
    let sent: any;
    const f = (async (_u: string, init: RequestInit) => { sent = JSON.parse(init.body as string); return new Response(body(ev({ choices: [{ delta: { content: "Hola " } }] }) + ev({ choices: [{ delta: { content: "ñandú" } }] }) + ev({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }) + "data: [DONE]\n\n", [5, 33, 70])); }) as typeof fetch;
    const deltas: string[] = [];
    const r = await stream({ ...oa, extra: { thinking: { type: "disabled" } } }, "k", [{ role: "user", content: [{ type: "text", text: "q" }, { type: "image", mime: "image/png", data: "AAA" }] }], { fetch: f, onText: d => deltas.push(d) });
    expect(r.text).toBe("Hola ñandú"); expect(deltas).toEqual(["Hola ", "ñandú"]); expect(r.usage).toEqual({ input: 7, output: 2 });
    expect(sent.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
    expect(sent.thinking).toEqual({ type: "disabled" }); expect(sent.stream).toBe(true);
  });
  it("stream Anthropic-format text with the system prompt apart", async () => {
    let sent: any, hdr: any;
    const f = (async (_u: string, init: RequestInit) => { sent = JSON.parse(init.body as string); hdr = init.headers; return new Response(body(ev({ type: "message_start", message: { usage: { input_tokens: 5 } } }) + ev({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }) + ev({ type: "message_delta", usage: { output_tokens: 1 } }))); }) as typeof fetch;
    const r = await stream(an, "k", [{ role: "system", content: "S" }, { role: "user", content: "q" }], { fetch: f });
    expect(r.text).toBe("Hi"); expect(r.usage).toEqual({ input: 5, output: 1 });
    expect(sent.system).toBe("S"); expect(sent.messages).toEqual([{ role: "user", content: "q" }]); expect(hdr["x-api-key"]).toBe("k");
  });
  it("name the failure in plain words", async () => {
    const st = (s: number) => (async () => new Response('{"error":{"message":"nope"}}', { status: s })) as unknown as typeof fetch;
    await expect(stream(oa, "k", [], { fetch: st(401) })).rejects.toMatchObject({ kind: "key" });
    await expect(stream(oa, "k", [], { fetch: st(402) })).rejects.toMatchObject({ kind: "quota" });
    await expect(stream(oa, "k", [], { fetch: st(500) })).rejects.toThrow("Test returned an error: nope.");
    await expect(stream(oa, "k", [], { fetch: (async () => { throw new TypeError("x"); }) as typeof fetch })).rejects.toMatchObject({ kind: "network" });
  });
  it("stop when cancelled, mid-stream", async () => {
    const ac = new AbortController();
    const f = (async (_u: string, init: RequestInit) => new Response(new ReadableStream({ start(c) { c.enqueue(te.encode(ev({ choices: [{ delta: { content: "a" } }] }))); init.signal!.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); } }))) as typeof fetch;
    const p = stream(oa, "k", [], { fetch: f, signal: ac.signal, onText: () => ac.abort() });
    await expect(p).rejects.toBeInstanceOf(AiError);
    await expect(p).rejects.toMatchObject({ kind: "cancelled" });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { ROUTES, stream, listModels, pickModel, routeById, activeRoute, setKey, setModel, setActive, type Route } from "../src/ai/providers";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
});
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\ndata: [DONE]\n\n`;
const ok = () => new Response(sse({ choices: [{ delta: { content: "hi" } }] }), { status: 200 });

describe("routes", () => {
  it("offers every provider the README names, each with a distinct id", () => {
    const ids = ROUTES.map(r => r.id);
    for (const id of ["deepseek", "openrouter", "openai", "anthropic", "gemini", "xai"]) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("sends OpenAI's output limit under the name its newer models accept", async () => {
    let sent: any;
    await stream(routeById("openai")!, "k", [{ role: "user", content: "q" }], { maxTokens: 50, fetch: (async (_u: string, i: RequestInit) => { sent = JSON.parse(i.body as string); return ok(); }) as any });
    expect(sent.max_completion_tokens).toBe(50); expect(sent.max_tokens).toBeUndefined();
    await stream(routeById("deepseek")!, "k", [{ role: "user", content: "q" }], { maxTokens: 50, fetch: (async (_u: string, i: RequestInit) => { sent = JSON.parse(i.body as string); return ok(); }) as any });
    expect(sent.max_tokens).toBe(50);
  });
  it("asks again without the extra fields when a model does not know them", async () => {
    const bodies: any[] = [];
    const r: Route = { ...routeById("deepseek")!, extra: { reasoning_effort: "low" } };
    const f = (async (_u: string, i: RequestInit) => { const b = JSON.parse(i.body as string); bodies.push(b); return b.reasoning_effort ? new Response('{"error":{"message":"Unsupported parameter: reasoning_effort"}}', { status: 400 }) : ok(); }) as any;
    const res = await stream(r, "k", [{ role: "user", content: "q" }], { fetch: f });
    expect(res.text).toBe("hi"); expect(bodies.length).toBe(2); expect(bodies[1].reasoning_effort).toBeUndefined();
  });
  it("does not retry an ordinary 400", async () => {
    let n = 0;
    const f = (async () => { n++; return new Response('{"error":{"message":"bad request"}}', { status: 400 }); }) as any;
    await expect(stream(routeById("deepseek")!, "k", [], { fetch: f })).rejects.toThrow("bad request");
    expect(n).toBe(1);
  });
  it("applies the reader's model", () => {
    setModel("openai", "gpt-x"); expect(routeById("openai")!.model).toBe("gpt-x");
    setModel("openai", ""); expect(routeById("openai")!.model).toBe("gpt-5-nano");
  });
  it("starts OpenRouter on a named small model, never its variable-price router", () => {
    expect(ROUTES[0].id).toBe("openrouter"); expect(ROUTES[0].model).toBe("anthropic/claude-haiku-5.5");
  });
  it("uses the chosen provider if it has a key, else the first that has one", () => {
    expect(activeRoute()).toBeNull();
    setKey("anthropic", "a"); setKey("openai", "o");
    expect(activeRoute()!.route.id).toBe("openai"); // ROUTES order
    setActive("anthropic"); expect(activeRoute()!.route.id).toBe("anthropic");
    setActive("xai"); expect(activeRoute()!.route.id).toBe("openai"); // chosen one has no key
  });
});

describe("model lists", () => {
  const json = (o: unknown) => (async () => new Response(JSON.stringify(o), { status: 200 })) as any;
  it("reads OpenAI-format, Gemini-format and failure", async () => {
    expect(await listModels(routeById("openai")!, "k", json({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] }))).toEqual(["a", "b"]);
    expect(await listModels(routeById("gemini")!, "k", json({ models: [{ name: "models/gemini-x" }] }))).toEqual(["gemini-x"]);
    expect(await listModels(routeById("openai")!, "k", (async () => new Response("no", { status: 401 })) as any)).toEqual([]);
  });
  it("keeps a model the provider still has, else the newest small one", () => {
    expect(pickModel(["gpt-5-nano", "gpt-6-nano", "gpt-6"], "gpt-5-nano", /nano|mini/)).toBe("gpt-5-nano");
    expect(pickModel(["gpt-6", "gpt-6-nano", "gpt-7-nano", "gpt-image-1", "gpt-7-mini-audio"], "gpt-5-nano", /nano|mini/)).toBe("gpt-7-nano");
    expect(pickModel(["x", "y"], "gone")).toBe("gone"); // no hint: do not guess
    expect(pickModel(["llama", "qwen"], "")).toBe("llama"); // nothing chosen yet
    expect(pickModel([], "m", /nano/)).toBe("m");
  });
});

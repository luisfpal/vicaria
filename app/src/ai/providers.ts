// AI providers: one streaming call for OpenAI-compatible chat completions and one for Anthropic messages.
// Requests go straight from the device to the provider with the reader's own key; nothing passes through a server.
// Only routes that pass the golden test (e2e/golden.mjs) are offered in Settings; see ROUTES.

export type Part = { type: "text"; text: string } | { type: "image"; mime: string; data: string }; // data: base64
export interface Msg { role: "system" | "user" | "assistant"; content: string | Part[] }
export interface Route {
  id: string;
  name: string;
  kind: "openai" | "anthropic";
  base: string;        // e.g. https://api.deepseek.com
  model: string;
  vision: boolean;     // accepts images
  keyUrl: string;      // where a reader gets a key
  extra?: Record<string, unknown>; // body fields this route needs (e.g. thinking off)
  tokenKey?: "max_tokens" | "max_completion_tokens"; // the name of the output limit (OpenAI's newer models want the second)
  cheap?: RegExp;      // what a small, fast model of this provider is called, to choose one when the default is gone
}
// The routes offered in Settings. Every one answers a browser directly (cross-origin requests allowed, checked with a
// preflight on 2026-11-23), so a key goes from this device to the provider and nowhere else. Model names change
// often: the model is a setting, and after a key is accepted the provider's own list is read so a retired name is
// replaced by a small current one (see pickModel).
export const ROUTES: Route[] = [
  // OpenRouter first: one sign in reaches Claude, GPT, Grok, Gemini and DeepSeek, paid by the reader's own credits. Its
  // "auto" router has no fixed price, so the default is a named small model (Claude Haiku: cheap, reads pictures).
  { id: "openrouter", name: "OpenRouter", kind: "openai", base: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5", vision: true, keyUrl: "https://openrouter.ai/keys", cheap: /haiku|flash|nano|mini/ },
  { id: "deepseek", name: "DeepSeek", kind: "openai", base: "https://api.deepseek.com", model: "deepseek-flash", vision: true, keyUrl: "https://platform.deepseek.com/api_keys", extra: { thinking: { type: "disabled" } }, cheap: /flash|chat/ },
  // straight from the provider, for readers who already hold a key there (names checked against OpenRouter's public list, 2026-11-23)
  { id: "openai", name: "OpenAI", kind: "openai", base: "https://api.openai.com/v1", model: "gpt-5-nano", vision: true, keyUrl: "https://platform.openai.com/api-keys", tokenKey: "max_completion_tokens", cheap: /nano|mini/ },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", base: "https://api.anthropic.com", model: "claude-haiku-5-5", vision: true, keyUrl: "https://console.anthropic.com/settings/keys", cheap: /haiku/ },
  { id: "gemini", name: "Google Gemini", kind: "openai", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash-lite", vision: true, keyUrl: "https://aistudio.google.com/apikey", cheap: /flash-lite|flash/ },
  { id: "xai", name: "xAI", kind: "openai", base: "https://api.x.ai/v1", model: "grok-4.3", vision: true, keyUrl: "https://console.x.ai", cheap: /fast|mini|4\.3/ },
];

export class AiError extends Error {
  constructor(message: string, public kind: "key" | "quota" | "network" | "provider" | "cancelled", public status?: number) { super(message); }
}
export interface StreamOpts { signal?: AbortSignal; onText?: (delta: string, all: string) => void; maxTokens?: number; json?: boolean; fetch?: typeof fetch }
export interface Result { text: string; usage?: { input: number; output: number }; ms: number; firstMs?: number }

// Server-sent events: yields the data payload of each event, across chunk boundaries
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(), td = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += td.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const ev = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = ev.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
      if (data) yield data;
    }
    if (done) { const data = buf.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n"); if (data) yield data; return; }
  }
}

function openaiBody(r: Route, msgs: Msg[], o: StreamOpts) {
  const messages = msgs.map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map(p => p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } }) }));
  return { model: r.model, messages, stream: true, stream_options: { include_usage: true }, ...(o.maxTokens ? { [r.tokenKey ?? "max_tokens"]: o.maxTokens } : {}), ...(o.json ? { response_format: { type: "json_object" } } : {}), ...r.extra };
}
function anthropicBody(r: Route, msgs: Msg[], o: StreamOpts) {
  const system = msgs.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : m.content.map(p => p.type === "text" ? p.text : "").join("")).join("\n\n");
  const messages = msgs.filter(m => m.role !== "system").map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map(p => p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } }) }));
  return { model: r.model, system, messages, stream: true, max_tokens: o.maxTokens ?? 4096, ...r.extra };
}

export async function stream(r: Route, key: string, msgs: Msg[], o: StreamOpts = {}): Promise<Result> {
  const f = o.fetch ?? fetch, t0 = performance.now();
  const url = r.kind === "openai" ? `${r.base}/chat/completions` : `${r.base}/v1/messages`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (r.kind === "openai") headers.authorization = `Bearer ${key}`;
  else { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; headers["anthropic-dangerous-direct-browser-access"] = "true"; }
  const send = (x: Route) => f(url, { method: "POST", headers, body: JSON.stringify(x.kind === "openai" ? openaiBody(x, msgs, o) : anthropicBody(x, msgs, o)), signal: o.signal });
  let res: Response;
  try {
    res = await send(r);
    // a model that does not know one of the extra fields (a reasoning setting, a thinking switch) is asked again without them
    if (res.status === 400 && r.extra) { const detail = await res.clone().text().catch(() => ""); if (/unsupported|unknown|not supported|unrecognized|extra inputs/i.test(detail)) res = await send({ ...r, extra: undefined }); }
  }
  catch (e) { if (o.signal?.aborted) throw new AiError("Stopped.", "cancelled"); throw new AiError(`Could not reach ${r.name}. Check the connection.`, "network"); }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    const msg = (() => { try { const j = JSON.parse(detail); return j.error?.message || j.message || ""; } catch { return ""; } })();
    if (res.status === 401 || res.status === 403) throw new AiError(`${r.name} did not accept the key.`, "key", res.status);
    if (res.status === 402 || res.status === 429) throw new AiError(res.status === 402 ? `${r.name} says the account has no balance left.` : `${r.name} is busy or the limit was reached. Try again in a moment.`, "quota", res.status);
    throw new AiError(`${r.name} returned an error${msg ? `: ${msg}` : ` (${res.status})`}.`, "provider", res.status);
  }
  let text = "", firstMs: number | undefined, usage: Result["usage"];
  try {
    for await (const data of sse(res.body)) {
      if (data === "[DONE]") break;
      let j: any; try { j = JSON.parse(data); } catch { continue; }
      let delta = "";
      if (r.kind === "openai") {
        delta = j.choices?.[0]?.delta?.content ?? "";
        if (j.usage) usage = { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
        if (j.error) throw new AiError(`${r.name}: ${j.error.message || "error"}`, "provider");
      } else {
        if (j.type === "content_block_delta" && j.delta?.type === "text_delta") delta = j.delta.text;
        if (j.type === "message_start") usage = { input: j.message?.usage?.input_tokens ?? 0, output: 0 };
        if (j.type === "message_delta" && j.usage) usage = { input: usage?.input ?? 0, output: j.usage.output_tokens ?? 0 };
        if (j.type === "error") throw new AiError(`${r.name}: ${j.error?.message || "error"}`, "provider");
      }
      if (delta) { if (firstMs === undefined) firstMs = performance.now() - t0; text += delta; o.onText?.(delta, text); }
    }
  } catch (e) {
    if (o.signal?.aborted) throw new AiError("Stopped.", "cancelled");
    if (e instanceof AiError) throw e;
    throw new AiError(`The answer from ${r.name} was cut off. Try again.`, "network");
  }
  return { text, usage, ms: performance.now() - t0, firstMs };
}

// The reader's keys stay on this device (never synced, never in backups or sync files).
const KEY = (id: string) => `vic:aikey:${id}`;
const lsGet = (k: string) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* private mode: the setting lasts until the page closes */ } };
export const getKey = (id: string) => lsGet(KEY(id));
export const setKey = (id: string, key: string) => lsSet(KEY(id), key.trim());
export const baseRoute = (id: string) => ROUTES.find(r => r.id === id);
// a route with the reader's own model applied
export function routeById(id: string): Route | undefined {
  const r = baseRoute(id); if (!r) return undefined;
  const model = lsGet(`vic:aimodel:${id}`);
  return model ? { ...r, model } : r;
}
export const setModel = (id: string, model: string) => lsSet(`vic:aimodel:${id}`, model.trim());
export const setActive = (id: string) => lsSet("vic:ai:active", id);
export const hasKey = (id: string) => !!getKey(id);
// the provider in use: the one the reader chose if it has a key, else the first with a key
export function activeRoute(): { route: Route; key: string } | null {
  const pref = lsGet("vic:ai:active"), order = [...ROUTES].sort((a, b) => (a.id === pref ? -1 : 0) - (b.id === pref ? -1 : 0));
  for (const b of order) { const k = getKey(b.id); if (k) { const route = routeById(b.id)!; if (route.model) return { route, key: k }; } }
  return null;
}

// ---- the provider's own list of models ----
export async function listModels(r: Route, key: string, f: typeof fetch = fetch): Promise<string[]> {
  const url = r.kind === "openai" ? `${r.base}/models` : `${r.base}/v1/models?limit=100`;
  const headers: Record<string, string> = r.kind === "openai" ? { authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
  const res = await f(url, { headers }); if (!res.ok) return [];
  const j = await res.json().catch(() => null) as { data?: { id?: string }[]; models?: { name?: string }[] } | null;
  const ids = (j?.data ?? []).map(m => m.id ?? "").concat((j?.models ?? []).map(m => (m.name ?? "").replace(/^models\//, "")));
  return [...new Set(ids.filter(Boolean))];
}
// keep the model if the provider still has it; else the newest-looking small one; else the first
export function pickModel(ids: string[], current: string, cheap?: RegExp): string {
  if (!ids.length || ids.includes(current)) return current;
  if (!cheap) return current || ids[0];
  const small = cheap ? ids.filter(i => cheap.test(i) && !/embed|image|audio|tts|whisper|moderation|vision|realtime|search|transcribe|preview/i.test(i)) : [];
  return (small.sort().reverse()[0]) ?? ids[0];
}

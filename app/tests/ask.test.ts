import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { prepare, askBook, systemPrompt, chatKey, saveChat, loadChat } from "../src/ai/ask";
import { routeById } from "../src/ai/providers";
import type { Passage } from "../src/core/types";

const P = (section: number, b0: number, text: string, chapter = `Ch ${section}`): Passage => ({ id: `${section}:${b0}`, section, b0, b1: b0 + 1, chapter, text, notes: [] } as unknown as Passage);
const book = { id: "b1", title: "Meditaciones", author: "Marco Aurelio" };
const all = [P(1, 0, "On anger: anger is a weakness, says the emperor."), P(1, 2, "The river flows and never returns."), P(2, 0, "Death comes to all; the emperor dies at the end."), P(3, 0, "A secret twist about the river.")];

describe("asking about a book", () => {
  it("sends only what the reader has read, with ids, the rules and the selection", async () => {
    const a = await prepare(book, { mode: "book", upTo: { section: 1, block: 2 }, selection: { section: 1, block: 2, text: "The river flows" } }, "What does the river mean?", [], [], all);
    const sys = a.msgs[0].content as string, user = a.msgs[a.msgs.length - 1].content as string;
    expect(sys).toContain('"Meditaciones" by Marco Aurelio'); expect(sys).toContain("[12.4]"); expect(sys).toContain("Never reveal"); expect(sys).not.toContain("\u2014");
    expect(a.sent.map(p => p.id)).toEqual(["1:0", "1:2"]);
    expect(user).toContain("[1.2] (Ch 1)\nThe river flows"); expect(user).not.toContain("secret twist"); expect(user).not.toContain("Death comes");
    expect(user).toContain('selected this text [1.2]:\n"The river flows"'); expect(user.endsWith("Question: What does the river mean?")).toBe(true);
  });
  it("the whole book is sent only when asked, and then the spoiler rule is gone", async () => {
    const a = await prepare(book, { mode: "book", whole: true, upTo: { section: 1, block: 0 } }, "river twist", [], [], all);
    expect(a.sent.some(p => p.id === "3:0")).toBe(true);
    expect(systemPrompt(book, { mode: "book", whole: true })).not.toContain("Never reveal");
  });
  it("sends earlier turns as text and images as parts", async () => {
    const hist = [{ role: "user" as const, text: "first", at: 1 }, { role: "assistant" as const, text: "answer [1.0]", at: 2 }, { role: "assistant" as const, text: "", at: 3, error: "x" }];
    const a = await prepare(book, { mode: "chapter", upTo: { section: 1, block: 2 } }, "and this figure?", hist, [{ type: "image", mime: "image/png", data: "AAAA" }], all);
    expect(a.msgs.map(m => m.role)).toEqual(["system", "user", "assistant", "user"]);
    const last = a.msgs[3].content as { type: string }[];
    expect(last.map(p => p.type)).toEqual(["text", "image"]);
  });
  it("streams the answer from an OpenAI-format route without the key in the body", async () => {
    let body = "", auth = "";
    const fake = (async (_u: string, init: RequestInit) => {
      body = String(init.body); auth = (init.headers as Record<string, string>).authorization;
      const sse = 'data: {"choices":[{"delta":{"content":"Anger is weakness "}}]}\n\ndata: {"choices":[{"delta":{"content":"[1.0]."}}]}\n\ndata: {"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\ndata: [DONE]\n\n';
      return new Response(new Blob([sse]).stream(), { status: 200 });
    }) as unknown as typeof fetch;
    const a = await prepare(book, { mode: "chapter", upTo: { section: 1, block: 2 } }, "anger?", [], [], all);
    const seen: string[] = [];
    const r = await askBook(routeById("deepseek")!, "sk-test-not-real", a, { fetch: fake, onText: d => seen.push(d) });
    expect(r.text).toBe("Anger is weakness [1.0]."); expect(seen.length).toBe(2); expect(r.usage).toEqual({ input: 9, output: 4 });
    expect(auth).toBe("Bearer sk-test-not-real"); expect(body).not.toContain("sk-test"); expect(JSON.parse(body).thinking).toEqual({ type: "disabled" });
  });
  it("keeps one conversation per chapter and one for the book, on this device", async () => {
    expect(chatKey("b1", { mode: "chapter", upTo: { section: 4, block: 0 } })).toBe("chat:b1:ch4");
    expect(chatKey("b1", { mode: "book", upTo: { section: 4, block: 0 } })).toBe("chat:b1:book");
    await saveChat("chat:b1:ch4", [{ role: "user", text: "q", at: 1 }]);
    expect(await loadChat("chat:b1:ch4")).toEqual([{ role: "user", text: "q", at: 1 }]);
  });
});

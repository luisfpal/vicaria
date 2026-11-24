import { describe, it, expect } from "vitest";
import { problems, diagramProblems, makeCard, cardMarkdown, overlap, settle, type Card } from "../src/ai/cards";
import { routeById } from "../src/ai/providers";

const good: Card = {
  core: "Each morning, expect difficult people and remember they act from ignorance, so they cannot harm your mind.",
  lessons: [
    { lesson: "Wrongdoers share your nature and reason", why: "He calls them kin who partake of the same divinity, so anger at them is anger at oneself." },
    { lesson: "Only your own judgment can injure you", why: "No one can fix what is ugly on you; the harm comes from the opinion you form." },
    { lesson: "Cooperation is the natural order", why: "Like feet, hands and eyelids, people exist to work together, so being vexed works against nature." },
  ],
  remember: "Begin the day like a doctor expecting patients.",
  terms: [{ term: "ruling part", meaning: "the mind that judges and chooses" }],
  diagram: { type: "cause", title: "How an insult becomes harm", nodes: [{ id: "a", label: "Someone acts badly" }, { id: "b", label: "You judge it harmful" }, { id: "c", label: "You feel anger" }, { id: "d", label: "Your mind is disturbed" }], edges: [{ from: "a", to: "b", label: "prompts" }, { from: "b", to: "c", label: "produces" }, { from: "c", to: "d", label: "causes" }] },
};

describe("chapter cards", () => {
  it("a good card has no problems and shows as Markdown with a diagram", () => {
    expect(problems(good)).toEqual([]);
    const md = cardMarkdown(good);
    expect(md).toContain("**Each morning"); expect(md).toContain("1. **Wrongdoers"); expect(md).toContain("```mermaid\nflowchart LR");
    expect(md).toContain('na -->|"prompts"| nb'); expect(md).not.toContain("\u2014");
  });
  it("finds lines that repeat each other, and limits", () => {
    const c = { ...good, remember: "Expect difficult people each morning, they act from ignorance and cannot harm your mind." };
    expect(problems(c).some(p => p.includes("say the same thing"))).toBe(true);
    expect(settle(c).remember).toBe("");
    expect(problems({ ...good, lessons: good.lessons.slice(0, 2) })).toContain("2 lessons, need 3");
    expect(overlap("the quick brown fox", "a slow green turtle")).toBe(0);
  });
  it("rejects a star drawn as a diagram, a loop that does not loop, and a too-short chain", () => {
    const star = { type: "map", title: "t", nodes: [{ id: "h", label: "Hub idea" }, { id: "a", label: "Point one" }, { id: "b", label: "Point two" }, { id: "c", label: "Point three" }], edges: [{ from: "h", to: "a", label: "has" }, { from: "h", to: "b", label: "has" }, { from: "h", to: "c", label: "has" }] };
    expect(diagramProblems(star).join()).toContain("centre node");
    const loop = { ...good.diagram!, type: "cycle" };
    expect(diagramProblems(loop).join()).toContain("feedback loop");
    expect(diagramProblems({ type: "compare", title: "t", sides: ["A", "B"], rows: [{ aspect: "x", a: "1", b: "2" }] }).join()).toContain("need 3 to 5");
    expect(diagramProblems({ type: "none", why: "parallel points" })).toEqual([]);
  });
  it("asks once more with the problems listed, then settles", async () => {
    const prompts: string[] = [];
    const bad = { ...good, lessons: good.lessons.slice(0, 2) };
    const replies = [bad, good];
    const fake = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); prompts.push(body.messages[1].content);
      expect(body.response_format).toEqual({ type: "json_object" });
      const text = JSON.stringify(replies.shift());
      return new Response(new Blob([`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`]).stream());
    }) as unknown as typeof fetch;
    const card = await makeCard(routeById("deepseek")!, "k", { title: "Meditations", author: "Marcus Aurelius" }, "Book II", "Begin the morning...", { fetch: fake });
    expect(prompts.length).toBe(2); expect(prompts[1]).toContain("2 lessons, need 3");
    expect(card.lessons.length).toBe(3); expect(card.v).toBe("c3");
  });
});

describe("stored cards", () => {
  it("the newest card for a chapter wins, other chapters and books are separate", async () => {
    const { cardIn } = await import("../src/ai/cards");
    const op = (id: string, t: number, book: string, section: number, core: string) => ({ id, dev: "d1", t, k: "chapter-card", v: { book, section, card: { ...good, core } } }) as never;
    const ops = [op("d1.1", 10, "b1", 3, "old"), op("d1.2", 20, "b1", 3, "new"), op("d1.3", 30, "b1", 4, "other chapter"), op("d1.4", 40, "b2", 3, "other book")];
    expect(cardIn(ops, "b1", 3)?.core).toBe("new");
    expect(cardIn(ops, "b1", 5)).toBeNull();
    expect(cardIn([{ id: "d1.9", dev: "d1", t: 1, k: "chapter-card", v: { book: "b1", section: 3, card: { core: 5 } } } as never], "b1", 3)).toBeNull();
  });
});
it("each lesson ends its bold line and the reason starts on the next", async () => {
  const { renderAnswer } = await import("../src/ai/render");
  const html = renderAnswer(cardMarkdown(good), { sent: new Set() });
  expect(String(html)).toMatch(/<strong>Wrongdoers share your nature and reason\.<\/strong><br>/);
});

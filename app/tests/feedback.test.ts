import { describe, it, expect } from "vitest";
import { platformOf, reportText, issueUrl } from "../src/core/feedback";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const PIXEL = "Mozilla/5.0 (Linux; Android 14; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const FX = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

describe("feedback", () => {
  it("names the platform and browser in a few words", () => {
    expect(platformOf(MAC, 0)).toBe("macOS, Safari");
    expect(platformOf(MAC, 5)).toBe("iPadOS, Safari"); // iPadOS Safari says Macintosh but has a touch screen
    expect(platformOf(PIXEL, 5)).toBe("Android, Chrome");
    expect(platformOf(WIN, 0)).toBe("Windows, Edge");
    expect(platformOf(FX, 0)).toBe("Linux, Firefox");
  });
  it("the report holds version and platform and says no book text is in it", () => {
    const r = reportText({ version: "0.9.0 (abc123)", platform: "macOS, Safari", how: "installed app", lang: "es" });
    expect(r).toContain("Vicaria 0.9.0 (abc123)");
    expect(r).toContain("macOS, Safari");
    expect(r).toContain("installed app");
    expect(r).toMatch(/no book text/i);
  });
  it("an error is cut to one short line", () => {
    const r = reportText({ version: "1", platform: "p", how: "browser", lang: "en", problem: "Boom\n" + "x".repeat(500) });
    const line = r.split("\n").find(l => l.startsWith("Problem:"))!;
    expect(line.length).toBeLessThan(230);
    expect(r).not.toContain("x".repeat(300));
  });
  it("the issue link opens a new issue in the project with the report in the body", () => {
    const u = new URL(issueUrl({ version: "0.9.0 (abc)", platform: "Android, Chrome", how: "browser", lang: "en" }));
    expect(u.origin + u.pathname).toBe("https://github.com/luisfpal/vicaria/issues/new");
    expect(u.searchParams.get("body")).toContain("Android, Chrome");
    expect(u.searchParams.get("body")).toContain("0.9.0 (abc)");
    expect(u.href.length).toBeLessThan(2000);
  });
});

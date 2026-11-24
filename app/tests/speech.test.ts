import { describe, it, expect } from "vitest";
import { sentences, rankVoices } from "../src/core/speech";

describe("sentences", () => {
  it("splits on sentence ends and keeps offsets into the text", () => {
    const t = "Begin the morning by saying to thyself this. I shall meet with the busybody! Is that so?";
    const s = sentences(t);
    expect(s.map(x => x.text.trim())).toEqual(["Begin the morning by saying to thyself this.", "I shall meet with the busybody!", "Is that so?"]);
    for (const x of s) expect(t.slice(x.start, x.end)).toBe(x.text);
  });
  it("joins a very short piece to the next sentence", () => {
    const s = sentences("I. From my grandfather Verus I learned good morals and the government of my temper.");
    expect(s).toHaveLength(1);
  });
  it("works in Spanish and drops pieces with no words", () => {
    const s = sentences("¿Qué quiere decir el autor? Resume el argumento sobre la ira. …", "es");
    expect(s.map(x => x.text.trim())).toEqual(["¿Qué quiere decir el autor?", "Resume el argumento sobre la ira."]);
  });
});
describe("rankVoices", () => {
  const v = (name: string, lang: string, localService = true, d = false) => ({ name, lang, localService, default: d });
  it("prefers the book's language variant and high quality names, never another language", () => {
    const voices = [v("eSpeak English", "en-US"), v("Samantha (Enhanced)", "en-US"), v("Google UK English Female", "en-GB", false), v("Paulina", "es-MX"), v("Daniel", "en-GB", true, true)];
    expect(rankVoices(voices, "en-US").map(x => x.name)[0]).toBe("Samantha (Enhanced)");
    expect(rankVoices(voices, "en-GB").map(x => x.name)[0]).toBe("Google UK English Female");
    expect(rankVoices(voices, "es").map(x => x.name)).toEqual(["Paulina"]);
    expect(rankVoices(voices, "en").at(-1)!.name).toBe("eSpeak English");
  });
});

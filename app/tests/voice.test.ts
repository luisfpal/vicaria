import { describe, it, expect, afterEach } from "vitest";
import { voiceMode, voiceSupport, listen, installVoice } from "../src/ai/voice";

const g = globalThis as Record<string, unknown>;
function fake(avail?: string, installs = true) {
  const made: Record<string, unknown>[] = [];
  class R { lang = ""; interimResults = false; continuous = true; processLocally = false; onresult: ((e: unknown) => void) | null = null; onend: (() => void) | null = null; onerror: ((e: unknown) => void) | null = null;
    start() { made.push(this as unknown as Record<string, unknown>); queueMicrotask(() => { this.onresult?.({ results: [[{ transcript: "qué dice " }], [{ transcript: "sobre la ira" }]] }); this.onend?.(); }); }
    stop() { this.onend?.(); }
    static available?: (o: unknown) => Promise<string>;
    static install?: (o: unknown) => Promise<boolean>;
    static asked: unknown[] = [];
  }
  if (avail) { R.available = async o => { R.asked.push(o); return avail; }; R.install = async () => installs; }
  return { R, made };
}
afterEach(() => { delete g.SpeechRecognition; delete g.webkitSpeechRecognition; });

describe("dictation stays on the device", () => {
  it("uses on-device recognition when the language is there, and asks for dictation quality", async () => {
    const { R, made } = fake("available"); g.SpeechRecognition = R;
    const m = await voiceMode("es-ES");
    expect(m).toEqual({ kind: "local", install: false });
    expect(R.asked[0]).toEqual({ langs: ["es-ES"], quality: "dictation", processLocally: true });
    let text = ""; await new Promise<void>(ok => listen("es-ES", m, { text: t => { text = t; }, end: () => ok() }));
    expect(text).toBe("qué dice sobre la ira");
    expect(made[0]).toMatchObject({ processLocally: true, lang: "es-ES", interimResults: true });
  });
  it("offers to install a language that can run on the device", async () => {
    const { R } = fake("downloadable"); g.SpeechRecognition = R;
    expect(await voiceMode("en-US")).toEqual({ kind: "local", install: true });
    expect(await installVoice("en-US")).toBe(true);
  });
  it("never falls back to a server when the device cannot do it", async () => {
    const { R, made } = fake("unavailable"); g.SpeechRecognition = R;
    expect(voiceSupport()).toBe("check"); // nothing asked before a tap
    expect(R.asked.length).toBe(0);
    const m = await voiceMode("xx-XX");
    expect(m).toEqual({ kind: "none" });
    expect(listen("xx-XX", m, { text: () => {}, end: () => {} })).toBeNull();
    expect(made.length).toBe(0);
  });
  it("uses Safari's recognizer as it is, and shows nothing without one", async () => {
    const { R } = fake(); g.webkitSpeechRecognition = R;
    expect(await voiceMode("en-US")).toEqual({ kind: "system" }); expect(voiceSupport()).toBe("system");
    delete g.webkitSpeechRecognition; expect(voiceSupport()).toBe("none");
    expect(await voiceMode("en-US")).toEqual({ kind: "none" });
  });
});

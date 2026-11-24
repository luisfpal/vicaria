import { describe, it, expect, vi } from "vitest";
vi.mock("../src/workers/rpc", () => ({ client: () => ({ call: vi.fn() }) }));
const { silent } = await import("../src/ai/whisper");
describe("dictation by Whisper", () => {
  it("gives no text for a recording with no voice in it", () => {
    expect(silent(new Float32Array(16000))).toBe(true);
    expect(silent(new Float32Array(0))).toBe(true);
    const hiss = new Float32Array(16000).map((_, i) => 0.0008 * Math.sin(i)); expect(silent(hiss)).toBe(true);
  });
  it("sends speech-level audio on", () => {
    const voice = new Float32Array(16000).map((_, i) => 0.1 * Math.sin(i / 8)); expect(silent(voice)).toBe(false);
  });
});

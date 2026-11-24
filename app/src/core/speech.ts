// Reading aloud, the parts that need no browser: sentences of a block, and which installed voice to use first.

// Sentences of a text with their offsets. Very short pieces ("Mr.", "I.", a lone quote) join the next sentence,
// so the voice does not stop after them.
export function sentences(text: string, lang = "en"): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => { segment(t: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
  const parts = Seg ? [...new Seg(lang, { granularity: "sentence" }).segment(text)].map(s => ({ start: s.index, end: s.index + s.segment.length }))
    : [...text.matchAll(/[^.!?]+[.!?]*["'”’)]*\s*/g)].map(m => ({ start: m.index!, end: m.index! + m[0].length }));
  let carry: number | null = null;
  for (const p of parts) {
    const start: number = carry ?? p.start; carry = null;
    if (text.slice(start, p.end).trim().length < 12 && p !== parts[parts.length - 1]) { carry = start; continue; }
    out.push({ start, end: p.end, text: text.slice(start, p.end) });
  }
  if (carry != null) out.push({ start: carry, end: text.length, text: text.slice(carry) });
  return out.filter(s => /[\p{L}\p{N}]/u.test(s.text));
}

export interface VoiceInfo { name: string; lang: string; localService?: boolean; default?: boolean }
const GOOD = /natural|enhanced|premium|neural|siri|google|wavenet|online/i;
const BAD = /compact|espeak|robot|whisper|bells|bad news|zarvox|trinoids|novelty/i;
// The installed voices for a language, best first: names that mark a high quality voice count most, then the
// book's own variant (en-GB for a British book), voices on the device (they work offline), the system default.
export function rankVoices<V extends VoiceInfo>(voices: V[], lang: string): V[] {
  const want = lang.toLowerCase().replace("_", "-"), base = want.slice(0, 2);
  const fit = voices.filter(v => v.lang.toLowerCase().replace("_", "-").slice(0, 2) === base);
  const score = (v: V) => (v.lang.toLowerCase().replace("_", "-") === want ? 3 : 0) + (GOOD.test(v.name) ? 4 : 0) - (BAD.test(v.name) ? 6 : 0) + (v.localService ? 2 : 0) + (v.default ? 0.5 : 0);
  return fit.map(v => [score(v), v] as const).sort((a, b) => b[0] - a[0]).map(([, v]) => v);
}

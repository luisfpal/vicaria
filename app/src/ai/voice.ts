// Dictating a question. Speech is turned into text on the device: where the browser can say whether it recognizes
// a language on the device (Chrome 139 and later), Vicaria uses only that, installing the language once if needed,
// and never falls back to a speech service on someone's server. Safari's recognizer is used as it is (Apple runs it
// on the device for the languages it supports). Elsewhere the button is not shown and the system keyboard's own
// dictation still works in the question box (also where the device cannot recognize the language: the reader is told).
export interface Rec {
  lang: string; interimResults: boolean; continuous: boolean; processLocally?: boolean;
  start(): void; stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
}
type Avail = "available" | "downloadable" | "downloading" | "unavailable";
interface RecClass { new (): Rec; available?(o: { langs: string[]; quality?: string; processLocally?: boolean }): Promise<Avail>; install?(o: { langs: string[]; quality?: string; processLocally?: boolean }): Promise<boolean> }

export type VoiceMode = { kind: "none" } | { kind: "local"; install: boolean } | { kind: "system" };
const g = globalThis as unknown as { SpeechRecognition?: RecClass; webkitSpeechRecognition?: RecClass };
// Android's WebView (the Android app) has the recognizer object, but it never starts or reports an error: it is
// treated as missing, so the app dictates with Whisper on the device instead of a button that does nothing
const androidWebView = typeof navigator !== "undefined" && /; wv\)/.test(navigator.userAgent);
const Cls = (): RecClass | undefined => androidWebView ? undefined : g.SpeechRecognition ?? g.webkitSpeechRecognition;

// Without asking the browser anything: is there a recognizer at all ("check": ask voiceMode on a tap). Asking for
// availability is left to the tap, because in some Chromium builds (headless) the question crashes the page.
export function voiceSupport(): "none" | "check" | "system" { const C = Cls(); return !C ? "none" : typeof C.available === "function" ? "check" : "system"; }
export async function voiceMode(lang: string): Promise<VoiceMode> {
  const C = Cls(); if (!C) return { kind: "none" };
  if (typeof C.available !== "function") return { kind: "system" };
  try {
    const a = await C.available({ langs: [lang], quality: "dictation", processLocally: true });
    if (a === "available") return { kind: "local", install: false };
    if (a === "downloadable" || a === "downloading") return { kind: "local", install: true };
  } catch { /* treated as unavailable */ }
  return { kind: "none" };
}
export async function installVoice(lang: string): Promise<boolean> {
  const C = Cls(); try { return !!(await C?.install?.({ langs: [lang], quality: "dictation", processLocally: true })); } catch { return false; }
}
export function listen(lang: string, mode: VoiceMode, on: { text: (t: string) => void; end: (error?: string) => void }): Rec | null {
  const C = Cls(); if (!C || mode.kind === "none") return null;
  const r = new C();
  r.lang = lang; r.interimResults = true; r.continuous = false;
  if (mode.kind === "local") r.processLocally = true;
  let err: string | undefined;
  r.onresult = e => { let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; on.text(t); };
  r.onerror = e => { err = e.error; };
  r.onend = () => on.end(err);
  r.start();
  return r;
}
export const voiceError = (e: string) => e === "not-allowed" ? "Vicaria may not use the microphone. Allow it in the browser's site settings."
  : e === "no-speech" ? "Nothing was heard." : e === "language-not-supported" || e === "service-not-allowed" ? "Dictation in this language is not available on this device." : "Dictation stopped.";

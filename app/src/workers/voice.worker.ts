// The neural voice, off the page: loading a voice and making each sentence's audio never holds up reading.
import { serve } from "./rpc";
import { setupOrt, speak, warm } from "../models/piper";

setupOrt();
serve({
  warm: (lang: string) => warm(lang),
  async speak(lang: string, text: string, rate: number) { const r = await speak(lang, text, rate); return { pcm: r.pcm, sampleRate: r.sampleRate }; },
});

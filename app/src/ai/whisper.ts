// The page's side of dictation by Whisper: record from the microphone, turn the recording into 16 kHz mono samples,
// and hand them to the worker. Used only where the browser has no recognizer of its own (see voiceSupport).
import { client } from "../workers/rpc";

const w = client(() => new Worker(new URL("../workers/whisper.worker.ts", import.meta.url), { type: "module" }));
export const canRecord = () => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export interface Recording { stop(): Promise<Float32Array> }
export async function record(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream), parts: Blob[] = [];
  rec.ondataavailable = e => parts.push(e.data);
  rec.start();
  return {
    stop: () => new Promise(ok => {
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        ok(await samplesOf(new Blob(parts, { type: rec.mimeType })));
      };
      rec.stop();
    }),
  };
}
// decoded at 16 kHz (what Whisper reads), channels averaged
async function samplesOf(b: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await b.arrayBuffer());
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < out.length; i++) out[i] += d[i] / buf.numberOfChannels; }
    return out;
  } finally { void ctx.close(); }
}
// Whisper turns silence into a word ("you", "Thank you."): a recording with no voice in it (RMS under -54 dBFS,
// below a quiet room through a phone microphone) gives no text instead
export function silent(samples: Float32Array): boolean {
  let sum = 0; for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return !samples.length || Math.sqrt(sum / samples.length) < 0.002;
}
export const transcribe = async (samples: Float32Array, lang: string) => silent(samples) ? "" : w.call<string>("transcribe", [samples, lang.split("-")[0].toLowerCase()], [samples.buffer]);

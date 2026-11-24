// Piper neural voice, run in the voice worker: espeak-ng turns text into phoneme ids, a VITS model (ONNX Runtime,
// WebAssembly) turns them into 22 kHz audio. Files come from the model downloads (models/opfs.ts), never the network.
import * as ort from "onnxruntime-web/webgpu"; // the same runtime as search by meaning: one download for both
import { setupWasm } from "./ort";
import { modelFile } from "./opfs";
import { ESPEAK_FILES, VOICES } from "./catalog";

interface PiperConfig { audio: { sample_rate: number }; espeak: { voice: string }; inference: { noise_scale: number; length_scale: number; noise_w: number }; speaker_id_map?: Record<string, number> }
type Phonemizer = { callMain(args: string[]): number };

let espeak: Promise<{ wasm: ArrayBuffer; data: ArrayBuffer }> | null = null;
let phon: { mod: Phonemizer; uses: number; out: (s: string) => void } | null = null;
const sessions = new Map<string, Promise<{ s: ort.InferenceSession; cfg: PiperConfig }>>();

async function need(url: string): Promise<File> { const f = await modelFile(url); if (!f) throw new Error("The voice is not downloaded yet."); return f; }

export function setupOrt() { setupWasm(ort.env.wasm); }

// One phonemizer instance serves many sentences (it keeps no state between runs); it is made again now and then,
// since each run leaves its arguments on the stack.
async function phonemizer() {
  if (phon && phon.uses < 200) return phon;
  espeak ??= Promise.all([need(ESPEAK_FILES.wasm), need(ESPEAK_FILES.data)]).then(async ([w, d]) => ({ wasm: await w.arrayBuffer(), data: await d.arrayBuffer() }));
  const files = await espeak;
  const { createPiperPhonemize } = await import("./vendor/piper-phonemize.js");
  const box = { out: (_: string) => {} };
  const mod = await createPiperPhonemize({
    print: (s: string) => box.out(s), printErr: () => {},
    wasmBinary: files.wasm, getPreloadedPackage: () => files.data, locateFile: (u: string) => u,
  }) as Phonemizer;
  phon = { mod, uses: 0, get out() { return box.out; }, set out(f) { box.out = f; } };
  return phon;
}
async function phonemeIds(text: string, voice: string): Promise<number[]> {
  const p = await phonemizer(); p.uses++;
  let ids: number[] = [];
  p.out = s => { try { ids = (JSON.parse(s)[0]?.phoneme_ids ?? JSON.parse(s).phoneme_ids) as number[]; } catch { /* not the output line */ } };
  p.mod.callMain(["-l", voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
  return ids;
}

function session(lang: string) {
  const v = VOICES[lang]; if (!v) throw new Error(`No voice for ${lang}`);
  let s = sessions.get(lang);
  if (!s) {
    s = (async () => {
      const [m, j] = await Promise.all([need(v.onnx), need(v.json)]);
      const cfg = JSON.parse(await j.text()) as PiperConfig;
      return { s: await ort.InferenceSession.create(new Uint8Array(await m.arrayBuffer()), { executionProviders: ["wasm"] }), cfg };
    })();
    s.catch(() => sessions.delete(lang));
    sessions.set(lang, s);
  }
  return s;
}
export async function warm(lang: string): Promise<void> { await session(lang); await phonemizer(); }

// Audio for one sentence (or a short paragraph): samples in -1..1 and their rate
export async function speak(lang: string, text: string, rate = 1): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const { s, cfg } = await session(lang);
  const ids = await phonemeIds(text.trim(), cfg.espeak.voice);
  if (!ids.length) return { pcm: new Float32Array(0), sampleRate: cfg.audio.sample_rate };
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([cfg.inference.noise_scale, cfg.inference.length_scale / rate, cfg.inference.noise_w]), [3]),
  };
  if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
  const out = await s.run(feeds);
  return { pcm: (out.output.data as Float32Array).slice(), sampleRate: cfg.audio.sample_rate };
}

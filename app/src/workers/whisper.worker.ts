// Dictation for browsers with no speech recognizer of their own (Firefox, the Linux app): Whisper base (q8) turns a
// recording into text on this device. Model files come from the model downloads only; nothing goes to the network.
import { serve } from "./rpc";
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { setupWasm } from "../models/ort";
import { modelFile } from "../models/opfs";
import { WHISPER, WHISPER_FILES } from "../models/catalog";

const MODEL = "onnx-community/whisper-base", REV = WHISPER.split("/resolve/")[1];
env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  async match(req: string | Request) {
    const url = typeof req === "string" ? req : req.url;
    const f = WHISPER_FILES.find(n => url.endsWith(`/${n}`) && url.includes(MODEL));
    const file = f ? await modelFile(`${WHISPER}/${f}`) : undefined;
    return file ? new Response(file, { headers: { "content-length": String(file.size) } }) : undefined;
  },
  async put() { /* the downloads own the files */ },
} as never;
setupWasm((env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }).wasm);

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
const model = () => asr ??= (pipeline("automatic-speech-recognition", MODEL, { dtype: "q8", device: "wasm", revision: REV }) as Promise<AutomaticSpeechRecognitionPipeline>).catch(e => { asr = null; throw e; });

serve({
  // mono 16 kHz samples in, text out; `lang` is a language code such as "en" or "es"
  async transcribe(samples: Float32Array, lang: string) {
    const out = await (await model())(samples, { language: lang, task: "transcribe", chunk_length_s: 30 });
    return ((Array.isArray(out) ? out[0] : out).text ?? "").trim();
  },
});

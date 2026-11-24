// The models Vicaria can download, pinned to one revision so a file never changes under a stored copy. Sizes are
// the exact byte counts of those revisions (a download that ends at another size is thrown away).
import type { Model } from "./downloads";

const HF = "https://huggingface.co";
const PIPER = `${HF}/rhasspy/piper-voices/resolve/e9c8a39444359388adaa94255becb37a5a2b8e51`;
const ESPEAK = "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build";
const WHISPER = `${HF}/onnx-community/whisper-base/resolve/27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c`;
const GEMMA = `${HF}/onnx-community/embeddinggemma-300m-ONNX/resolve/5090578d9565bb06545b4552f76e6bc2c93e4a66`;

export type ModelKind = "voice" | "speech" | "search";
export interface CatalogModel extends Model { kind: ModelKind; lang?: string; label: string }

export const ESPEAK_FILES = { wasm: `${ESPEAK}/piper_phonemize.wasm`, data: `${ESPEAK}/piper_phonemize.data` };
const espeak = [{ url: ESPEAK_FILES.wasm, size: 635_212 }, { url: ESPEAK_FILES.data, size: 18_077_249 }];
export const VOICES: Record<string, { voice: string; onnx: string; json: string }> = {
  en: { voice: "en_US-lessac-medium", onnx: `${PIPER}/en/en_US/lessac/medium/en_US-lessac-medium.onnx`, json: `${PIPER}/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json` },
  es: { voice: "es_MX-claude-high", onnx: `${PIPER}/es/es_MX/claude/high/es_MX-claude-high.onnx`, json: `${PIPER}/es/es_MX/claude/high/es_MX-claude-high.onnx.json` },
};
export const CATALOG: CatalogModel[] = [
  { id: "voice-en", kind: "voice", lang: "en", label: "English voice", files: [{ url: VOICES.en.onnx, size: 63_201_294 }, { url: VOICES.en.json, size: 4_885 }, ...espeak] },
  { id: "voice-es", kind: "voice", lang: "es", label: "Spanish voice", files: [{ url: VOICES.es.onnx, size: 63_122_309 }, { url: VOICES.es.json, size: 4_963 }, ...espeak] },
];
export const GEMMA_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data"];
const GEMMA_SIZES = [1_765, 20_323_312, 1_156_830, 567_874, 308_890_624];
CATALOG.push({ id: "search", kind: "search", label: "Search by meaning", files: GEMMA_FILES.map((f, i) => ({ url: `${GEMMA}/${f}`, size: GEMMA_SIZES[i] })) });
export const WHISPER_FILES = ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"];
const WHISPER_SIZES = [2_243, 3_832, 339, 2_480_466, 282_682, 23_201_314, 53_693_315];
CATALOG.push({ id: "speech", kind: "speech", label: "Dictation for browsers without it", files: WHISPER_FILES.map((f, i) => ({ url: `${WHISPER}/${f}`, size: WHISPER_SIZES[i] })) });
export const modelById = (id: string) => CATALOG.find(m => m.id === id);
export { WHISPER, GEMMA };

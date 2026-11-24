// ONNX Runtime's files and thread count, the same for every model (voice, search, dictation). The .mjs is given as a
// real file so the runtime can start its thread workers from it; threads need the page to be cross-origin isolated
// (the service worker sets that up), and about 3 times faster for every model measured.
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";

export const ortFiles = () => ({ wasm: new URL(ortWasm, self.location.href).href, mjs: new URL(ortMjs, self.location.href).href });
export const ortThreads = () => (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
export function setupWasm(w: { wasmPaths?: unknown; numThreads?: number } | undefined) { if (w) { w.wasmPaths = ortFiles(); w.numThreads = ortThreads(); } }

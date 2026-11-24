// Search by meaning: EmbeddingGemma (q8) turns each passage of a book into a vector, in the background and the
// open chapter first, and a question into one when asked. Model files come from the model downloads only.
import { serve, progress } from "./rpc";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { setupWasm } from "../models/ort";
import { modelFile } from "../models/opfs";
import { GEMMA, GEMMA_FILES } from "../models/catalog";
import { passages as readPassages } from "../core/read";
import { readVectors, appendVectors, quantize, nearest, type BookVectors } from "../models/vectors";

const MODEL = "onnx-community/embeddinggemma-300m-ONNX", REV = GEMMA.split("/resolve/")[1];
const MAX_CHARS = 900; // the first 900 characters of a passage: better and faster than the whole passage in the eval
env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
// every file transformers asks for is answered from the downloaded copies; nothing goes to the network
env.customCache = {
  async match(req: string | Request) {
    const url = typeof req === "string" ? req : req.url;
    const f = GEMMA_FILES.find(n => url.endsWith(`/${n}`) && url.includes(MODEL));
    const file = f ? await modelFile(`${GEMMA}/${f}`) : undefined;
    return file ? new Response(file, { headers: { "content-length": String(file.size) } }) : undefined;
  },
  async put() { /* the downloads own the files */ },
} as never;
setupWasm((env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }).wasm);

let ext: Promise<FeatureExtractionPipeline> | null = null;
const model = () => ext ??= (pipeline("feature-extraction", MODEL, { dtype: "q8", device: "wasm", revision: REV }) as Promise<FeatureExtractionPipeline>).catch(e => { ext = null; throw e; });
const embed = async (text: string) => (await (await model())(text, { pooling: "mean", normalize: true })).data as Float32Array;
const Q = "task: search result | query: ", P = "title: none | text: ";

const cache = new Map<string, BookVectors>();
const vectorsOf = async (book: string) => { let v = cache.get(book); if (!v) { v = await readVectors(book); cache.set(book, v); } return v; };
let job: { book: string; stop: boolean } | null = null;

serve({
  // embed the passages of a book not done yet, those of `first` section first; progress goes out as it runs
  async embedBook(book: string, first?: number) {
    if (job?.book === book) return; if (job) job.stop = true;
    const me = { book, stop: false }; job = me;
    try {
      const ps = (await readPassages(book)) ?? [];
      let have = await vectorsOf(book); const done = new Set(have.ids);
      const todo = ps.filter(p => !done.has(p.id)).sort((a, b) => (a.section === first ? -1 : 0) - (b.section === first ? -1 : 0));
      for (let i = 0; i < todo.length && !me.stop; i += 8) {
        const batch = todo.slice(i, i + 8), vecs: Int8Array[] = [];
        for (const p of batch) vecs.push(quantize(await embed(P + p.text.slice(0, MAX_CHARS)))); // as measured: the text alone
        have = await appendVectors(book, have, batch.map(p => p.id), vecs); cache.set(book, have);
        progress({ book, done: have.ids.length, total: ps.length });
      }
      return { done: have.ids.length, total: ps.length };
    } finally { if (job === me) job = null; }
  },
  stop() { if (job) job.stop = true; },
  async status(book: string) { const ps = (await readPassages(book)) ?? []; return { done: (await vectorsOf(book)).ids.length, total: ps.length }; },
  // passage ids by meaning for a question, best first (only among `allow` when given)
  async search(book: string, question: string, k: number, allow?: string[]) {
    const v = await vectorsOf(book); if (!v.ids.length) return [];
    return nearest(await embed(Q + question), v, k, allow ? new Set(allow) : undefined);
  },
});

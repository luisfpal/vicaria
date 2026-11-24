// Reading aloud. Listening starts at once with the best voice installed on the device; once the neural voice for
// the book's language has downloaded, it takes over at the next sentence. The sentence being read is highlighted
// and kept on screen; the lock screen and headphones control it through Media Session.
import { sentences, rankVoices } from "../core/speech";
import { client } from "../workers/rpc";
import { progressOf, startModel, isWanted, onProgress, checkModels } from "../models/client";
import { VOICES } from "../models/catalog";

export interface Utt { block: number; text: string; nodes: { node: Text; at: number }[]; start: number; end: number }
export interface ListenState { on: boolean; playing: boolean; engine: "system" | "neural" | "none"; rate: number; block: number }
type Meta = { title: string; author: string; chapter: string; lang: string; cover?: string };

const voiceWorker = client(() => new Worker(new URL("../workers/voice.worker.ts", import.meta.url), { type: "module" }));
const subs = new Set<() => void>();
export const listen: ListenState = { on: false, playing: false, engine: "none", rate: +(localStorage.getItem("vicaria.rate") || 1), block: 0 };
const emit = () => { for (const s of subs) s(); };
export function onListen(f: () => void) { subs.add(f); return () => subs.delete(f); }
// when a voice finishes downloading, its runtime is loaded once while the device is online (and cached by then)
const warmed = new Set<string>(); let broken = false;
void checkModels();
let waitingForVoice = false; // the device could not speak: reading waits for the neural voice
onProgress(() => {
  for (const l of Object.keys(VOICES)) if (progressOf(`voice-${l}`)?.status === "done" && !warmed.has(l)) {
    warmed.add(l);
    void voiceWorker.call("warm", [l]).catch(() => { broken = true; });
    // the neural voice is ready: it takes over now, from the start of the sentence being read
    if (listen.on && base(meta.lang) === l && (listen.engine !== "neural") && (listen.playing || waitingForVoice)) { waitingForVoice = false; void play(i); }
  }
  emit();
});

// the readable text of each block from a starting block, skipping note numbers, split into sentences
export function utterances(el: HTMLElement, fromBlock: number, lang: string): Utt[] {
  const out: Utt[] = [];
  for (const b of el.querySelectorAll<HTMLElement>("[data-b]")) {
    const block = +b.dataset.b!; if (block < fromBlock || b.parentElement?.closest("[data-b]")) continue;
    const nodes: { node: Text; at: number }[] = []; let text = "";
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
      const p = n.parentElement; if (p?.closest("a.nref, sup.nref, .katex-mathml, script, style, rt")) continue;
      nodes.push({ node: n, at: text.length }); text += n.data;
    }
    for (const s of sentences(text, lang)) out.push({ block, text: s.text, nodes, start: s.start, end: s.end });
  }
  return out;
}
function rangeOf(u: Utt): Range | null {
  const at = (off: number): [Text, number] | null => { for (let i = u.nodes.length - 1; i >= 0; i--) if (u.nodes[i].at <= off) return [u.nodes[i].node, Math.min(off - u.nodes[i].at, u.nodes[i].node.length)]; return null; };
  const a = at(u.start), z = at(u.end); if (!a || !z) return null;
  const r = document.createRange(); r.setStart(a[0], a[1]); r.setEnd(z[0], z[1]); return r;
}

const base = (lang: string) => lang.toLowerCase().slice(0, 2);
export const neuralFor = (lang: string) => VOICES[base(lang)] ? `voice-${base(lang)}` : null;
const neuralReady = (lang: string) => { const id = neuralFor(lang); return !broken && !!id && progressOf(id)?.status === "done"; };
const synth = () => (typeof speechSynthesis !== "undefined" ? speechSynthesis : null);
function systemVoice(lang: string): SpeechSynthesisVoice | null { const s = synth(); return s ? rankVoices(s.getVoices(), lang)[0] ?? null : null; }

let list: Utt[] = [], i = 0, meta: Meta = { title: "", author: "", chapter: "", lang: "en" };
let onEnd: (() => void) | null = null, token = 0, userScrolled = 0;
let ctx: AudioContext | null = null, source: AudioBufferSourceNode | null = null;
const ahead = new Map<number, Promise<AudioBuffer | null>>();
if (typeof addEventListener !== "undefined") for (const t of ["wheel", "touchmove"]) addEventListener(t, () => { userScrolled = Date.now(); }, { passive: true });

function show(u: Utt | undefined) {
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight, reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  if (!u) { reg?.delete("vic-speaking"); return; }
  const r = rangeOf(u); if (!r) return;
  if (H && reg) reg.set("vic-speaking", new H(r));
  listen.block = u.block;
  const box = r.getBoundingClientRect();
  const bar = document.querySelector(".listenbar")?.getBoundingClientRect().height ?? 60;
  if (Date.now() - userScrolled > 4000 && (box.top < 70 || box.bottom > innerHeight - bar - 30)) scrollBy({ top: box.top - innerHeight * 0.35, behavior: "smooth" });
}
function neuralAudio(k: number): Promise<AudioBuffer | null> {
  let p = ahead.get(k);
  if (!p) {
    const u = list[k]; if (!u) return Promise.resolve(null);
    p = voiceWorker.call<{ pcm: Float32Array; sampleRate: number }>("speak", [base(meta.lang), u.text, listen.rate]).then(r => {
      ctx ??= new AudioContext();
      if (!r.pcm.length) return null;
      const b = ctx.createBuffer(1, r.pcm.length, r.sampleRate); b.copyToChannel(r.pcm as Float32Array<ArrayBuffer>, 0); return b;
    }).catch(() => { broken = true; return null; }); // the device voice reads on (play checks broken)
    ahead.set(k, p);
  }
  return p;
}

async function play(k: number) {
  const my = ++token; stopSound();
  if (k >= list.length) { show(undefined); if (onEnd) { onEnd(); return; } stop(); return; }
  i = k; const u = list[k]; show(u); media();
  const useNeural = neuralReady(meta.lang);
  listen.engine = useNeural ? "neural" : synth() ? "system" : "none"; listen.playing = true; emit();
  const next = () => { if (my === token && listen.playing) void play(i + 1); };
  if (useNeural) {
    const buf = await neuralAudio(k); for (let n = 1; n <= 2; n++) void neuralAudio(k + n);
    if (my !== token) return;
    if (!buf) { if (broken) void play(k); else next(); return; }
    ctx ??= new AudioContext(); if (ctx.state === "suspended") await ctx.resume();
    source = ctx.createBufferSource(); source.buffer = buf; source.connect(ctx.destination); source.onended = next; source.start();
    ahead.delete(k - 1);
  } else {
    // the neural voice downloads in the background after the first listen, and takes over when it is ready
    const fetchNeural = () => { const id = neuralFor(meta.lang); if (id && !isWanted(id) && progressOf(id)?.status !== "done") void startModel(id); };
    // no speech engine at all (Android's WebView has none): wait for the neural voice, which picks up from this sentence
    const s = synth(); if (!s) { listen.playing = false; listen.engine = "none"; waitingForVoice = true; emit(); media(); fetchNeural(); return; }
    const ut = new SpeechSynthesisUtterance(u.text); const v = systemVoice(meta.lang);
    if (v) ut.voice = v; ut.lang = v?.lang || meta.lang; ut.rate = listen.rate;
    ut.onend = next;
    // a device that cannot speak (no voice for the language, speech blocked) stops here rather than racing through
    // the book in silence; the neural voice, once downloaded, picks up from this sentence
    ut.onerror = e => { if (my !== token || e.error === "interrupted" || e.error === "canceled") return; listen.playing = false; listen.engine = "none"; waitingForVoice = true; emit(); media(); };
    s.speak(ut);
    fetchNeural();
  }
}
function stopSound() {
  if (source) { source.onended = null; try { source.stop(); } catch { /* already over */ } source = null; }
  synth()?.cancel();
}

// start (or move) reading in an element from a block; onSectionEnd opens the next section, which calls continueIn
export function start(el: HTMLElement, block: number, m: Meta, onSectionEnd: (() => void) | null) {
  meta = m; onEnd = onSectionEnd; ahead.clear();
  list = utterances(el, block, m.lang); listen.on = true;
  if (neuralReady(m.lang)) void voiceWorker.call("warm", [base(m.lang)]).catch(() => {});
  void play(0);
}
export function continueIn(el: HTMLElement, m: Meta, onSectionEnd: (() => void) | null) { if (listen.on) start(el, 0, m, onSectionEnd); }
export function pause() { token++; stopSound(); listen.playing = false; waitingForVoice = false; emit(); media(); }
export function resume() { if (listen.on) void play(i); }
export function toggle() { if (listen.playing) pause(); else resume(); }
export function skip(n: number) { if (listen.on) void play(Math.max(0, i + n)); }
export function setRate(r: number) { listen.rate = r; localStorage.setItem("vicaria.rate", String(r)); ahead.clear(); if (listen.playing) void play(i); else emit(); }
export function stop() { waitingForVoice = false; token++; stopSound(); show(undefined); list = []; listen.on = false; listen.playing = false; listen.engine = "none"; onEnd = null; emit(); media(); }

function media() {
  const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession; if (!ms || typeof MediaMetadata === "undefined") return;
  if (!listen.on) { ms.metadata = null; ms.playbackState = "none"; return; }
  ms.metadata = new MediaMetadata({ title: meta.chapter || meta.title, artist: meta.author, album: meta.title, artwork: meta.cover ? [{ src: meta.cover }] : [] });
  ms.playbackState = listen.playing ? "playing" : "paused";
  const set = (a: MediaSessionAction, f: () => void) => { try { ms.setActionHandler(a, f); } catch { /* not supported here */ } };
  set("play", resume); set("pause", pause); set("stop", stop); set("previoustrack", () => skip(-1)); set("nexttrack", () => skip(1));
}

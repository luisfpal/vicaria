# Performance decisions

Every heavy job in Vicaria runs on the option that measured fastest on real devices. This file records each
choice, the numbers behind it, and what would make us change it. Numbers come from `app/bench/` and are
re-run in CI on every push.

Machine for the numbers below: a Linux x86 box running headless Chromium 1255. "4x" means Chrome's CPU throttle
set to 4, which approximates a mid-range phone. Times are medians of 5 runs unless noted.

## EPUB import: TypeScript in a Web Worker

Parsing runs in a module worker (fflate to unzip, htmlparser2 in XML mode), so the page never waits on it.

| Book | Size | Import to first text (Chrome, 1x) |
| --- | --- | --- |
| Meditations (Standard Ebooks, 122 notes) | 0.7 MB | 82 ms |
| The Art of War (Gutenberg) | 0.4 MB | 79 ms |
| Don Quijote (Gutenberg, Spanish) | 1.1 MB | 252 ms |
| A First Course in Linear Algebra (10,281 MathML elements) | 1.1 MB | 1,304 ms |
| Arabic sample (right to left) | 0.1 MB | 47 ms |
| Sous le vent (fixed layout) | 1.2 MB | 73 ms |
| Kusamakura (Japanese, vertical) | 17.9 MB | 444 ms |

Chrome's CPU throttle does not reach workers, so these are desktop-speed numbers. A phone is roughly 3 to 5 times
slower, which puts the math-heavy book at 4 to 6 seconds. Profiling shows the time goes to tokenizing XML (about
30%), garbage collection (about 25%) and writing MathML, not to any single slow step. One pass that walked every
element four times now walks it once, and text escaping skips strings with nothing to escape: together 30% faster
on the math book with identical output (the snapshot tests did not change).

Next step if a phone measurement misses the 2 second budget: show the first section as soon as it is parsed and
finish the rest in the background, then try a Rust parser compiled to WebAssembly (quick-xml) and keep whichever
is faster on the phone.

## Library and reader: main thread, IndexedDB, nothing heavy

The page bundle has no parser in it: 18.9 KB of JavaScript gzipped at first load (budget 80 KB). The library list
paints from a localStorage snapshot, then refreshes from IndexedDB. A book is stored as a small head (metadata,
contents, notes) plus one record per section, so opening a book reads two records, never the whole book.
Pressing or hovering a cover starts those two reads before the tap finishes.

| Measure (4x CPU) | Median | Budget |
| --- | --- | --- |
| First paint, first visit | 56 to 128 ms | 300 ms |
| Library interactive, first visit | 58 to 119 ms | 600 ms |
| Library interactive, later visits | 58 to 74 ms | 600 ms |
| Open a book from the library | 131 ms (215 ms if tapped in the first 100 ms after launch) | 200 ms |
| Open a book by URL, full page load | 212 to 235 ms | 600 ms |
| Next chapter | 41 to 49 ms | 200 ms |
| Footnote popover, tap to visible | 37 to 44 ms | 50 ms |
| Filter a 1,000 book library | 35 to 46 ms | 100 ms |
| Ideas page: list of 1,000 books ready | 81 to 84 ms (233 ms the first time after a load) | 600 ms |
| Ideas page: search 1,000 books | 3 to 8 ms | 100 ms |
| Ideas page: slowest frame (95th percentile) scrolling the whole list | 16.7 ms (every frame at 60 Hz) | 20 ms |
| Ideas page: Graph tap to drawn, 1,000 books | 3.1 s | 5 s |

Ranges are the medians of separate runs on a shared machine. Of the 131 ms to open a book, about 57 ms is reading
storage and the rest is layout and paint of a long chapter.

For comparison, the 0.x app (Python in the browser) took 3.1 to 4.8 seconds to show the library on a first
visit and about 2.1 seconds to open a chapter (`docs/perf/baseline.json`).

## On-device models: what downloads, and why

The app works at once without any of these. Each one downloads in the background after the reader agrees, and the
feature that waits for it says so and turns on when it is ready. All run in WebAssembly through ONNX Runtime Web
(one shared runtime, 7.2 MB gzipped, fetched when a model is first used, never part of the first load). Numbers below are from headless Chromium on the box: "4 threads" where the
page is cross-origin isolated, "1 thread" where it is not (the web app on GitHub Pages today). A phone is roughly
3 to 5 times slower than the box.

### Neural voice: Piper, one voice per language

| Voice | Download | Real-time factor, 4 threads | 1 thread | First short sentence |
| --- | --- | --- | --- | --- |
| Piper en_US lessac medium | 63 MB | 0.068 | 0.20 | 0.2 s |
| Piper en_US hfc_female medium | 63 MB | 0.067 | | 0.2 s |
| Piper es_MX claude high | 63 MB | 0.056 | 0.20 | 0.2 s |
| Piper es_ES davefx medium | 63 MB | 0.052 | | 0.2 s |
| Kokoro 82M q8 (English) | 92 MB | 1.13 | | 2.1 s |
| Kokoro 82M fp32 (English) | 330 MB | 0.75 | | |

Real-time factor is seconds of work per second of speech; below 1 means it keeps ahead of playback. Piper is about
17 times faster than Kokoro at the same size, so it keeps ahead on a phone even on one thread (0.20 on the box,
about 0.6 to 1.0 on a phone), where Kokoro would stall. The text is turned into sounds by espeak-ng (18 MB, 9 MB
gzipped, shared by all voices; GPL-3, compatible with the AGPL). Defaults: lessac for English, claude (Mexico) for
Spanish. A Whisper round trip (below) recognizes what these voices say with a 1.5% word error rate in English.

The system voice still speaks first: listening starts at once with the best installed voice, and the neural voice
takes over at the next sentence once it has downloaded.

### Speech to text: the browser's own recognizer, Whisper base only where there is none

Chrome 139 and later can recognize speech on the device, and Safari does for its languages; Vicaria uses those
first. Where the browser has no recognizer (Firefox, the Linux app), Whisper base (q8) is downloaded:

| Model | Download | WER English | WER Spanish | Per question, 4 threads | 1 thread |
| --- | --- | --- | --- | --- | --- |
| Whisper tiny q8 | 41 MB | 1.5% | 25% | 0.6 s | 1.4 s |
| Whisper base q8 | 77 MB | 1.5% | 11% | 1.0 s | 2.7 s |
| Whisper small q8 | 249 MB | 0% | 8% | 2.9 s | |

Test set: 6 English and 6 Spanish reader questions (3 to 4 seconds each) spoken by the Piper voices, so real voices
in real rooms will score worse; the ranking between models is what this decides. Tiny loses too much Spanish; small
is too slow for a phone. Moonshine is English only.

### Search by meaning: EmbeddingGemma 300M (q8) with BM25

Eval set: 39 questions about Meditations (30 paraphrases asked in English and in Spanish, 9 keyword questions)
against its 146 passages. Recall at 5 / mean reciprocal rank:

| Method | English | Spanish | Per passage, 4 threads | Download |
| --- | --- | --- | --- | --- |
| BM25 (no download), paraphrases | 0.50 / 0.43 | 0.03 / 0.03 | instant | 0 |
| BM25, keyword questions | 1.00 | | | |
| multilingual-e5-small q8 | 0.72 / 0.57 | 0.64 / 0.46 | 127 ms | 118 MB |
| EmbeddingGemma 300M q8, first 900 characters | 0.97 / 0.93 | 0.97 / 0.88 | 496 ms | 309 MB |
| EmbeddingGemma 300M q8, whole passage | 0.95 / 0.89 | 0.95 / 0.87 | 842 ms | 309 MB |

BM25 cannot answer a Spanish question about an English book; EmbeddingGemma can. Mixing the two rankings (RRF)
made paraphrases worse, so they are not mixed: a question sends the top 6 passages by meaning plus the top 2 by
BM25 (recall at 8: English 0.97 by meaning, 1.00 with BM25 added). Until a book is embedded, BM25 alone answers.
Embedding is slow on the CPU (a 3,000-passage book takes about 25 minutes on 4 threads), so it runs in the
background, the open chapter first, and is saved per book. The 4-bit build needs an operator the WebAssembly
runtime lacks, and the version without it was 4.5 times slower. Model terms: the Gemma license.

### Threads

One thread is about 3 times slower for every model here. Threads need the page to be cross-origin isolated, which
GitHub Pages cannot set, so the service worker adds `Cross-Origin-Embedder-Policy: credentialless` and
`Cross-Origin-Opener-Policy: same-origin` to every answer it gives (`scripts/sw.template.js`). Credentialless keeps
covers and other pictures from other sites loading (fetched without cookies; checked in `e2e/firstrun.e2e.mjs`);
the app opens no sign-in windows, which `same-origin` would cut off from their opener. The first visit is not
controlled yet, so the page is isolated from the second load on. ONNX Runtime also needs its `.mjs` as a real file to
start its thread workers (given through `models/ort.ts`; without it the isolated page hung at 0 of 146 passages).
Measured on the Mac (15 cores, headless Chromium), embedding Meditations (146 passages, EmbeddingGemma q8):
119 s on one thread, 40 s isolated with 4 threads, 3.0 times faster.

### Dictation without a recognizer: Whisper base

Only where the browser has no speech recognizer of its own (Firefox, the Linux app). The first tap on the
microphone downloads the model (79.7 MB, once, shown in Settings under On this device); later taps record, then
write the question on the device. A spoken test sentence ("What does Marcus Aurelius say about anger") is
transcribed correctly in `e2e/firstrun.e2e.mjs`.

## Still to measure

WebGPU for the three models above (expected to be much faster where available), and the same models on the
phones. The same rule applies: the fastest option that works on the device wins.

## Ideas page at 1,000 books

- The list builds only the rows on screen: about 18 of 1,011 exist at any time, placed by a table of row offsets and
  found by binary search while scrolling. Search is one pass over a lowercased string per book (title, author, tags);
  3 to 8 ms at 1,000 books at 4x CPU.
- The graph is sigma.js (WebGL) on graphology, loaded only when the Graph view opens (it is not in the first paint:
  initial JS 42.8 KB gzip). Books are nodes; two books are joined when they share a tag or an author. Books that share
  a thing are ordered and each joins the next two, so a tag on 500 books makes 1,000 edges, not 125,000. A tag or
  author on more than 400 books joins nothing. Groups come from label propagation (fixed order, so the same library
  always gives the same groups) and each group is named by its most common tag. ForceAtlas2 settles the layout in
  slices of 8 iterations that give the page back between slices (120 iterations above 400 books).
- Labels follow sigma's size rule: a name shows once its dot is big enough on screen, so zooming in reads more names.
- Not done yet: edges by meaning (embedding similarity) and shelf grouping (the data has no to-read or finished state yet).
- Not measured: a real Android phone (frames and memory), and Safari and Firefox WebGL.

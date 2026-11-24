# Architecture

Vicaria is a reader for EPUB and PDF books that runs entirely on the reader's devices: a web app (a PWA) that the
desktop and Android apps wrap unchanged. There is no server of ours that holds user data.

## Repository layout

| Path | What it is |
| --- | --- |
| `app/` | The app: TypeScript, Preact, Vite, Vitest, Playwright. Everything below is about this. |
| `app/src-tauri/` | Tauri 2 shell for Mac, Linux and Android. It adds the native updater and nothing else. |
| `book_reader/`, `standalone/` | The previous (0.x) version, Python running in the browser. Still deployed at the site root so existing users keep working; the new app is served under `/next/`. |
| `get/` | The download page and the one-line installer (`install.sh`). |
| `fastlane/` | Store text and screenshots for F-Droid style listings. |
| `docs/` | This documentation, performance decisions, screenshots. |
| `tests/` | Real books (`corpus/`) and fixtures shared by the unit and end-to-end tests. |
| `.github/` | CI, release and site deployment workflows, issue templates. |

## The app (`app/src`)

| Folder | Role |
| --- | --- |
| `core/` | Data and logic with no UI: EPUB and PDF reading, the op log, marks, library, migrations, ideas, export. Pure where possible, so it is unit tested without a browser. |
| `workers/` | Heavy work off the page: import and re-import, search in a book, backup, model downloads, voice, embeddings, speech to text. Talk to the page through `rpc.ts`. |
| `ai/` | Asking a book: choosing passages (`retrieve.ts`), provider calls (`providers.ts`), answers that cite passages (`ask.ts`, `render.ts`), chapter cards, voice. |
| `models/` | On-device models: resumable downloads into OPFS, ONNX Runtime, the Piper voice, search by meaning. |
| `sync/` | Device to device sync: the protocol, WebRTC and relay transport, pairing. |
| `ui/` | Screens and components. The library and reader paint without waiting for any worker. |
| `i18n/` | English (`en.ts`, the source) and Spanish (`es.ts`); same keys, same slots, checked by a test. |

## Data model

Stored data is the durable asset, so it is small, explicit and versioned. Details and the rules for changing it are
in `docs/MIGRATIONS.md`.

- **Originals**: the EPUB or PDF bytes, named by SHA-256, never modified. OPFS where available, IndexedDB otherwise.
- **Op log**: an append-only set of operations (highlights, notes, bookmarks, reading positions, settings, shelf
  state), merged by id and read last-writer-wins by a hybrid logical clock. Union is commutative, associative and
  idempotent, so devices agree after merging in any order any number of times. The envelope is frozen.
- **Derivatives**: parsed sections, passages, anchors and search data. Rebuilt from the original whenever
  `PARSER_VERSION` rises, so they never need a migration.
- **Marks** are anchored to a quote and position inside a book; when the parser changes, they are re-anchored by
  their quote (`core/reanchor.ts`, `core/fuzzy.ts`).

## Speed

The library list paints from a small snapshot before the database opens. A book is stored as a head plus one record
per section, so opening reads two records. Parsing and indexing run in workers. Budgets for first paint, opening a
book, a 1,000 book library, the Ideas page and initial JavaScript are in `app/bench/budgets.json`, measured at 4x CPU
throttle by `app/bench/run.mjs` in CI. Why each heavy job runs the way it does, with the numbers, is in
`docs/perf/perf-decisions.md`.

## Ask

A question goes to the provider the reader chose, with the reader's own key, straight from the device. What is sent
is the question and a few passages chosen on the device (BM25 plus, when downloaded, search by meaning), limited to
what the reader has already read unless they ask for the whole book. Answers cite passage ids, which the UI turns
into links back to the page.

## Sync

Devices pair by scanning a code that carries a shared key. They exchange summaries of the op log and send what the
other lacks (see the header of `sync/protocol.ts`). Transport is WebRTC peer to peer, found through public Nostr
relays; when two devices are not online together, an encrypted copy waits on the relays. A TLA+ model of the protocol
is checked in CI (`app/spec/`).

## Offline and updates

A service worker built by `app/scripts/postbuild.mjs` precaches the exact file list under a content hash. Big,
rarely needed code (math, diagrams, PDF, voice runtime) is fetched on first use and then kept. How a new build reaches
devices, and how a bad one is pulled, is in `docs/RELEASING.md`.

## Tests

- Unit: `app/tests/` (Vitest), including schema, upgrade-from-saved-library fixtures and an EPUB corpus.
- Model check: `app/spec/check.sh` (TLC on the sync model).
- End to end: `app/e2e/*.e2e.mjs` in a real browser (Chromium, plus WebKit for Safari behaviour), including
  upgrade of a real 0.x library, sync between two devices, ask against a mocked provider, accessibility (axe),
  language, errors, updates.
- Budgets: `app/bench/`.
- Everything together: `app/scripts/full-suite.sh`.

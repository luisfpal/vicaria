# Wiser: a daily thought, lessons, and a new mark

Goal: a reader should go to bed a little wiser than they woke up. The idea matters, not who said it, and the world is
the school. Two small features and one mark, all calm: nothing nags, nothing is on by default that costs money or
attention, and a reader who ignores them never sees a change in the library, the reader or Ask.

## 1. Daily thought

One or two sentences, once a day. A quiet card above the shelf the first time the app opens that day. It has a close
button and a save (heart) button. Closing it, or opening the app again, never brings it back that day.

Three tiers, each complete on its own. The first that can run wins:

1. **AI connected.** One cheap call (the same route as Ask, DeepSeek Flash with thinking off). The prompt asks for the
   one-liner shape: a real friction point, a concrete action, a reframe, drawn from a handful of the reader's own
   highlights, notes and tags. If the call fails or takes more than 12 s, tier 2 runs instead and nothing is shown
   as an error.
2. **Highlights, no AI.** A pick from the reader's own highlights and notes, weighted for spaced repetition and
   serendipity (below), shown with its book.
3. **Ideas only** (tags, no highlights, or the highlights are not usable). A mental model from the lattice: two books
   in different clusters, joined by a question ("Where does X from A meet Y from B?").

Cold start (fewer than two books, or nothing marked yet): a bundled set of 15 public domain thoughts (Seneca, Marcus
Aurelius, Epictetus, Franklin, Montaigne) in English and Spanish, each with one line of "try this today". They rotate
without repeating until all were shown.

**Selection.** Each candidate has a weight `w = (1 + days since last shown) / 2^shown`, times 1.5 if it carries a
note, times a small random factor from a generator seeded with the date, so the pick is stable within a day. Never
shown items start with `shown = 0`: older, forgotten highlights outrank the newest ones as days pass, and what was
just surfaced sinks for a long time (each showing halves the weight). Sampling is weighted and without replacement.

**Cost control.** The model never sees a book. It gets at most 6 highlights (each cut to 280 characters), 4 tags and
the titles of 3 books, about 900 tokens in and at most 120 out. A daily budget of 30,000 tokens across thoughts and
lessons is counted on the device; past it the AI tiers pause until tomorrow and the next tier answers.

**Delivery.** The card, first. Optional notifications are off by default: one per day at the chosen time, through the
Web Notifications API where the browser offers it (installed PWA, desktop browsers, Chrome on Android), with no
server. A page that is closed cannot be woken by the web platform without a push server, so the notice shows while
Vicaria is open or running in the background; the setting says this in plain words. Native desktop and Android shells
need a notification plugin and a permission; that is listed as not done.

Saving a thought writes a `thought` op (below). Unsaved thoughts leave no trace except the device-local record that
stops them returning.

## 2. Lessons

On demand from a quiet "Lessons" screen (reached from the card and the library footer, no new tab), plus at most one
gentle offer a day ("Want a lesson?", on the daily card, dismissed for the day with one tap).

A lesson is 150 to 300 words about one mental model and the people behind it: first principles, concrete example,
a move for today, no fluff. With AI it is written for this reader (their people, books and topics). Without AI the
screen shows five bundled lessons (Franklin's ledger, Seneca on time, the circle of control, Montaigne's doubt,
inversion) and says that AI makes them personal.

**Blueprint and settings.** The blueprint is fixed in code: structure (title, model, first principles, example, one
move), quality rules (no platitudes, no invented quotes, say where a claim is a paraphrase), and the JSON the app
parses. The editable parts live in Settings: people to learn from (authors in the library are suggested, anyone can
be added; a switch includes people the reader has not read), tone, length (short, medium, long), topics. Advanced:
the prompt template (voice and instructions with `{people}`, `{tone}`, `{length}`, `{topics}`, `{avoid}` slots) can
be viewed, edited and reset. Editing it never touches the blueprint.

**Memory.** Every lesson is stored with title, people, models, a short summary and its text. The generator is
given the last 12 titles and summaries so it does not repeat and can build on them. Lessons are searchable by any
word of those fields.

**Follow-up chat** reuses Ask: the same `Turn` records, `loadChat` / `saveChat` under the key `chat:lesson:<id>`, the
same `stream` and answer rendering. A thread longer than 20 turns folds its older part into one summary turn (a short
model call), so chats stay small.

## 3. Data

Both features are ops, so they travel with the existing log, merge by the same rules and sync with no new transport.

| Op kind | `v` | Meaning |
| --- | --- | --- |
| `thought` | `{ id, text, by?, book?, src, day, gone? }` | a saved thought; newest op per `id` wins |
| `lesson` | `{ id, title, body, people[], models[], summary, topics[], lang, src, made, fav?, gone? }` | a lesson and its memory |
| `wiser` | `{ people[], outside, tone, length, topics[], template }` | the reader's customisation; newest op wins |

Decision: no new IndexedDB store and so no schema step. `docs/MIGRATIONS.md` says a new kind of data is a new op
kind: devices that do not know it store and forward it. Lessons are few (hundreds at most) and are read by folding the
log, as marks are. An upgrade test loads each saved library (v1 to v4) with the new code, adds the three kinds, and
checks every old record is unchanged. Device-only state (what was shown, the token budget, notification time) lives in
`localStorage` and `kv`, which are never synced.

Everything loads lazily (a separate chunk, plus the Spanish bundled text only in Spanish), so the first script stays
under its 40 KB budget. The library imports one tiny gate that decides after start-up whether to fetch the chunk.

## 4. The mark

The reference mark (a V of five graph nodes, the arms closed by a bar into a triangle) stays. Three concepts are in
`docs/logo-concepts`, drawn by `app/scripts/logo-concepts.mjs` from one shared geometry:

- **a-bar**: the reference, made exact. Arms run straight through the joints, so the silhouette is a clean V; the bar
  closes a triangle of negative space (convergence). The vertex node is 16% larger because a point where two lines
  end looks lighter than one at the tip of a free arm. Stroke 6.4 units on a 100 unit tile, nodes 6.8 to 8.6.
- **b-low**: the bar sits near the vertex. A smaller triangle and longer open arms (a passage), but the V softens
  towards a Y.
- **c-hub**: no bar; a node floats in the mouth of the V, joined to both joints (emergence). It reads as a face or
  antlers at small sizes.

**Choice: a-bar.** It is the only one whose silhouette is a V at 16 px, it has the fewest parts that still say
"graph", and the triangle is the one piece of negative space that carries meaning. Colour: ink on warm ivory, with
one accent, the terracotta vertex node, the point where lines converge, which is where the reader stands. The
Android monochrome icon is the same shape in one colour (the accent node becomes ink), and the adaptive foreground
sits inside the 66% safe circle. Every size is rebuilt by `scripts/make-icons.mjs` then `npx tauri icon`. The
hourglass is retired.

## 5. Checks

Unit: selection and serendipity, cold start, token cap, memory and search, prompt assembly, parsing, chat folding.
End to end: the card shows once a day, dismisses, saves; a lesson from a mocked model; a follow-up; customisation;
the no-AI tiers; English and Spanish. Budgets: initial JavaScript stays under 40 KB gzip. One live DeepSeek check per
feature, under $0.20 in total.

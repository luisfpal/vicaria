# Changing stored data

Readers keep years of notes in Vicaria. An update must never lose or break them, on any device, even when another
device still runs an older version. These rules are checked in CI; a change that breaks them fails the build.

## What is stored where

| Data | Where | Source of truth? | Version |
| --- | --- | --- | --- |
| Original EPUB files | OPFS (IndexedDB `originals` when OPFS is missing) | yes, never modified | none (named by SHA-256) |
| Op log: marks, notes, bookmarks, positions, settings, shelf | IndexedDB `ops`, `segs`, `opids`, `kv` | yes | frozen envelope, see below |
| Book derivatives: `books`, `heads`, `sections`, `passages`, `images`, `anchors` | IndexedDB | no, rebuilt from the EPUB | per book: `v` (parser version) |
| IndexedDB structure (stores, indexes) | IndexedDB | n/a | `DB_VERSION` in `src/core/idb.ts`, listed in `app/schema.json` |

## Adding or changing a store or an index

1. Add one step at the end of `MIGRATIONS` in `app/src/core/migrations.ts`. Step `n` takes the database from version
   `n - 1` to `n`. It runs inside IndexedDB's upgrade transaction: use only that transaction, no `await` on anything
   else. If it throws, the whole upgrade is undone by the browser and the app keeps the old version.
2. Make it idempotent (check before you create) and additive: never delete or rename a store, index or field that
   the previous release reads. A breaking change needs a new major version and a new database name.
3. Bump `DB_VERSION` to the new length of `MIGRATIONS`.
4. In `app/`, run `WRITE_SCHEMA=1 npx vitest run tests/schema.test.ts` and commit the new `app/schema.json`.
5. Keep every fixture in `app/tests/fixtures/` (`db-v<N>.json`, a real library saved at version N). Save one for the
   new version with `WRITE_FIXTURE=1 npx vitest run tests/library-fixture.test.ts`, extend what it writes if your
   change stores something new, and run `npm test`. Each fixture is loaded at its own version and opened with the new
   code; every record must still be there, unchanged, and marks, notes, positions and settings must read the same.
   Never edit or delete an old fixture to make a test pass.

CI fails when: the schema built from code differs from `schema.json`; `DB_VERSION` differs from the number of
migration steps; `schema.json` lost a store or an index; there is no fixture for the current version; or any
upgrade fixture loses or changes a record. Libraries from 0.x are covered by `e2e/legacy.e2e.mjs`, which upgrades a
real 0.x library in a browser.

## Changing the op log

- The envelope `{ id, dev, t, c, k, v, b }` is frozen. Put new data inside `v`.
- A new kind of op is a new `k`. Devices that do not know it store and forward it unchanged and ignore it when
  folding. Never reuse a `k` with a different meaning.
- A new field of a mark goes inside `v.set`. Folds must ignore fields they do not know (`validSet(set, false)`), and
  edits must write only the fields they change, so an older device never erases a field a newer one wrote.
- Never rewrite or delete stored ops in a migration. If the meaning of old ops changes, interpret them when folding.

## Changing how books are derived (parser, passages, anchors, search data)

Bump `PARSER_VERSION` in `app/src/core/types.ts` and say what changed in its comment. Each book records the version
it was read with (`v`). At every launch the books worker's `refresh` re-reads each older book from its original EPUB,
one book per transaction (an interrupted run resumes with the next older book), then re-anchors marks made against
the old reading (`relocateStale`). Do not write a migration for derived data: rebuild it. A new kind of derived data
(for example AI cards or an index) gets its own per-book version next to `v` and the same treatment.

## Releases and holdback

`update.json` at the site root (never cached) can pull or hold back a build. Build ids are in `version.txt`.

```json
{ "bad": ["6f3b581a509f"], "rollout": 10, "build": "169c4d97bbd2" }
```

- `bad`: a device running a listed build steps back to the build it had before (the service worker keeps it).
- `rollout` with `build`: only that share of installed devices takes that build for now; the rest keep theirs.

To pull a bad release, add it to `bad` and revert the deploy. `e2e/updates.e2e.mjs` checks step back, upgrade and
waiting for busy work with real builds in a real browser.

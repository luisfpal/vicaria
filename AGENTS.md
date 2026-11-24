# Working on Vicaria

For contributors and AI coding agents. Read this before changing anything; it is short on purpose.

## What matters here

1. **Data is the durable asset; code is cheap.** A reader's books, highlights and notes outlive every version of the
   app. Code can be rewritten in an afternoon, stored data cannot be rewritten at all. Never risk the data to
   simplify the code.
2. **Every bug becomes a permanent test.** Fix the cause, then add the test that would have caught it, in the layer
   that sees it first (unit, fixture, end to end). A failure seen twice with the same root cause becomes a check in
   `app/scripts/full-suite.sh` before anything else moves on.
3. **Speed is a feature, with budgets in CI.** `app/bench/budgets.json` holds the limits (first paint, opening a book,
   a 1,000 book library, initial JavaScript). A change that breaks a budget fails the build. Raise a budget only
   with a measurement and a written reason in `docs/perf/perf-decisions.md`.
4. **The simplest end-user experience comes first.** No account, no setup wall, works offline, one obvious next step.
   If a feature needs an explanation, change the feature before writing the explanation.
5. **Small, verified steps.** One change, one check, one commit. State what you expect before running a check, then
   compare. After two failures on the same point, question the assumption they share instead of trying a third
   variation.
6. **Never weaken a test to make it pass.** Do not skip, loosen, delete or edit an assertion, a fixture or a
   budget to get green. If a test is wrong, say why in the commit that changes it. Old upgrade fixtures are never
   edited.
7. **Migrations are idempotent and lose nothing.** They are additive, safe to run twice, safe when another device
   still runs an older build, and tested against saved real libraries. See `docs/MIGRATIONS.md`.

## Before you change stored data

Read `docs/MIGRATIONS.md` before touching `app/src/core/idb.ts`, `migrations.ts`, `ops.ts`, `marks.ts`, the book
derivation (`PARSER_VERSION`), or `app/schema.json`. The tests in `app/tests/` (schema, upgrade, fixtures) enforce it.

## Commands

```
cd app
npm ci
npx tsc --noEmit -p .        # types
npm test                     # unit tests (Vitest)
node scripts/public-text.mjs # public text rules
bash scripts/full-suite.sh   # everything CI runs: unit, model check, end to end, budgets
```

The end-to-end scripts live in `app/e2e/` and are listed in `.github/workflows/ci.yml`. WebKit runs:
`npx playwright install webkit`, then `VIC_ENGINE=webkit node e2e/<name>.e2e.mjs <url>`.

## Layout

See `docs/ARCHITECTURE.md`. In short: `app/` is the app (TypeScript, Preact, Vite), `app/src-tauri/` the desktop and
Android shell, `book_reader/` and `standalone/` the previous Python version that stays online for existing users,
`get/` the download page, `docs/` the documentation, `fastlane/` the store text.

## Style

- Public text (UI strings, README, docs, release notes): plain words, no em dashes. `node app/scripts/public-text.mjs`
  checks it.
- Every user-visible string goes through `app/src/i18n/en.ts` and `es.ts`; both must have the same keys.
- Match the code around you. Comments say why, not what.
- No new dependency without a reason that fits in the commit message. Prefer deleting code to adding it.
- Keys, tokens and keystores never go in the repository, in a test, or in a log. Test keys are obvious fakes.

## Releases

See `docs/RELEASING.md`. Nothing is published from a local machine; a tag builds and drafts the release.

# Contributing

Bug reports and ideas are welcome as GitHub issues. Security problems go through the private route in
[SECURITY.md](SECURITY.md).

## Code

Read [AGENTS.md](AGENTS.md) first: it holds the working rules, the commands and the layout, and applies to people
and tools alike. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit;
[docs/MIGRATIONS.md](docs/MIGRATIONS.md) is required reading before touching stored data.

Before opening a pull request, run `cd app && npx tsc --noEmit -p . && npm test`. CI runs the end-to-end tests and the
performance budgets. A bug fix comes with the test that would have caught it.

## Contributor License Agreement

Code contributions need a signed Contributor License Agreement before they can be merged. The agreement lets the
project keep a single copyright holder, so it can be relicensed or offered under additional terms later; you keep the
right to use your own contribution however you like. Open an issue saying what you'd like to change and we'll send
the agreement.

By opening a pull request you confirm the work is yours to contribute.

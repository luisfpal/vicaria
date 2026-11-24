#!/usr/bin/env bash
# Model-check the hello and ops exchange with TLC. Needs Java; fetches tla2tools.jar once.
#   New.cfg     the rule the app uses: must hold (devices converge, nobody is stuck)
#   Old.cfg     the earlier rule: TLC must find the stuck state (keeps the model honest)
#   Vacuity.cfg quiet states must exist, so the invariants are not true for want of cases
#   New3.cfg    three devices (gossip through a middle device); slow, run with "all"
set -euo pipefail
cd "$(dirname "$0")"
JAR=${TLA_JAR:-$HOME/.cache/tla2tools-1.8.0.jar}
[ -f "$JAR" ] || { mkdir -p "$(dirname "$JAR")"; curl -sSLo "$JAR" https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar; }
run() { java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers auto -noGenerateSpecTE -config "$1" -metadir "$(mktemp -d)" SyncHello.tla 2>&1 || true; }
expect() { local out; out=$(run "$1"); if grep -q "$2" <<<"$out"; then echo "ok   $1: $2"; else echo "FAIL $1: wanted '$2'"; echo "$out" | tail -30; exit 1; fi; }
expect New.cfg "No error has been found"
expect Old.cfg "Invariant Converged is violated"
expect Vacuity.cfg "Invariant NotQuiet is violated"
[ "${1:-}" = all ] && expect New3.cfg "No error has been found"
exit 0

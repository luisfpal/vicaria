#!/usr/bin/env bash
# The whole suite: types, unit, spec, build, every e2e, budgets. Prints SUITEFAIL lines for failures.
set -x
# listen.e2e needs VIC_MODELS: a folder with the Piper voice and espeak-ng files; firstrun.e2e needs VIC_GEMMA and
# VIC_WHISPER (default: a models folder two levels above the repository, with gemma, whisper and piper inside, laid out as on Hugging Face)
cd "$(dirname "$0")/.."
# Portable: macOS has no timeout(1); use perl's alarm. Java may live in a user folder (no Homebrew).
command -v timeout >/dev/null || timeout() { perl -e 'alarm shift; exec @ARGV' "$@"; }
[ -z "${JAVA_HOME:-}" ] && [ -d "$HOME/.local/jre" ] && JAVA_HOME=$(ls -d "$HOME"/.local/jre/*/Contents/Home 2>/dev/null | head -1) && export PATH="$JAVA_HOME/bin:$PATH"
[ -z "${VIC_MODELS:-}" ] && [ -d "$PWD/../../models/piper" ] && export VIC_MODELS="$PWD/../../models/piper"
node scripts/public-text.mjs || echo "SUITEFAIL public-text"
npx tsc --noEmit -p . || echo "SUITEFAIL tsc"
npm test >/tmp/unit.log 2>&1 && tail -5 /tmp/unit.log || echo "SUITEFAIL unit"
spec/check.sh > /tmp/tlc.log 2>&1 && tail -2 /tmp/tlc.log || echo "SUITEFAIL tlc"
VIC_BASE=/vicaria/next/ npm run build > /tmp/build.log 2>&1 || echo "SUITEFAIL build"
(node bench/serve.mjs dist 47812 /vicaria/next >/dev/null 2>&1 &); sleep 1
U=http://127.0.0.1:47812/vicaria/next
for t in legacy marks background shelf sync wiser progress providers; do timeout 600 node e2e/$t.e2e.mjs $U 2>&1 | rg -v "Failed to load resource" | tail -4 || true; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL $t"; done
timeout 600 node e2e/paint.fuzz.mjs 2>&1 | tail -3; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL paint"
mkdir -p /tmp/taste/ask; timeout 600 node e2e/ask.e2e.mjs $U /tmp/taste/ask 2>&1 | rg -v "Failed to load resource" | tail -5; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL ask"
timeout 600 node e2e/pdf.e2e.mjs $U /tmp/taste/pdf 2>&1 | rg -v "Failed to load resource" | tail -4; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL pdf"
mkdir -p /tmp/taste/ideas /tmp/taste/p8
timeout 900 node e2e/ideas.e2e.mjs $U /tmp/taste/ideas 2>&1 | rg -v "Failed to load resource|GL Driver" | tail -4; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL ideas"
timeout 600 node e2e/listen.e2e.mjs $U 2>&1 | rg -v "Failed to load resource" | tail -4; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL listen"
timeout 900 node e2e/firstrun.e2e.mjs $U 2>&1 | rg -v "Failed to load resource" | tail -4; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL firstrun"
timeout 600 node e2e/errors.e2e.mjs $U /tmp/taste/p8 2>&1 | rg -v "Failed to load resource" | tail -4; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL errors"
timeout 900 node e2e/axe.e2e.mjs $U 2>&1 | tail -6; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL axe"
timeout 600 node e2e/i18n.e2e.mjs $U 2>&1 | rg -v "Failed to load resource" | tail -4; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL i18n"
# the Mac app tarball (made by `npx tauri build`) lets get.e2e also run install.sh for real
T=$(ls src-tauri/target/release/bundle/macos/Vicaria.app.tar.gz 2>/dev/null | head -1); [ -n "$T" ] && export VIC_APP_TARBALL=$PWD/$T
timeout 600 node e2e/get.e2e.mjs 2>&1 | tail -4; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL get"
timeout 900 node e2e/updates.e2e.mjs 2>&1 | tail -4; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL updates"
timeout 900 node bench/run.mjs --json /tmp/bench.json 2>&1 | tail -12; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL budgets"
# the core screens again in Playwright's WebKit with an iPad profile (install: npx playwright install webkit)
# (ask runs with the service worker blocked: Playwright's WebKit does not route requests of a page a service worker controls;
# firstrun is left out: Safari has a speech recognizer, so the Whisper row it checks is not offered there)
for t in legacy marks shelf i18n errors axe pdf ideas updates; do VIC_ENGINE=webkit timeout 900 node e2e/$t.e2e.mjs $U 2>&1 | rg -v "Failed to load resource|Cross-Origin" | tail -3; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL webkit-$t"; done
for t in ask wiser; do VIC_NOSW=1 VIC_ENGINE=webkit timeout 900 node e2e/$t.e2e.mjs $U 2>&1 | rg -v "Failed to load resource|Cross-Origin" | tail -3; [ ${PIPESTATUS[0]} = 0 ] || echo "SUITEFAIL webkit-$t"; done
echo ALLDONE

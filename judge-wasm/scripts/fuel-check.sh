#!/usr/bin/env bash
# Fuel regression guard. Runs the judge over every adversarial corpus file
# (vectors/fuel/*.json) under a fuel cap equal to the recommended max_instructions,
# using the same metering OutLayer uses (wasmtime fuel). Fails if any case runs out
# of fuel or does not print a verdict. Also prints the wall time of each run.
#
# Usage (from judge-wasm/):
#   scripts/fuel-check.sh [FUEL_CAP] [path/to/judge.wasm]
# Defaults: FUEL_CAP=3000000000 (the recommended max_instructions),
#           wasm=target/wasm32-wasip1/release/judge.wasm
#
# Build the wasm first (see BUILD.md). Requires wasmtime on PATH.
set -euo pipefail

CAP="${1:-3000000000}"
WASM="${2:-target/wasm32-wasip1/release/judge.wasm}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS="$DIR/vectors/fuel"
WASM_PATH="$DIR/$WASM"
[ -f "$WASM_PATH" ] || WASM_PATH="$WASM"

if ! command -v wasmtime >/dev/null 2>&1; then echo "wasmtime not on PATH"; exit 2; fi
if [ ! -f "$WASM_PATH" ]; then echo "wasm not found: $WASM_PATH (build it first, see BUILD.md)"; exit 2; fi
if [ ! -d "$CORPUS" ]; then echo "corpus not found: $CORPUS (run node scripts/make-fuel-corpus.mjs)"; exit 2; fi

echo "fuel cap: $CAP"
echo "wasm:     $WASM_PATH"
echo

ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT
fail=0
count=0
for f in "$CORPUS"/*.json; do
  count=$((count + 1))
  name="$(basename "$f")"
  start=$(date +%s%N)
  if out="$(wasmtime run -W "fuel=$CAP" "$WASM_PATH" < "$f" 2>"$ERR")"; then
    ms=$(( ($(date +%s%N) - start) / 1000000 ))
    if [[ "$out" == '{"v":1'* ]]; then
      echo "ok    ${ms}ms  $name"
    else
      echo "FAIL        $name : output is not a verdict: ${out:0:80}"
      fail=$((fail + 1))
    fi
  else
    echo "FAIL        $name : ran out of fuel or trapped under cap $CAP"
    sed 's/^/             /' "$ERR" | head -3
    fail=$((fail + 1))
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS: all $count corpus cases finish under $CAP instructions."
else
  echo "FAILED: $fail of $count cases did not finish under $CAP instructions."
  exit 1
fi

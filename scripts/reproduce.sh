#!/usr/bin/env bash
# Rebuild the published judge and escrow and compare their SHA-256 with the published hashes.
#
#   bash scripts/reproduce.sh
#
# Needs rustup (it installs the pinned rustc 1.99.1 with the wasm targets the rust-toolchain.toml files name) and,
# for the escrow, cargo-near 0.22.0. Both builds were made on macOS on Apple silicon; GitHub's macOS arm64 runner
# reproduces them on every push. On another host the bytes differ (README, "Status and tests").
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_DIR="${CARGO_HOME:-$HOME/.cargo}"
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
status=0

check() { # label, built file, published sha256
  local got
  got="$(shasum -a 256 "$2" | cut -d' ' -f1)"
  if [ "$got" = "$3" ]; then echo "MATCH    $1: $got"; else echo "DIFFERS  $1: built $got, published $3"; status=1; fi
}

build() { # label, directory, command...
  local label="$1" dir="$2"
  shift 2
  echo "building $label ..."
  if ! (cd "$dir" && "$@") >"$LOG" 2>&1; then
    tail -20 "$LOG"
    echo "the $label build failed"
    exit 1
  fi
}

JUDGE_FLAGS="$(printf -- '--remap-path-prefix=%s=/src\037--remap-path-prefix=%s=/cargo' "$ROOT/judge-wasm" "$CARGO_DIR")"
build "the judge" "$ROOT/judge-wasm" env CARGO_ENCODED_RUSTFLAGS="$JUDGE_FLAGS" cargo build --release --locked --target wasm32-wasip1
check "judge (judge-wasm/release/judge.wasm.sha256)" "$ROOT/judge-wasm/target/wasm32-wasip1/release/judge.wasm" "$(cut -d' ' -f1 "$ROOT/judge-wasm/release/judge.wasm.sha256")"

if command -v cargo-near >/dev/null 2>&1; then
  US=$'\x1f'
  build "the escrow" "$ROOT/contract" cargo near build non-reproducible-wasm \
    --env "CARGO_ENCODED_RUSTFLAGS=-Clink-arg=-s${US}--remap-path-prefix=${CARGO_DIR}=/cargo${US}--remap-path-prefix=$ROOT/contract=/src"
  WANT="$(grep -o 'SHA-256 hex: `[0-9a-f]\{64\}`' "$ROOT/contract/BUILD.md" | head -1 | grep -o '[0-9a-f]\{64\}')"
  check "escrow (contract/BUILD.md, the code deployed on judgenear-escrow.testnet)" "$ROOT/contract/target/near/judge_escrow.wasm" "$WANT"
else
  echo "skipped  escrow: install cargo-near 0.22.0 (cargo install cargo-near --version 0.22.0 --locked) to rebuild it"
fi
exit $status

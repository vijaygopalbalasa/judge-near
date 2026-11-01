# Build

Reproducible release build of the judge WASM for OutLayer (wasm32-wasip1).

## Command

The project directory contains a space ("Judge Protocol"), and cargo word-splits
`RUSTFLAGS` on spaces, so the flags go through `CARGO_ENCODED_RUSTFLAGS` (split only
on the 0x1f unit separator):

```sh
cd judge-wasm
CARGO_ENCODED_RUSTFLAGS="$(printf -- '--remap-path-prefix=%s=/src\037--remap-path-prefix=%s=/cargo' "$(pwd)" "$HOME/.cargo")" \
  cargo build --release --locked --target wasm32-wasip1
```

The two `--remap-path-prefix` flags rewrite this checkout's absolute path to `/src`
and the cargo home (where crates.io sources live) to `/cargo`, so the artifact
carries no machine-specific paths and its hash does not depend on the user name or
folder it was built in (check: `strings judge.wasm | grep -c /Users/` prints 0).
`--locked` builds against the committed Cargo.lock.

## Toolchain

```
rustc 1.99.1 (58cf8f9c3 2026-10-13)
binary: rustc
commit-hash: 58cf8f9c35b355199727627d07ae34a4e2846d67
commit-date: 2026-10-13
host: aarch64-apple-darwin
release: 1.99.1
LLVM version: 23.1.1

cargo 1.99.1 (5f94df478 2026-08-27)
wasmtime 50.0.0 (ebe5e8df1 2026-10-20)
```

Target installed: wasm32-wasip1 (`rustup target list --installed`).

## Artifact

- Path: `target/wasm32-wasip1/release/judge.wasm`
- Size: 161736 bytes
- SHA-256: `da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1`

This sha256 is the value the escrow contract pins as `WasmUrl.hash`. A different
rustc or std may shift the bytes, so pin the exact toolchain when publishing it.

## WASI imports

```
environ_get,environ_sizes_get fd_read,fd_write proc_exit
```

No `random_get`, no `clock_time_get`, no network, no `path_open`: the guest is
deterministic. `environ_*` are read during std's startup only; the judge never
reads an environment variable, so output does not depend on the environment.
`fd_read` (stdin), `fd_write` (stdout) and `proc_exit` are the stdin-to-stdout
contract. uniqueBy uses a BTreeSet, not a HashSet, so RandomState's `random_get`
is not linked.

## Release profile

opt-level "z", lto, codegen-units 1, strip, panic = "abort" (Cargo.toml).
opt-level "s" was measured as ~4% fewer instructions but ~6% larger; "z" kept
(fuel headroom is ample either way; see RESOURCE-LIMITS.md).

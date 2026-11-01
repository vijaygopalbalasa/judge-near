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
- Size: 182133 bytes
- SHA-256: `911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958`
- Includes sealed jobs (docs/interface.md section 6.3). Rebuilt from clean with the
  command above on Nov 2 2026: same hash. All 305 parity vectors and all 42 sealed
  vectors run through this artifact under wasmtime give the expected verdict text
  byte for byte (`node scripts/wasm-vectors.mjs`).

This sha256 is the value the escrow contract pins as `WasmUrl.hash`. A different
rustc or std may shift the bytes, so pin the exact toolchain when publishing it.

## WASI imports

```
environ_get,environ_sizes_get fd_read,fd_write proc_exit
```

No `random_get`, no `clock_time_get`, no network, no `path_open`: the guest is
deterministic. The judge reads exactly one environment variable, `JN_KEY` (main.rs,
passed into the library), and only a sealed stdin uses it; a public stdin gives the
same verdict whatever the environment holds. `fd_read` (stdin), `fd_write` (stdout)
and `proc_exit` are the stdin-to-stdout contract. uniqueBy uses a BTreeSet, not a
HashSet, so RandomState's `random_get` is not linked, and the sealed-mode crates
(chacha20poly1305, x25519-dalek, hkdf) are built with default features off, so
getrandom is not in the dependency tree at all.

Check the import section exactly (it parses the module, so any new name fails):

```sh
node scripts/imports.mjs target/wasm32-wasip1/release/judge.wasm
```

## Release profile

opt-level "z", lto, codegen-units 1, strip, panic = "abort" (Cargo.toml).
opt-level "s" was measured as ~4% fewer instructions but ~6% larger; "z" kept
(fuel headroom is ample either way; see RESOURCE-LIMITS.md).

## Published artifact

`release/judge.wasm` is the file OutLayer downloads (the escrow pins its URL at a fixed
commit and its SHA-256). It is a copy of the build output above; check it with:

```sh
cd judge-wasm/release && shasum -a 256 -c judge.wasm.sha256
```

A rebuild with the command above must print the same hash.

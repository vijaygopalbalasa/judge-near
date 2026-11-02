# Build

## Toolchain

- rustc 1.99.1 (58cf8f9c3 2026-10-13), stable, aarch64-apple-darwin
- cargo-near 0.22.0
- near-sdk 5.30.0 (MSRV rustc 1.95), edition 2024, resolver 3
- target `wasm32-unknown-unknown` (`rustup target add wasm32-unknown-unknown`)

The default `stable` channel was updated from 1.94.1 to 1.99.1 (`rustup update stable`) because
near-sdk 5.30 needs rustc 1.95 and near-workspaces 0.24 only resolves against the 5.30 era. The judge
build is pinned to the same toolchain.

## Path-safe release build (use this for the deployable wasm)

A plain `cargo near build` embeds absolute local paths (panic locations of dependencies under
`$HOME/.cargo/registry`), which leaks the builder's username into public bytecode and makes the hash
machine-dependent. The build below remaps them. cargo-near ignores `RUSTFLAGS` from the shell and only
takes flags through `--env`; `CARGO_ENCODED_RUSTFLAGS` (flags separated by the 0x1f byte) is used so a
source path containing spaces stays one flag. `-Clink-arg=-s` is cargo-near's default and is kept,
because `--env` replaces the default list; cargo-near appends `--cfg near` itself.

```bash
cd contract
US=$'\x1f'
cargo near build non-reproducible-wasm \
  --env "CARGO_ENCODED_RUSTFLAGS=-Clink-arg=-s${US}--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo${US}--remap-path-prefix=$PWD=/src"
```

The mock is built with the same command run inside `contract/mock-outlayer`.

Checks run on the result: `strings` finds no absolute home-directory or source-checkout path
(registry paths read `/cargo/registry/...`), and a forced recompile with the same flags gives a
byte-identical wasm.

## Artifacts (v3, deployed Nov 2 2026 at 21:55 UTC)

### Escrow: judge_escrow.wasm (deployable)
- Path: `contract/target/near/judge_escrow.wasm`
- Size: 196159 bytes
- SHA-256 hex: `f55de7417a4bd707390a40e86a37adb616b3eb5a9dacdd094acce86dc02bf019`
- SHA-256 base58 (NEAR code_hash form): `HWowCok2UCH5XZsTBPYuaph3jPVjJEjbs2jhK2h7c94t`
- ABI: `contract/target/near/judge_escrow_abi.json` (also embedded)
- NEP-330 source metadata embeds the `repository` link from Cargo.toml
  (`https://github.com/vijaygopalbalasa/judge-near`); changing that field changes the hash.
- v3 changes only the refund and ruling deadlines (no refund while a ruling runs, no ruling once the grace window
  ends); the stored state has the same layout, so v3 replaced v2 on the same account, code only.

### Escrow v2 (deployed Nov 2 2026, replaced by v3 the same day)
- Size: 195834 bytes (the public-only v1 committed as 9c432bf was 179461 bytes, sha256 a0130b87...)
- SHA-256: `b13cef3dd19730818f1db4ac85c135bfccf671eaca92315d853ed5f4f3b9f223`, base58
  `Cvs46Mpm96grgs3GdU4Cpyx3PTRiJZifHDXrWRm2qpga`; built from commit 1c6a29f and earlier.

### Mock OutLayer: mock_outlayer.wasm (tests only, never deployed)
- Path: `contract/mock-outlayer/target/near/mock_outlayer.wasm`
- Size: 134322 bytes (with the hold mode that parks a yield, Nov 2 2026)
- SHA-256 hex: `8591f9db1df0eb6d96273a8da681fd3884179d79c4c6b87754a2477dd0d80e46`
- SHA-256 base58: `9zQKtiBJWZsGCqXtLJPV24nAnEkL5KVaJ89Popw6MSX7`

## Dependencies

- Contract: near-sdk 5.30 and hex 0.4. Sealed mode adds no dependency: k is decoded with the base64
  crate near-sdk re-exports.
- Dev only (never in the wasm): near-workspaces 0.24 ("unstable"), tokio, anyhow, serde_json, and
  x25519-dalek 2, the oracle that proves the small-order blocklist bytes.
- The sealed unit and sandbox tests read the judge's real vectors at compile time
  (`include_str!("../../judge-wasm/vectors/sealed.json")`), so building the tests needs the
  `judge-wasm/` directory next to `contract/`, as in this repository.

## Other commands

```bash
cd contract

# Error-check (near-sdk 5.30 refuses a bare host `cargo check`)
cargo check --lib --target wasm32-unknown-unknown

# Unit tests (112)
cargo test --lib

# Sandbox integration tests (13, 2 to 4 minutes). near-workspaces downloads the sandbox binary on
# first run; each test process compiles the two wasms once and reuses them.
cargo test --test integration -- --test-threads=1
```

The integration tests build both wasms themselves with `compile_project` and default flags, writing
into the same `target/near/` paths. Those are test artifacts: re-run the path-safe build afterwards
before taking the deployable wasm or its hash.

## Release profile

From the cargo-near scaffold: `opt-level = "z"`, `lto = true`, `codegen-units = 1`,
`panic = "abort"`, `overflow-checks = true`, `debug = false`. overflow-checks guards the money math;
all amounts are NearToken / yoctoNEAR with saturating operations, so a wrap panics instead of
silently corrupting a balance.

## Deployment

This exact file is deployed on testnet as `judgenear-escrow.testnet`, deployed and initialised in one transaction
(`FfrcKXWFetEq4pUt7WvoztNFQ1jsQusb2bP1rpdWoYva`) by `node tools/deploy-escrow.mjs --account <account> --send`, which
checks this file's SHA-256 against the hex above and the judge URL's bytes against
`judge-wasm/release/judge.wasm.sha256` before signing. NEAR reports the account's code hash as the base58 value above.

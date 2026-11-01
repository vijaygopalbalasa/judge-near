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
  --env "CARGO_ENCODED_RUSTFLAGS=-Clink-arg=-s${US}--remap-path-prefix=$HOME/.cargo=/cargo${US}--remap-path-prefix=$PWD=/src"
```

The mock is built with the same command run inside `contract/mock-outlayer`.

Checks run on the result: `strings` finds no absolute home-directory or source-checkout path
(registry paths read `/cargo/registry/...`), and a forced recompile with the same flags gives a
byte-identical wasm.

## Artifacts (Nov 2 2026)

### Escrow: judge_escrow.wasm (deployable)
- Path: `contract/target/near/judge_escrow.wasm`
- Size: 179461 bytes
- SHA-256 hex: `a0130b87efe0c336ee33c80a39468efc639fe7ea21ad18b935b33260e51d3e4e`
- SHA-256 base58 (NEAR code_hash form): `Bms5MtRN3kd9yy7QZ1T3tX2LDvQJ1KzSUn8QryYmT2Bw`
- ABI: `contract/target/near/judge_escrow_abi.json` (also embedded)
- NEP-330 source metadata embeds the `repository` link from Cargo.toml
  (`https://github.com/vijaygopalbalasa/judge-near`); changing that field changes the hash.

### Mock OutLayer: mock_outlayer.wasm (tests only, never deployed)
- Path: `contract/mock-outlayer/target/near/mock_outlayer.wasm`
- Size: 124020 bytes
- SHA-256 hex: `415b75f2247116c8a4bb5e8614bd93e87fcdf2159510c52b7b3eeaec1ce26842`
- SHA-256 base58: `5Q8PYXxjqrFB8Zd37rNTSRZcxnYXwDS76M6bPKhpyHDT`

## Other commands

```bash
cd contract

# Error-check (near-sdk 5.30 refuses a bare host `cargo check`)
cargo check --lib --target wasm32-unknown-unknown

# Unit tests (71)
cargo test --lib

# Sandbox integration tests (7). near-workspaces downloads the sandbox binary on first run.
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

## Not done here (by instruction)

No deployment, no testnet or mainnet account used, no commits. Deployment happens later, separately.

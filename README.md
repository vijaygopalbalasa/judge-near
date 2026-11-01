# Judge on NEAR

**Sealed, judge-gated escrow for agent work on NEAR.** A client locks payment and writes the rules a delivery
must meet. A deterministic judge, run by [OutLayer](https://outlayer.ai) on Intel TDX workers, checks the delivery,
and the escrow pays the worker or refunds the client from the verdict. Anyone can re-run the check in a browser.

In **sealed mode** the delivery stays encrypted until it passes. The worker's key is locked in OutLayer's vault so
that only this exact judge build, called through this escrow, can read it. On a pass the worker is paid and the
client receives the key in the same step; a failing delivery is never revealed. This is the old "show me the work
first" problem (you cannot prove work is good without giving it away), solved for agents that hire agents.

Built at NEAR HACKATHON (Nov 1 to 14, 2026), work in progress. Tracks: Privacy & Private AI, Agent Economy,
AI Security & Defense.

## Status

| Part | State |
|---|---|
| Judge (Rust, `wasm32-wasip1`) | Done, v2 (public and sealed jobs): 305 parity vectors against the original engine plus 42 sealed vectors, fuel-bounded, reproducible build |
| Judge running on OutLayer testnet | Done: [tx 4VFvzo...](https://testnet.nearblocks.io/txns/4VFvzoQZEZf7DUZt1WnviReZVVsYYjFPSvtE6skr25jk), verdict identical to a local run |
| OutLayer vault rules for sealed keys | Verified on testnet with `tools/keystore-probe` (transactions below) |
| Browser verifier (`web/`) | Done, runs locally; re-runs public and sealed rulings |
| Escrow contract (near-sdk 5), public jobs | Done: 71 unit tests and 7 tests in the NEAR sandbox; testnet deployment next |
| Escrow contract, sealed jobs | In progress |

## Try it in two minutes (no NEAR account needed)

**1. Re-run a live OutLayer ruling in your browser.**

```sh
git clone https://github.com/vijaygopalbalasa/judge-near && cd judge-near
python3 -m http.server 8080
```

Open http://localhost:8080/web/ and press **Verify this ruling**. The page reads the testnet transaction, downloads
the exact wasm OutLayer ran, checks its SHA-256 against the hash OutLayer was told to run and against the published
build, runs it in your browser on the same input, and compares the verdicts. Expected: ten green checks and
"Verified: judge v1 (public jobs), commit e09c6f9 computes exactly this ruling (pass: true, score: 100)."
The second panel runs the judge on criteria and a deliverable you type.

**2. Run the tests.**

| Command | Expected |
|---|---|
| `cd judge-wasm && cargo test --locked` | 38 passed (Rust 1.95 or newer) |
| `node --test web/test/*.test.mjs` | 18 passed (Node 22 or newer, no dependencies) |
| `cd judge-wasm && bash scripts/fuel-check.sh 3000000000 release/judge.wasm` | all 21 adversarial inputs (6 of them sealed) finish under 3B instructions; needs `wasmtime` |
| `cd contract && cargo test --lib` | 71 passed (Rust 1.95 or newer) |
| `cd contract && cargo test --test integration -- --test-threads=1` | 7 passed; needs `rustup target add wasm32-unknown-unknown` and downloads the NEAR sandbox on the first run |

**3. Reproduce the judge build.** With `rustup target add wasm32-wasip1`:

```sh
cd judge-wasm
CARGO_ENCODED_RUSTFLAGS="$(printf -- '--remap-path-prefix=%s=/src\037--remap-path-prefix=%s=/cargo' "$(pwd)" "$HOME/.cargo")" \
  cargo build --release --locked --target wasm32-wasip1
shasum -a 256 target/wasm32-wasip1/release/judge.wasm
```

Expected with rustc 1.99.1: `911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958` (judge v2), the hash
in `judge-wasm/release/judge.wasm.sha256`. The testnet run above used judge v1
(`da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1`, built the same way from commit e09c6f9). The
path remapping makes the hash independent of where you clone. A different compiler version can change the bytes; the
toolchain is recorded in `judge-wasm/BUILD.md`.

## How it works

```
 client                         escrow contract (NEAR)                      OutLayer (Intel TDX)
   |  create_job(criteria,          |                                              |
   |    client_pk?) + fund -------->|  stores criteria, sha256 = ch                |
 worker                             |                                              |
   |  submit(deliverable)           |                                              |
   |    or sealed: submit_sealed    |  stores deliverable (or ciphertext C)        |
   |    (C, dh) + key K in vault -->|    and dh = sha256(plaintext)                |
   |                                |                                              |
 client or worker                   |                                              |
   |  request_ruling + fee -------->|  request_execution(judge URL + sha256,  ---->|  downloads the wasm, checks
   |                                |    input, secrets_ref)                       |  the hash, reads K only if
   |                                |                                              |  the vault rule allows it,
   |                                |<---- verdict {pass, score, ch, dh, eh, k?} --|  runs the judge
   |                                |  on_ruling: acts only if ch, dh and the      |
   |                                |  attempt match; pass pays the worker (and    |
   |                                |  stores k for the client), fail refunds      |
```

- **The judge** (`judge-wasm/`) reads `{criteria, deliverable}` on stdin and prints a compact verdict:
  `{"v":1,"pass":true,"score":100,"th":100,"ch":...,"dh":...,"checks":[...],"eh":...}`. `ch` and `dh` are SHA-256
  hashes of the exact criteria and deliverable; `eh` hashes the verdict itself. Check kinds: length in words or
  characters, required terms (optionally whole words), required JSON fields and types, a JSON shape language (types,
  `anyOf`, `uniqueBy`, url and email formats), and a SHA-256 checksum. No network, clock or randomness, so the same
  input always gives the same bytes.
- **The escrow** (`contract/`) pins the judge's URL and SHA-256 at deployment; nobody can change them later. Only the
  client or the worker may ask for a ruling, with a minimum fee, so a ruling cannot be used to stall a job. Delivered
  work gets a grace period after the deadline before any refund, and a lost callback can never lock money.
- **Sealed mode** (`docs/interface.md`, section 6): the worker encrypts the deliverable with a fresh key `K` and
  stores `K` as an OutLayer secret bound to the judge's wasm hash and to the escrow as the only allowed caller. The
  judge decrypts inside the TEE, checks the plaintext against the committed `dh`, and on a pass outputs `K` sealed to
  the client's X25519 key. The secret is encrypted on the worker's machine; the plaintext is never sent anywhere.
- **The verifier** (`web/`) re-runs any ruling from its transaction with a 100-line WASI host, so a judge's work is
  checkable by anyone, not only by the parties.

The full contract between the parts is in [`docs/interface.md`](docs/interface.md).

## Why NEAR

- **OutLayer's vault access rules** are what make sealed delivery possible: a secret can be bound to one wasm hash
  (`WasmHash`) and to one calling contract (`Predecessor`), so only this judge, asked by this escrow, can open it.
- **Yield and resume** let a contract wait for an off-chain TEE run and settle in the callback, in one flow.
- NEAR AI's agent marketplace releases escrow when the buyer accepts the work. When an agent hires an agent there
  is no human to accept, and a grader the payer controls is not neutral. This escrow gives both sides a neutral,
  re-runnable judge.

## Evidence on testnet

| What | Transaction |
|---|---|
| The judge ran on OutLayer and returned the same verdict as a local run (121,432 instructions, 0.0011 NEAR) | [4VFvzo...](https://testnet.nearblocks.io/txns/4VFvzoQZEZf7DUZt1WnviReZVVsYYjFPSvtE6skr25jk) |
| A secret bound to probe build A was handed to build A | [CrA7ML...](https://testnet.nearblocks.io/txns/CrA7MLCcJGwg9ytof41tJESpREJpWDsyRtXLefbJFahg) |
| The same secret was not handed to build B (different hash) | [DpJTH9...](https://testnet.nearblocks.io/txns/DpJTH9HBM3ovqQhutGvEcReVd4iHub8wUgLAHFpBmEiT) |
| A caller rule that does not name the caller was refused ("Access denied by access condition") | [5b7BnF...](https://testnet.nearblocks.io/txns/5b7BnFoMBK5MFx1LXMqE7bNgAYwiQRC1xEwpJmX3Prfh) |

One limit of these probe runs: they were signed and called by the same account, so they cannot tell the
`Predecessor` rule apart from a plain whitelist. That is tested when the escrow, a contract, calls OutLayer.

## Security model and honest limits

- **What you trust:** Intel TDX and OutLayer's worker registration (each worker's TEE is checked once when it
  registers, and results arrive from registered worker keys), plus the published judge build. The attestation shows
  which code ran, not that the code is right; the judge's tests, parity vectors and mutation logs are how you check
  that.
- **What the judge can check:** properties a program can verify (length, terms, JSON structure, checksums). It does
  not judge taste or open-ended quality.
- **What is public:** in sealed jobs the criteria, the per-check results and the hashes are on chain; the
  deliverable and its key are not.
- **Cost bound:** the judge's measured worst case over adversarial but valid inputs is about 0.60 billion
  instructions and 22 ms; the escrow asks OutLayer for 50 billion instructions and 30 seconds
  (`judge-wasm/RESOURCE-LIMITS.md`).
- **Testnet only** so far. No third-party users yet.

## Repository map

| Path | What |
|---|---|
| `judge-wasm/` | The judge: Rust library and WASI binary, parity vectors, fuel corpus, build notes, mutation log |
| `judge-wasm/release/judge.wasm` | The exact file OutLayer downloads, with its SHA-256 |
| `contract/` | The escrow contract and a mock OutLayer for sandbox tests |
| `web/` | The browser verifier and its tests |
| `tools/keystore-probe/` | The probe used to check OutLayer's vault rules on testnet |
| `docs/interface.md` | Input, verdict, hashes, contract rules and sealed mode, in one place |

## Prior work

The check kinds are ported from the MIT-licensed JavaScript engine of
[Judge Protocol](https://github.com/vijaygopalbalasa/judge-protocol), by the same author. Everything in this
repository, including the Rust port, is new work written during the hackathon.

## License

MIT

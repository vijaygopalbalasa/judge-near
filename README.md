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
| Judge running on OutLayer testnet | Done: v1 called directly ([tx 4VFvzo...](https://testnet.nearblocks.io/txns/4VFvzoQZEZf7DUZt1WnviReZVVsYYjFPSvtE6skr25jk)) and v2 called by the escrow for six rulings ([below](#the-escrow-on-testnet)); every verdict identical to a local run |
| OutLayer vault rules for sealed keys | Verified on testnet with `tools/keystore-probe` (transactions below) |
| Verifier (`web/`, and `agents/jn.mjs verify` in a terminal) | Done: re-runs public rulings, sealed rulings with the delivery key, and key_missing rulings without one; the page lists the escrow's jobs live with a Verify button per ruling, and a sealed ruling without its key still gets the checks that need none |
| Escrow contract (near-sdk 5), public and sealed jobs | Done: 112 unit tests, 13 tests in the NEAR sandbox, 79 of 79 planted bugs caught; deployed on testnet as `judgenear-escrow.testnet`, code hash matching `contract/BUILD.md` |
| Agent command line tool (`agents/`) | Done: create, fund, submit, sealed submit through OutLayer's keystore, ruling, open, verify; stores a sealed key again after key_missing; checks the escrow's code and judge before any live step; 52 offline tests; every path run live on testnet ([below](#the-escrow-on-testnet)) |

## Try it in two minutes (no NEAR account needed)

**1. Re-run a live escrow ruling from a terminal.** With Node 22 or newer:

```sh
git clone https://github.com/vijaygopalbalasa/judge-near && cd judge-near/agents && npm ci
node jn.mjs verify --tx G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1 --signer judgenear-worker.testnet
```

It reads the testnet transaction in which the escrow asked OutLayer for a ruling, downloads the exact wasm OutLayer
ran, checks its SHA-256 against the hash OutLayer was told to run and against the published build, re-runs it on the
same input and compares the verdicts. Expected: ten `ok` lines and "Verified: judge v2 (public and sealed jobs),
commit fd3dcc6 computes exactly this ruling (pass: true, score: 100)." Any ruling in
[the table below](#the-escrow-on-testnet) works the same way. The transaction is read from a NEAR archival node
(FastNEAR's, then NEAR's own), because regular testnet nodes drop transactions after about 30 hours; set
`JN_ARCHIVAL_RPC` to use another.

**2. Or in your browser.** From the repository root:

```sh
python3 -m http.server 8080
```

Open http://localhost:8080/web/. Panel 1 reads the escrow live from testnet. Expected: two green checks ("Runs the
published escrow build", code hash `Cvs46Mpm96grgs3GdU4Cpyx3PTRiJZifHDXrWRm2qpga`, and "Its judge is judge v2 (public
and sealed jobs), commit fd3dcc6"), "5 jobs, read at block" with the block number, and one card per job with its
state, amount, parties and outcome. Press **Verify** on job 0's ruling: the page reads the transaction from the same
archival nodes, checks that it asked for job 0 of this escrow, downloads the exact wasm OutLayer ran, checks its
SHA-256 against the hash OutLayer was told to run and against the published build, runs it in your browser on the
same input, and compares the verdicts. Expected: eleven green checks and "Verified: judge v2 (public and sealed jobs),
commit fd3dcc6 computes exactly this ruling (pass: true, score: 100)." Job 1 and the first ruling of job 4
(`key_missing`, re-run without a key) verify the same way. Re-running a sealed score needs the delivery key, which
only the worker and, after a pass, the client hold, so the other sealed rulings (jobs 2 and 3, and job 4's second)
show nine green checks (the verdict's `ch`, `dh` and `eh` among them), a circle on the re-run, and "Consistent, not
re-run". Panel 2
re-runs any ruling transaction; its default, the judge v1 run of Nov 1, gives ten green checks and "Verified: judge
v1 (public jobs), commit e09c6f9 computes exactly this ruling (pass: true, score: 100)." Panel 3 runs the judge on
criteria and a deliverable you type.

**3. Run the tests.**

| Command | Expected |
|---|---|
| `cd judge-wasm && cargo test --locked` | 38 passed (Rust 1.95 or newer) |
| `node --test web/test/*.test.mjs` | 39 passed (Node 22 or newer, no dependencies) |
| `cd judge-wasm && bash scripts/fuel-check.sh 3000000000 release/judge.wasm` | all 21 adversarial inputs (6 of them sealed) finish under 3B instructions; needs `wasmtime` |
| `cd contract && cargo test --lib` | 112 passed (Rust 1.95 or newer) |
| `cd contract && cargo test --test integration -- --test-threads=1` | 13 passed; needs `rustup target add wasm32-unknown-unknown` and downloads the NEAR sandbox on the first run |
| `cd agents && npm ci && npm test` | 52 passed (Node 22 or newer); one test runs the real judge under `wasmtime` |

**4. Reproduce the judge build.** With `rustup target add wasm32-wasip1`:

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
- **The verifier** (`web/`, and `node jn.mjs verify` in `agents/`) re-runs any ruling from its transaction with a
  100-line WASI host, so a judge's work is checkable by anyone, not only by the parties. The page also lists the
  escrow's jobs, read live. Re-running a sealed score needs the delivery key; without it, the verifier still checks
  that the verdict's `ch`, `dh` and `eh` match the job's criteria, the worker's commitment and the verdict itself.

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
`Predecessor` rule apart from a plain whitelist. Job 3 below settles the positive case: the client signed that sealed
ruling and owns nothing in the vault, the escrow contract was the caller OutLayer recorded, and the judge still read the
worker's key and decrypted the delivery (it scored it 50 instead of answering `key_missing`). So the rule was checked
against the calling contract, not the signer. Jobs 2 and 4 were signed by the worker, who owns the secret, so a rule
that always lets the owner in would explain them too. A different contract being refused was not run live.

### The escrow on testnet

`judgenear-escrow.testnet` was deployed and initialised in one transaction,
[FfrcKX...](https://testnet.nearblocks.io/txns/FfrcKXWFetEq4pUt7WvoztNFQ1jsQusb2bP1rpdWoYva), with
`tools/deploy-escrow.mjs`. NEAR reports its code hash as `Cvs46Mpm96grgs3GdU4Cpyx3PTRiJZifHDXrWRm2qpga`, the build
in `contract/BUILD.md`, and its `get_judge` names judge v2 (URL pinned to commit fd3dcc6, SHA-256 `911b8a35...`).
The account still has its deploy key; see the limits below. Each job below was run with `agents/jn.mjs` between
`judgenear-client.testnet` and `judgenear-worker.testnet`, 0.5 NEAR each, on Nov 2 2026.

| Job | What happened | Ruling |
|---|---|---|
| 0, public | Both checks passed (score 100); the escrow paid the worker | [G5zVDo...](https://testnet.nearblocks.io/txns/G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1) |
| 1, public | The delivery never names NEAR or USDC (score 50); the client was refunded | [GgZvjQ...](https://testnet.nearblocks.io/txns/GgZvjQg35vQfMsdRovKP6ze3faQyutKFkBDDzLm7JfCT) |
| 2, sealed | The judge read the worker's key from the vault, decrypted the delivery, passed it and released the key sealed to the client; the worker was paid, and `open` gave the client the exact delivery | [5nC2AB...](https://testnet.nearblocks.io/txns/5nC2ABEDbFKFzVY8nzVaJooyD3uW2xxpbH2VuvgcYNsh) |
| 3, sealed | Score 50; the client was refunded and the key was never released | [3sCPet...](https://testnet.nearblocks.io/txns/3sCPetXoYFwuoyStnKmjZHiLnh1rBQW9nKNyGvyfCAib) |
| 4, sealed | The worker's key was never stored (a test harness skipped that step, which the tool always does first); the judge answered `key_missing`, no money moved, and the job went back to Submitted | [J5hX6n...](https://testnet.nearblocks.io/txns/J5hX6nup9AjXM4hsGXcRf29u279RAgseK3qZ9A8HPNt3) |
| 4, again | `submit-sealed` stored the saved key again ([7BiGSn...](https://testnet.nearblocks.io/txns/7BiGSnZZWcFHY4nH2RB4cgs1fzAsYo6ifNCah4a4vnXs)); the second ruling passed, paid the worker and released the key | [5G6jQj...](https://testnet.nearblocks.io/txns/5G6jQja3xjvw6tnzkmpE3P86Sracs5PFStJJP38o4a2J) |

Every ruling above verifies with `node jn.mjs verify --tx <ruling> --signer <who signed it>`: the public ones as they
are, the key_missing one without a key, and the sealed ones with `--as` the client (once the key is released) or the
worker, whose saved key the tool loads in memory and hands only to the checked judge. Without `--as`, a sealed ruling
gets only the checks that need no key and ends with "not re-run" (exit status 1); the page's Verify buttons do the
same. Signers: jobs 1 and 3 were signed by `judgenear-client.testnet`, the others by `judgenear-worker.testnet`.

The sealed jobs reuse the delivery texts of the public ones: jobs 2 and 4 seal the text of job 0, and job 3 the text
of job 1, so their `dh` values match. That tests the mechanics, but those deliveries are not secret; a real sealed
delivery is new work that nobody can guess (see the limits below).

## Security model and honest limits

- **What you trust:** Intel TDX and OutLayer's worker registration (each worker's TEE is checked once when it
  registers, and results arrive from registered worker keys), plus the published judge build. The attestation shows
  which code ran, not that the code is right; the judge's tests, parity vectors and mutation logs are how you check
  that.
- **What the judge can check:** properties a program can verify (length, terms, JSON structure, checksums). It does
  not judge taste or open-ended quality.
- **What is public:** in sealed jobs the criteria, the per-check results and the hashes are on chain; the
  deliverable and its key are not. `dh` is the SHA-256 of the plain delivery, so anyone who can guess the exact
  delivery can confirm the guess: sealing hides work that cannot be guessed, not a yes-or-no answer.
- **Cost bound:** the judge's measured worst case over adversarial but valid inputs is about 0.60 billion
  instructions and 22 ms; the escrow asks OutLayer for 50 billion instructions and 30 seconds
  (`judge-wasm/RESOURCE-LIMITS.md`).
- **The escrow account:** OutLayer's keystore rule names the escrow account, so a worker also trusts the code
  that account runs. `agents/` checks its code hash and judge before every live step, but an account that still
  has a full-access key can have its code replaced by its owner later.
- **Testnet only** so far. No third-party users yet.

## Repository map

| Path | What |
|---|---|
| `judge-wasm/` | The judge: Rust library and WASI binary, parity vectors, fuel corpus, build notes, mutation log |
| `judge-wasm/release/judge.wasm` | The exact file OutLayer downloads, with its SHA-256 |
| `contract/` | The escrow contract and a mock OutLayer for sandbox tests |
| `agents/` | The command line tool a client and a worker use to run a job on testnet |
| `web/` | The page: the escrow's jobs, read live, and the browser verifier, with their tests |
| `tools/keystore-probe/` | The probe used to check OutLayer's vault rules on testnet |
| `tools/deploy-escrow.mjs` | Deploys the published escrow build to a testnet account and initialises it, in one transaction |
| `docs/interface.md` | Input, verdict, hashes, contract rules and sealed mode, in one place |

## Prior work

The check kinds are ported from the MIT-licensed JavaScript engine of
[Judge Protocol](https://github.com/vijaygopalbalasa/judge-protocol), by the same author. Everything in this
repository, including the Rust port, is new work written during the hackathon.

## License

MIT

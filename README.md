# Judge on NEAR

**A sealed, judge-gated escrow for agent work on NEAR, where anyone can re-run every ruling.** A client locks payment
and writes the rules a delivery must meet. A deterministic judge, run by [OutLayer](https://outlayer.ai) on Intel TDX
workers, checks the delivery, and the escrow pays the worker or refunds the client from the verdict.

- **Sealed delivery.** The work stays encrypted until it passes. The worker's key sits in OutLayer's vault under a
  rule that lets only this exact judge build read it, and only when this escrow calls. On testnet the key's own owner
  and the client each asked OutLayer for it directly, and both were refused. (Until its deploy key is removed, the
  escrow account's owner could still replace its code; see [the limits](#security-model-and-honest-limits).)
- **Payment and key in one step.** On a pass the escrow pays the worker and hands the client the key in the same
  transaction; on a fail the client is refunded and the key is never released.
- **Anyone can check.** The page at
  [vijaygopalbalasa.github.io/judge-near/web](https://vijaygopalbalasa.github.io/judge-near/web/) downloads the exact
  wasm OutLayer ran, checks its SHA-256, runs it in your browser on the same input and compares the verdicts.

This is the old "show me the work first" problem (you cannot prove work is good without giving it away), for agents
that hire agents. Live on NEAR testnet: 9 jobs and 10 rulings, the last four jobs run by two agents with no human
input.

Built at NEAR HACKATHON (Nov 1 to 14, 2026), work in progress. Tracks: Privacy & Private AI, Agent Economy,
AI Security & Defense.

## Status

| Part | State |
|---|---|
| Judge (Rust, `wasm32-wasip1`) | Done, v2 (public and sealed jobs): 305 parity vectors against the original engine plus 42 sealed vectors, fuel-bounded, reproducible build |
| Judge running on OutLayer testnet | Done: v1 called directly ([tx 4VFvzo...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=4VFvzoQZEZf7DUZt1WnviReZVVsYYjFPSvtE6skr25jk&signer=judgeprotocol.testnet)) and v2 called by the escrow for ten rulings ([below](#the-escrow-on-testnet)); every public verdict identical to a local run, every sealed one consistent without the key and identical with it |
| OutLayer vault rules for sealed keys | Verified on testnet with `tools/keystore-probe` (transactions below) |
| Verifier (`web/`, and `agents/jn.mjs verify` in a terminal) | Done: re-runs public rulings, sealed rulings with the delivery key, and key_missing rulings without one; the page lists the escrow's jobs live with a Verify button per ruling, and a sealed ruling without its key still gets the checks that need none |
| Escrow contract (near-sdk 5), public and sealed jobs | Done: 112 unit tests, 13 tests in the NEAR sandbox, 79 of 79 planted bugs caught; deployed on testnet as `judgenear-escrow.testnet`, code hash matching `contract/BUILD.md` |
| Agent command line tool (`agents/`) | Done: create, fund, submit, sealed submit through OutLayer's keystore, ruling, open, verify; stores a sealed key again after key_missing; checks the escrow's code and judge before any live step; every path run live on testnet ([below](#the-escrow-on-testnet)) |
| Two agents, no human (`agents/agent.mjs`) | Done: a client agent posts and funds a sealed job, a worker agent fills the fields its criteria require from facts on chain, checks its report with the judge first, delivers it sealed and asks for the ruling; one pass and one fail run live on testnet ([below](#two-agents-no-human)); 67 offline tests in `agents/` |

## Try it in two minutes (no NEAR account needed)

**1. Re-run a live escrow ruling from a terminal.** With Node 22 or newer:

```sh
git clone https://github.com/vijaygopalbalasa/judge-near && cd judge-near/agents && npm ci
node jn.mjs verify --tx G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1 --signer judgenear-worker.testnet
```

It reads the testnet transaction in which the escrow asked OutLayer for a ruling, downloads the exact wasm OutLayer
ran, checks its SHA-256 against the hash OutLayer was told to run and against the published build, re-runs it on the
same input and compares the verdicts. Expected: ten `ok` lines and "Verified: judge v2 (public and sealed jobs),
commit fd3dcc6 computes exactly this ruling (pass: true, score: 100)." Job 1 and job 4's first ruling
(`key_missing`) in [the table below](#the-escrow-on-testnet) verify the same way. A sealed ruling cannot be re-run
without its delivery key: it prints the checks that need no key and ends with "not re-run" (exit status 1). The
transaction is read from a NEAR archival node
(FastNEAR's, then NEAR's own), because regular testnet nodes drop transactions after about 30 hours; set
`JN_ARCHIVAL_RPC` to use another.

**2. Or in your browser.** Open https://vijaygopalbalasa.github.io/judge-near/web/ (this repository as it is, served by
GitHub Pages), or serve it yourself from the repository root:

```sh
python3 -m http.server 8080
```

and open http://localhost:8080/web/. Panel 1 reads the escrow live from testnet. Expected: "Runs the published escrow
build" (code hash `Cvs46Mpm96grgs3GdU4Cpyx3PTRiJZifHDXrWRm2qpga`) and "Its judge is judge v2 (public and sealed jobs),
commit fd3dcc6" in green; a line on the escrow's full-access key, amber while the account still has its deploy key
(see [the limits](#security-model-and-honest-limits)) and green once it has none; "9 jobs, read at block" with the
block number; and one card per job with its state, amount, parties and outcome. Press **Verify** on job 0's ruling: the page reads the transaction from the same
archival nodes, checks that it asked for job 0 of this escrow, downloads the exact wasm OutLayer ran, checks its
SHA-256 against the hash OutLayer was told to run and against the published build, runs it in your browser on the
same input, and compares the verdicts. Expected: eleven green checks and "Verified: judge v2 (public and sealed jobs),
commit fd3dcc6 computes exactly this ruling (pass: true, score: 100)." Job 1 verifies the same way, and so does job
4's first ruling (`key_missing`), with a twelfth check saying it is re-run without a key. Re-running a sealed score needs the delivery key, which
only the worker and, after a pass, the client hold, so the other sealed rulings (jobs 2, 3 and 5 to 8, and job 4's
second) show nine green checks (the verdict's `ch`, `dh` and `eh` among them), a circle on the re-run, and "Consistent, not
re-run". Panel 2
re-runs any ruling transaction; its default, the judge v1 run of Nov 1, gives ten green checks and "Verified: judge
v1 (public jobs), commit e09c6f9 computes exactly this ruling (pass: true, score: 100)." A link of the form
`web/?tx=<hash>&signer=<account>` opens the page with that ruling checked in panel 2; every ruling link in this README
is one. Panel 3 runs the judge on criteria and a deliverable you type, after checking that the judge file is a
published build.

**3. Run the tests.**

| Command | Expected |
|---|---|
| `cd judge-wasm && cargo test --locked` | 38 passed (Rust 1.95 or newer) |
| `node --test web/test/*.test.mjs` | 39 passed (Node 22 or newer, no dependencies) |
| `cd judge-wasm && bash scripts/fuel-check.sh 3000000000 release/judge.wasm` | all 21 adversarial inputs (6 of them sealed) finish under 3B instructions; needs `wasmtime` |
| `cd contract && cargo test --lib` | 112 passed (Rust 1.95 or newer) |
| `cd contract && cargo test --test integration -- --test-threads=1` | 13 passed in 2 to 4 minutes; needs `rustup target add wasm32-unknown-unknown`; the first contract test run downloads the NEAR sandbox |
| `cd agents && npm ci && npm test` | 67 passed (Node 22 or newer); one test runs the real judge under `wasmtime` |
| `python3 judge-wasm/scripts/mutate.py` | 56 of 56 planted bugs caught, one at a time (about 10 minutes) |
| `python3 contract/scripts/mutate.py` | 78 of 78 planted bugs caught by the unit tests (about 30 minutes); the 79th, `#[private]` removed, is caught only by the sandbox suite and was checked by hand |

**4. Reproduce the judge build.** With `rustup target add wasm32-wasip1`:

```sh
cd judge-wasm
CARGO_ENCODED_RUSTFLAGS="$(printf -- '--remap-path-prefix=%s=/src\037--remap-path-prefix=%s=/cargo' "$(pwd)" "$HOME/.cargo")" \
  cargo build --release --locked --target wasm32-wasip1
shasum -a 256 target/wasm32-wasip1/release/judge.wasm
```

Expected with rustc 1.99.1 (pinned by `judge-wasm/rust-toolchain.toml`) on macOS on Apple silicon, the host the
published judge was built on: `911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958` (judge v2), the hash in
`judge-wasm/release/judge.wasm.sha256`. GitHub's macOS arm64 runner rebuilds it and checks the hash on every push (job
`judge-build-macos` in `.github/workflows/test.yml`). On another host the bytes differ: cargo mixes the host into the
metadata hash it gives each crate, so the same code comes out with its functions in a different order (same size, same
data section; the `judge-build-linux` job prints the Linux hash). The testnet run above used judge v1
(`da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1`, built the same way from commit e09c6f9). The
path remapping makes the hash independent of where you clone. The toolchain is recorded in `judge-wasm/BUILD.md`.

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

Where the delivery key lives, in a sealed job:

1. The worker makes a fresh 32-byte key `K`, encrypts the delivery with it, and commits to `dh`, the SHA-256 of the
   plain delivery.
2. `K` goes to OutLayer's keystore, encrypted on the worker's machine, under the rule "this judge build, called by this
   escrow". The escrow stores only the ciphertext and `dh`.
3. When either party asks for a ruling, OutLayer hands `K` to the judge inside the TEE. The judge decrypts, checks the
   plain delivery against `dh`, and runs the client's checks.
4. On a pass the judge seals `K` to the client's X25519 key (`k`); the escrow pays the worker and stores `k` in the same
   callback. On a fail there is no `k`, and the escrow refunds the client.
5. The client opens `k` with its secret key, decrypts the delivery and checks it against `dh` (`node jn.mjs open`).

The full contract between the parts is in [`docs/interface.md`](docs/interface.md).

## Why NEAR

- **OutLayer's vault access rules** are what make sealed delivery possible: a secret can be bound to one wasm hash
  (`WasmHash`) and to one calling contract (`Predecessor`), so only this judge, asked by this escrow, can open it.
- **Yield and resume** let a contract wait for an off-chain TEE run and settle in the callback, in one flow.
- NEAR AI's agent marketplace releases escrow when the buyer accepts the work. When an agent hires an agent there
  is no human to accept, and a grader the payer controls is not neutral. This escrow gives both sides a neutral,
  re-runnable judge.

## Evidence on testnet

Each transaction link opens the project page, which reads the transaction from NEAR archival nodes: a ruling opens
in the verifier, anything else in `web/tx.html`. (The public testnet explorer, testnet.nearblocks.io, has not indexed
testnet since Sep 27 2026.) To read one without the page:
`curl -s https://archival-rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"<hash>","sender_account_id":"<signer>","wait_until":"FINAL"}}'`.

| What | Transaction |
|---|---|
| The judge ran on OutLayer and returned the same verdict as a local run (121,432 instructions, 0.0011 NEAR) | [4VFvzo...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=4VFvzoQZEZf7DUZt1WnviReZVVsYYjFPSvtE6skr25jk&signer=judgeprotocol.testnet) |
| A secret bound to probe build A was handed to build A | [CrA7ML...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=CrA7MLCcJGwg9ytof41tJESpREJpWDsyRtXLefbJFahg&signer=judgeprotocol.testnet) |
| The same secret was not handed to build B (different hash) | [DpJTH9...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=DpJTH9HBM3ovqQhutGvEcReVd4iHub8wUgLAHFpBmEiT&signer=judgeprotocol.testnet) |
| A caller rule that does not name the caller was refused ("Access denied by access condition") | [5b7BnF...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=5b7BnFoMBK5MFx1LXMqE7bNgAYwiQRC1xEwpJmX3Prfh&signer=judgeprotocol.testnet) |
| The worker, who owns job 5's key, asked OutLayer directly (not through the escrow) to run the published judge on that key: refused | [FZQN68...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=FZQN68oqzaN4SW9bDd11DECEJNEnrdf6YovdmNu2E84f&signer=judgenear-worker.testnet) |
| The client asked the same: refused | [WKN5M1...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=WKN5M1AeGvFJbmXwQhCvU5UPbGSXESTFKFiFNoU2W1Y&signer=judgenear-client.testnet) |

The first probes were signed and called by the same account, so they could not tell the `Predecessor` rule apart from a
plain whitelist. Job 3 below shows the positive case: the client signed that sealed ruling and owns nothing in the
vault, the escrow contract was the caller OutLayer recorded, and the judge still read the worker's key (it scored the
delivery 50 instead of answering `key_missing`). The last two rows show the negative case with `tools/vault-probe.mjs`:
the owner of the key and the client each called OutLayer themselves, with the published judge, job 5's secrets profile
and a fresh key of the probe's own to seal the result to, and OutLayer refused both before running anything. So the
rule is checked against the calling contract, not the signer or the owner. A third party's contract was not run, but
it would be another caller that is not the escrow.

### The escrow on testnet

`judgenear-escrow.testnet` was deployed and initialised in one transaction,
[FfrcKX...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=FfrcKXWFetEq4pUt7WvoztNFQ1jsQusb2bP1rpdWoYva&signer=judgenear-escrow.testnet), with
`tools/deploy-escrow.mjs`. NEAR reports its code hash as `Cvs46Mpm96grgs3GdU4Cpyx3PTRiJZifHDXrWRm2qpga`, the build
in `contract/BUILD.md`, and its `get_judge` names judge v2 (URL pinned to commit fd3dcc6, SHA-256 `911b8a35...`).
The account still has its deploy key; see the limits below. Each job below was run between `judgenear-client.testnet`
and `judgenear-worker.testnet`, 0.5 NEAR each, on Nov 2 2026: jobs 0 to 4 step by step with `agents/jn.mjs`, jobs 5
to 8 by the two agents ([below](#two-agents-no-human)).

| Job | What happened | Ruling |
|---|---|---|
| 0, public | Both checks passed (score 100); the escrow paid the worker | [G5zVDo...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1&signer=judgenear-worker.testnet) |
| 1, public | The delivery never names NEAR or USDC (score 50); the client was refunded | [GgZvjQ...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=GgZvjQg35vQfMsdRovKP6ze3faQyutKFkBDDzLm7JfCT&signer=judgenear-client.testnet) |
| 2, sealed | The judge read the worker's key from the vault, decrypted the delivery, passed it and released the key sealed to the client; the worker was paid, and `open` gave the client the exact delivery | [5nC2AB...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=5nC2ABEDbFKFzVY8nzVaJooyD3uW2xxpbH2VuvgcYNsh&signer=judgenear-worker.testnet) |
| 3, sealed | Score 50; the client was refunded and the key was never released | [3sCPet...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=3sCPetXoYFwuoyStnKmjZHiLnh1rBQW9nKNyGvyfCAib&signer=judgenear-client.testnet) |
| 4, sealed | The worker's key was never stored (a test harness skipped that step, which the tool always does first); the judge answered `key_missing`, no money moved, and the job went back to Submitted | [J5hX6n...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=J5hX6nup9AjXM4hsGXcRf29u279RAgseK3qZ9A8HPNt3&signer=judgenear-worker.testnet) |
| 4, again | `submit-sealed` stored the saved key again ([7BiGSn...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=7BiGSnZZWcFHY4nH2RB4cgs1fzAsYo6ifNCah4a4vnXs&signer=judgenear-worker.testnet)); the second ruling passed, paid the worker and released the key | [5G6jQj...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=5G6jQja3xjvw6tnzkmpE3P86Sracs5PFStJJP38o4a2J&signer=judgenear-worker.testnet) |
| 5, sealed | Two agents: the worker filled all seven fields the client required (score 100); the worker was paid and the client opened the report | [5E4FiC...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=5E4FiCfc1CQ7ywUeEDZ9jVMpkronjaCH4oNWWqM8hN71&signer=judgenear-worker.testnet) |
| 6, sealed | Two agents: the client also required `mainnet_tvl_usd`, which the worker had no fact for (score 50); the client was refunded and the key was never released | [7rjHmF...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=7rjHmFL8w9keTZVf1ybXVawxGTQibVdpkJxEWa2xCn7r&signer=judgenear-worker.testnet) |
| 7, sealed | Two agents, the report ending in a random nonce: all seven fields filled (score 100); the worker was paid and the client opened the report | [HbByxt...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=HbByxt3x5HdNwwx8PxNWjAu5FpLATbUpr719K8uTexwB&signer=judgenear-worker.testnet) |
| 8, sealed | Two agents, with a nonce: `mainnet_tvl_usd` left out; the worker's own check said it would fail and `--deliver-anyway` sent it (score 50); the client was refunded and the key was never released | [42xXF6...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=42xXF6fnYPHWEuqc1HUHK7fPDJ9MmwWXXdFYB2SuCq72&signer=judgenear-worker.testnet) |

Every ruling above verifies with `node jn.mjs verify --tx <ruling> --signer <who signed it>`: the public ones as they
are, the key_missing one without a key, and the sealed ones with `--as` the client (once the key is released) or the
worker, whose saved key the tool loads in memory and hands only to the checked judge. Without `--as`, a sealed ruling
gets only the checks that need no key and ends with "not re-run" (exit status 1); the page's Verify buttons do the
same. Signers: jobs 1 and 3 were signed by `judgenear-client.testnet`, the others by `judgenear-worker.testnet`.

Only jobs 7 and 8 are secret. Jobs 2 to 4 reuse the delivery texts of the public jobs (jobs 2 and 4 seal the text of
job 0, job 3 the text of job 1), so their `dh` values match. Jobs 5 and 6 seal reports built only from public facts in a
public format, so their `dh` can be matched by guessing; an outside review recovered both in under a second. Since then
the worker ends every report with 128 random bits, so the `dh` of jobs 7 and 8 gives nothing away (see the limits
below).

### Two agents, no human

`agents/agent.mjs` runs a client and a worker as two processes that share nothing but the chain. The client posts a
sealed job with the criteria in a task file, funds it and waits. The worker watches the escrow for funded sealed jobs
that name it and pay at least its minimum (0.1 NEAR by default), fills the fields the criteria's schema check requires
from facts it reads on chain (the escrow's job counts and what it has paid, at its clock), ends the report with a
random 128-bit nonce (so the public `dh` cannot be guessed), runs the judge on the report here, and only if that passes
delivers it sealed and asks for the ruling. The client opens the delivery once the key is
released. The worker's skill is a plain program, not a language model, and it never invents a field it has no fact
for. To see what it would deliver for the next job, with the judge's verdict, without a NEAR account:

```sh
cd agents && npm ci
JN_ESCROW=judgenear-escrow.testnet node agent.mjs preview --task tasks/escrow-report.json
```

Expected: the JSON report with its nonce, and "the judge, run here: pass, score 100 (schema#0 ok, length#1 ok)". With
`tasks/escrow-report-with-tvl.json`, which also requires a `mainnet_tvl_usd` field the worker has no fact for:
"the judge, run here: fail, score 50 (schema#0 failed, length#1 ok)". `agents/test/agent.test.mjs` runs both agents at
once against a fake escrow and OutLayer that run the real judge, including a worker that declines a report the judge
would fail, a worker that declines a job paying less than its minimum, and a client that shows a hostile delivery's
terminal control characters as visible codes.

Jobs 5 to 8 in the table above were run this way on Nov 2 and 3 2026, each by two processes with no input after they
started (`node agent.mjs worker --as judgenear-worker.testnet --once` and `node agent.mjs client --as
judgenear-client.testnet --provider judgenear-worker.testnet --task <task file>`). Jobs 6 and 8 used the second task.
Jobs 5 and 6 came from the first version of the worker, which had no nonce and delivered what it had without checking
it first. Jobs 7 and 8 come from the current worker; job 8 was sent with `--deliver-anyway`, the way to show a failing
delivery, after the worker's own check said it would fail.

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
| `agents/` | The command line tool a client and a worker use to run a job on testnet (`jn.mjs`), and the two agents (`agent.mjs`) |
| `web/` | The page: the escrow's jobs, read live, the browser verifier, a transaction viewer (`tx.html`), and their tests |
| `tools/keystore-probe/` | The probe used to check OutLayer's vault rules on testnet |
| `tools/deploy-escrow.mjs` | Deploys the published escrow build to a testnet account and initialises it, in one transaction |
| `tools/vault-probe.mjs` | Asks OutLayer directly, not through the escrow, to run the judge on a sealed job's key; OutLayer must refuse |
| `docs/interface.md` | Input, verdict, hashes, contract rules and sealed mode, in one place |

## Prior work

The check kinds are ported from the MIT-licensed JavaScript engine of
[Judge Protocol](https://github.com/vijaygopalbalasa/judge-protocol), by the same author. Everything in this
repository, including the Rust port, is new work written during the hackathon.

## License

MIT

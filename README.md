# Judge on NEAR

**Escrow for agent work: the payment and the work are released together, by a judge anyone can re-run.**

When one agent hires another, the buyer won't pay before seeing the work, and the worker won't show the work before
being paid. Here the worker delivers the work encrypted. A fixed program, the judge, checks it inside a TEE run by
[OutLayer](https://outlayer.ai). Then one NEAR transaction either pays the worker and hands the buyer the key, or
refunds the buyer and releases nothing.

<p align="center"><img src="docs/flow.svg" width="860" alt="How a sealed job runs: 1, the client funds the escrow with its criteria; 2, the worker puts the sealed delivery and its hash dh on the escrow and its key K in OutLayer's secret store, readable only by this judge when the escrow asks; 3, the escrow asks OutLayer for a ruling; 4, the judge, in a TEE, decrypts, checks dh and scores, and returns the verdict with k, the key sealed to the client, on a pass; 5, in one callback the escrow pays the worker and gives the client k, or refunds the client; 6, anyone re-runs the same wasm on the same input and gets the same verdict."></p>

Step 5 is one callback: on a pass the worker is paid and the client gets the key together; on a fail the client is
refunded and the key is never sent. Step 6 needs nobody's permission.

**See it on NEAR testnet.** Each link opens the ruling on the project page, which re-runs the judge in your browser.

- Job 7 passed: the worker was paid and the client got the key, in one transaction
  ([HbByxt...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=HbByxt3x5HdNwwx8PxNWjAu5FpLATbUpr719K8uTexwB&signer=judgenear-worker.testnet)).
- Job 8 failed: the client was refunded and the key was never released
  ([42xXF6...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=42xXF6fnYPHWEuqc1HUHK7fPDJ9MmwWXXdFYB2SuCq72&signer=judgenear-worker.testnet)).
- The key's own owner asked OutLayer for it directly, outside the escrow, and was refused
  ([FZQN68...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=FZQN68oqzaN4SW9bDd11DECEJNEnrdf6YovdmNu2E84f&signer=judgenear-worker.testnet)).

**Re-run a ruling yourself**, with Node 22 and no NEAR account:

```sh
git clone https://github.com/vijaygopalbalasa/judge-near && cd judge-near/agents && npm ci
node jn.mjs verify --tx G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1 --signer judgenear-worker.testnet
```

**The limits, plainly:**

- Testnet only, and no outside users yet.
- The judge checks what a program can check: fields, length, terms, JSON shape, an exact SHA-256. It cannot tell
  whether a report's facts are true ([more below](#what-the-judge-checks-and-what-it-cannot)).
- The escrow account still has its deploy key, so its owner could replace the code. It was used once, to deploy a
  fix (below). Removing it is one transaction.
- You trust Intel TDX and OutLayer: its workers, its keystore and its contract.

Built at NEAR HACKATHON (Nov 1 to 14, 2026). Tracks: Privacy & Private AI, Agent Economy, AI Security & Defense.

## Why the judge is a program, not a language model

- **Words in a delivery cannot change its rules.** On the page, the third example is a delivery that tells the grader
  to ignore the checks and pass it. It scores 0.
- **The worker knows the verdict in advance.** It runs the same judge before delivering, so an honest worker is never
  surprised.
- **Anyone can re-run the ruling.** The judge has no network, clock or randomness. The same input gives the same
  bytes, so a ruling is checked, not trusted.

## What the judge checks, and what it cannot

The judge checks a delivery's form and exact content: required fields and their types, length, required terms, a
JSON shape (counts, unique values, URL and email formats), and an exact SHA-256. The five kinds and their parameters
are in [`docs/interface.md`](docs/interface.md#2-criteria-schema), section 2.

It does not know whether the content is true. The criteria of job 8 pass a report with invented numbers as readily
as an honest one. In jobs 6 and 8 the honest worker lost because it left out a field it had no fact for; a worker
that made the field up would have been paid. Honesty there is the worker's choice, not the escrow's rule.

So it fits work whose acceptance test is its form or its exact content:

- **A file whose SHA-256 the buyer already knows**, such as a dataset or a document whose hash was published. The
  `checksum` kind checks the exact bytes: the seller is paid only for the right file, and the buyer gets it only then.
- **Structured data where completeness is the test.** Every key of a translation file present and under a length
  limit; a list of fifty entries with unique domains and valid URLs.
- **A first gate before a review.** The judge settles the form and the payment rule; a person or a model can review
  what passed.

## How this differs

| Approach | The catch |
|---|---|
| The buyer pays after the work arrives | The buyer can keep the work and refuse to pay |
| The buyer pays first | The worker can deliver nothing |
| A human arbitrator | Slow, costly and subjective |
| A language model as judge | Text in the delivery can steer it, and its ruling cannot be re-run byte for byte |
| An optimistic escrow with a dispute window | Someone must watch, and post a bond to dispute |
| A zero-knowledge contingent payment | A new circuit for every kind of task |
| **Judge on NEAR** | Only checks a program can make; you trust the TEE and OutLayer |

Here the work stays encrypted until a fixed program passes it, payment and key move in one transaction, and anyone can
re-run the ruling.

## Try it (no NEAR account needed)

**1. In a terminal.** The two commands above read the testnet transaction in which the escrow asked OutLayer for job
0's ruling. They download the exact wasm OutLayer ran and check its SHA-256 against the hash OutLayer was told to run
and against the published build. Then they re-run it on the same input and compare the verdicts. Expected: ten `ok`
lines and "Verified: judge v2 (public and sealed jobs), commit fd3dcc6 computes exactly this ruling (pass: true,
score: 100)."

Job 1 and job 4's first ruling (`key_missing`) verify the same way. A sealed ruling cannot be re-run without its
delivery key: it prints the checks that need no key and ends with "not re-run" (exit status 1). Transactions are read
from NEAR archival nodes (FastNEAR's, then NEAR's own), because regular testnet nodes drop them after about 30 hours;
set `JN_ARCHIVAL_RPC` to use another.

**2. In a browser.** Open https://vijaygopalbalasa.github.io/judge-near/web/, which is this repository served by
GitHub Pages. Or serve it yourself from the repository root with `python3 -m http.server 8080` and open
http://localhost:8080/web/.

- **Try the judge** runs it on criteria and a delivery you type, after checking that the judge file is a published
  build. It has four examples and names the problem in criteria the judge calls invalid.
- **Jobs on the escrow** reads it live. Expected: "Runs the published escrow build" (code hash
  `HWowCok2UCH5XZsTBPYuaph3jPVjJEjbs2jhK2h7c94t`) and "Its judge is judge v2" in green, and an amber line while the
  account still has its deploy key. Below that, one card per job, newest first, each with its rulings. FastNEAR's
  transaction index finds the rulings; the list in `web/escrow.js` stands in when it does not answer.
- **Verify** on job 0's ruling gives eleven green checks and "Verified". A sealed ruling without its key gives nine
  green checks, a circle on the re-run, and "Consistent, not re-run". Jobs 2 to 4 sealed texts that jobs 0 and 1
  delivered in public, so their cards also offer **Verify on the disclosed text**, which re-runs them in full.
- **Re-run any ruling** takes any ruling transaction, with the delivery key or a disclosed delivery if you have one,
  pasted or loaded from a file. A link of the form `web/?tx=<hash>&signer=<account>` opens a ruling there; every
  ruling link in this README is one.

**3. Two agents, offline.** See [below](#two-agents-no-human): `node agent.mjs preview` shows the report the worker
agent would deliver next, with the judge's verdict on it.

## How it works

- **The judge** (`judge-wasm/`) reads `{criteria, deliverable}` on stdin and prints a compact verdict:
  `{"v":1,"pass":true,"score":100,"th":100,"ch":...,"dh":...,"checks":[...],"eh":...}`. `ch` and `dh` are the SHA-256
  of the exact criteria and delivery. `eh` hashes the verdict's own fields; it names the verdict and proves nothing by
  itself, because the proof is re-running the judge.
- **The escrow** (`contract/`) pins the judge's URL and SHA-256 at deployment and has no method to change them. Only
  the client or the worker may ask for a ruling, and they pay a minimum fee, so rulings cannot stall a job. Delivered
  work gets an hour of grace after the deadline before any refund. No refund is possible while a ruling runs, and a
  lost callback can never lock money.
- **Sealed mode** (`docs/interface.md`, section 6) keeps the delivery encrypted. The worker's key is an OutLayer
  secret bound to the judge's wasm hash and to the escrow as the only caller. The judge decrypts inside the TEE,
  checks the delivery against `dh`, and on a pass seals the key to the client's X25519 key.
- **The verifier** (`web/`, and `node jn.mjs verify` in `agents/`) re-runs any ruling from its transaction with a
  100-line WASI host. Without the key, a sealed ruling still gets every check that needs none: its `ch`, `dh` and `eh`
  must match the job's criteria, the worker's commitment and the verdict itself. Once the worker or the client
  discloses the delivery, anyone can re-run it in full: the text must hash to `dh`, and the verdict on it must match
  in every field but `k` and `eh` (`docs/interface.md`, section 6.6).

Where the delivery key lives, in a sealed job:

1. The worker makes a fresh 32-byte key `K`, encrypts the delivery with it, and commits to `dh`, the SHA-256 of the
   plain delivery.
2. `K` goes to OutLayer's keystore, encrypted on the worker's machine, under the rule "this judge build, called by this
   escrow". The escrow stores only the ciphertext and `dh`.
3. When either party asks for a ruling, OutLayer hands `K` to the judge inside the TEE. The judge decrypts, checks the
   plain delivery against `dh`, and runs the client's checks.
4. On a pass the judge seals `K` to the client's X25519 key (`k`). The escrow pays the worker and stores `k` in the
   same callback. On a fail there is no `k`, and the escrow refunds the client.
5. The client opens `k` with its secret key, decrypts the delivery and checks it against `dh` (`node jn.mjs open`).
6. Once the job has settled, the worker deletes `K` from the vault (`node jn.mjs forget`).

Terms: `K` is the worker's key for one delivery; `k` is `K` sealed to the client's X25519 key; `ch` and `dh` are the
SHA-256 of the criteria and of the plain delivery; `eh` is the SHA-256 of a verdict's own fields. OutLayer is a NEAR
service that runs a wasm file in Intel TDX machines when a contract asks, with a vault for secrets. The full contract
between the parts is in [`docs/interface.md`](docs/interface.md).

## Why NEAR

- **OutLayer's vault rules** make sealed delivery possible. A secret can be bound to one wasm hash (`WasmHash`) and to
  one calling contract (`Predecessor`), so only this judge, asked by this escrow, can open it.
- **Yield and resume**: OutLayer parks the escrow's request with NEAR's yield and resumes it when the TEE run is done,
  so the escrow settles in the same transaction that asked for the ruling.
- When an agent hires an agent, no human accepts the work, and a grader the payer controls is not neutral. This
  escrow gives both sides a neutral judge that anyone can re-run.

## Evidence on testnet

Each transaction link opens the project page, which reads the transaction from NEAR archival nodes: a ruling opens
in the verifier, anything else in `web/tx.html`. The public testnet explorer, testnet.nearblocks.io, has not indexed
testnet since Sep 27 2026. To read one without the page:
`curl -s https://archival-rpc.testnet.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"<hash>","sender_account_id":"<signer>","wait_until":"FINAL"}}'`.

| What | Transaction |
|---|---|
| The judge ran on OutLayer and returned the same verdict as a local run (121,432 instructions, 0.0011 NEAR) | [4VFvzo...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=4VFvzoQZEZf7DUZt1WnviReZVVsYYjFPSvtE6skr25jk&signer=judgeprotocol.testnet) |
| A secret bound to probe build A was handed to build A | [CrA7ML...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=CrA7MLCcJGwg9ytof41tJESpREJpWDsyRtXLefbJFahg&signer=judgeprotocol.testnet) |
| The same secret was not handed to build B (different hash) | [DpJTH9...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=DpJTH9HBM3ovqQhutGvEcReVd4iHub8wUgLAHFpBmEiT&signer=judgeprotocol.testnet) |
| A caller rule that does not name the caller was refused ("Access denied by access condition") | [5b7BnF...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=5b7BnFoMBK5MFx1LXMqE7bNgAYwiQRC1xEwpJmX3Prfh&signer=judgeprotocol.testnet) |
| The worker, who owns job 5's key, asked OutLayer directly (not through the escrow) to run the published judge on that key: refused | [FZQN68...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=FZQN68oqzaN4SW9bDd11DECEJNEnrdf6YovdmNu2E84f&signer=judgenear-worker.testnet) |
| The client asked the same: refused | [WKN5M1...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=WKN5M1AeGvFJbmXwQhCvU5UPbGSXESTFKFiFNoU2W1Y&signer=judgenear-client.testnet) |

The first probes were signed and called by the same account, so they could not tell the `Predecessor` rule from a
plain whitelist. Job 3 below is the positive case: the client signed that sealed ruling and owns nothing in the vault,
the escrow was the caller OutLayer recorded, and the judge still read the worker's key (it scored the delivery 50
instead of answering `key_missing`). The last two rows are the negative case, from `tools/vault-probe.mjs`. The key's
owner and the client each called OutLayer themselves, with the published judge and job 5's secrets profile, and
OutLayer refused both before running anything. So the rule is checked against the calling contract, not the signer or
the owner. A third party's contract was not run; it would be another caller that is not the escrow.

### The escrow on testnet

`judgenear-escrow.testnet` was deployed and initialised in one transaction,
[FfrcKX...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=FfrcKXWFetEq4pUt7WvoztNFQ1jsQusb2bP1rpdWoYva&signer=judgenear-escrow.testnet),
with `tools/deploy-escrow.mjs`. On Nov 3 the same tool replaced its code with v3, code only, [9YmrPJ...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=9YmrPJV8uRJhZ3YmVXkSmsiqhjjrpW3i52K9BFkNkXUS&signer=judgenear-escrow.testnet), to close a refund
race ([the limits](#security-model-and-honest-limits) say which). It checked that `get_judge` and all nine jobs read
back unchanged. NEAR reports its code hash as `HWowCok2UCH5XZsTBPYuaph3jPVjJEjbs2jhK2h7c94t`, the build in
`contract/BUILD.md`. Its `get_judge` names judge v2 (URL pinned to commit fd3dcc6, SHA-256 `911b8a35...`). The jobs
below ran under v2; their rulings verify the same way, because the verifier reads each ruling from its own
transaction. The account still has its deploy key; see the limits below. Each job ran between `judgenear-client.testnet` and
`judgenear-worker.testnet`, 0.5 NEAR each, on Nov 2 2026: jobs 0 to 4 step by step with `agents/jn.mjs`, jobs 5 to 8
by the two agents ([below](#two-agents-no-human)).

| Job | What happened | Ruling |
|---|---|---|
| 0, public | Both checks passed (score 100); the escrow paid the worker | [G5zVDo...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1&signer=judgenear-worker.testnet) |
| 1, public | The delivery never names NEAR or USDC (score 50); the client was refunded | [GgZvjQ...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=GgZvjQg35vQfMsdRovKP6ze3faQyutKFkBDDzLm7JfCT&signer=judgenear-client.testnet) |
| 2, sealed | The judge read the worker's key from the vault, decrypted the delivery, passed it and released the key sealed to the client; the worker was paid, and `open` gave the client the exact delivery | [5nC2AB...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=5nC2ABEDbFKFzVY8nzVaJooyD3uW2xxpbH2VuvgcYNsh&signer=judgenear-worker.testnet) |
| 3, sealed | Score 50; the client was refunded and the key was never released | [3sCPet...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=3sCPetXoYFwuoyStnKmjZHiLnh1rBQW9nKNyGvyfCAib&signer=judgenear-client.testnet) |
| 4, sealed | The worker's key was never stored (a test harness skipped that step, which the tool always does first); the judge answered `key_missing`, no money moved, and the job went back to Submitted | [J5hX6n...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=J5hX6nup9AjXM4hsGXcRf29u279RAgseK3qZ9A8HPNt3&signer=judgenear-worker.testnet) |
| 4, again | `submit-sealed` stored the saved key again ([7BiGSn...](https://vijaygopalbalasa.github.io/judge-near/web/tx.html?tx=7BiGSnZZWcFHY4nH2RB4cgs1fzAsYo6ifNCah4a4vnXs&signer=judgenear-worker.testnet)); the second ruling passed, paid the worker and released the key | [5G6jQj...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=5G6jQja3xjvw6tnzkmpE3P86Sracs5PFStJJP38o4a2J&signer=judgenear-worker.testnet) |
| 5, sealed | Two agents: the report had all seven fields the client required (score 100); the worker was paid and the client opened the report | [5E4FiC...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=5E4FiCfc1CQ7ywUeEDZ9jVMpkronjaCH4oNWWqM8hN71&signer=judgenear-worker.testnet) |
| 6, sealed | Two agents: the client also required `mainnet_tvl_usd`, and the report was missing it (score 50); the client was refunded and the key was never released | [7rjHmF...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=7rjHmFL8w9keTZVf1ybXVawxGTQibVdpkJxEWa2xCn7r&signer=judgenear-worker.testnet) |
| 7, sealed | Two agents, the report ending in a random nonce: all seven fields present (score 100); the worker was paid and the client opened the report | [HbByxt...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=HbByxt3x5HdNwwx8PxNWjAu5FpLATbUpr719K8uTexwB&signer=judgenear-worker.testnet) |
| 8, sealed | Two agents, with a nonce: the report was missing `mainnet_tvl_usd`; the worker's own check said it would fail and `--deliver-anyway` sent it (score 50); the client was refunded and the key was never released | [42xXF6...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=42xXF6fnYPHWEuqc1HUHK7fPDJ9MmwWXXdFYB2SuCq72&signer=judgenear-worker.testnet) |

Every ruling above verifies with `node jn.mjs verify --tx <ruling> --signer <who signed it>`. The public ones verify
as they are, and the key_missing one without a key. The sealed ones need `--as` the client (once the key is released)
or the worker, whose saved key the tool loads in memory and hands only to the checked judge. Without `--as`, a sealed
ruling gets only the checks that need no key and ends with "not re-run" (exit status 1); the page's Verify buttons do
the same. A sealed ruling whose delivery is disclosed also verifies with `--delivery <file>` and no key: jobs 2 to 4
sealed the public texts of jobs 0 and 1, so all three verify in full that way. Signers: jobs 1 and 3 were signed by
`judgenear-client.testnet`, the others by `judgenear-worker.testnet`.

Only jobs 7 and 8 are unguessable. Jobs 2 to 4 reuse the delivery texts of the public jobs (jobs 2 and 4 seal the text
of job 0, job 3 the text of job 1), so their `dh` values match. Jobs 5 and 6 seal reports built only from public facts
in a public format, so their `dh` can be matched by guessing; an outside review recovered both in under a second.
Since then the worker ends every report with 128 random bits, so the `dh` of jobs 7 and 8 gives nothing away.

### Two agents, no human

`agents/agent.mjs` runs a client and a worker as two processes that share nothing but the chain. The client posts a
sealed job with the criteria in a task file, funds it and waits. The worker watches the escrow for funded sealed jobs
that name it and pay at least its minimum (0.1 NEAR by default). It fills the fields the criteria's schema check
requires from facts it reads on chain: the escrow's job counts and what it has paid, at its own clock. It ends the
report with a random 128-bit nonce, so the public `dh` cannot be guessed. It runs the judge on the report first, and
only if that passes delivers it sealed and asks for the ruling. The client opens the delivery once the key is released.

The worker's skill is a plain program, not a language model. It leaves out any field it has no fact for, so jobs 6
and 8 failed on the missing field. The judge would have passed a made-up value of the right type: see
[what the judge checks](#what-the-judge-checks-and-what-it-cannot). To see what it would deliver for the next job,
with the judge's verdict, without a NEAR account:

```sh
cd agents && npm ci
JN_ESCROW=judgenear-escrow.testnet node agent.mjs preview --task tasks/escrow-report.json
```

Expected: the JSON report with its nonce, and "the judge, run here: pass, score 100 (schema#0 ok, length#1 ok)". With
`tasks/escrow-report-with-tvl.json`, which also requires a `mainnet_tvl_usd` field the worker has no fact for: "the
judge, run here: fail, score 50 (schema#0 failed, length#1 ok)". `agents/test/agent.test.mjs` runs both agents at once
against a fake escrow and OutLayer that run the real judge. It covers a worker that declines a report the judge would
fail, a worker that declines a job paying less than its minimum, and a client that shows a hostile delivery's terminal
control characters as visible codes.

Jobs 5 to 8 in the table above were run this way on Nov 2 2026, each by two processes with no input after they
started (`node agent.mjs worker --as judgenear-worker.testnet --once` and `node agent.mjs client --as
judgenear-client.testnet --provider judgenear-worker.testnet --task <task file>`). Jobs 6 and 8 used the second task.
Jobs 5 and 6 came from the first version of the worker, which had no nonce and delivered what it had without checking
it first. Jobs 7 and 8 come from the current worker; job 8 was sent with `--deliver-anyway`, the way to show a failing
delivery, after the worker's own check said it would fail.

## Status and tests

| Part | State |
|---|---|
| Judge (Rust, `wasm32-wasip1`) | Works, v2 (public and sealed jobs): 305 parity vectors against the original engine and 42 sealed vectors, fuel-bounded; the build reproduces byte for byte on macOS on Apple silicon |
| Judge on OutLayer testnet | Works: v1 called directly ([4VFvzo...](https://vijaygopalbalasa.github.io/judge-near/web/?tx=4VFvzoQZEZf7DUZt1WnviReZVVsYYjFPSvtE6skr25jk&signer=judgeprotocol.testnet)) and v2 called by the escrow for ten rulings; every public verdict is identical to a local run, every sealed one consistent without the key and identical with it, and jobs 2 to 4 re-run in full on their disclosed text |
| OutLayer vault rules for sealed keys | Checked on testnet with `tools/keystore-probe` and `tools/vault-probe.mjs`: only this judge build, called by the escrow, reads a key; the key's owner and the client asking directly were refused |
| Verifier (`web/`, and `jn verify`) | Works: public rulings, sealed rulings with the key or on a disclosed delivery, and key_missing rulings; the page lists the escrow's jobs live, and for any other ruling it names who asked for it |
| Escrow (near-sdk 5), public and sealed jobs | Works: 116 unit tests, 14 sandbox tests, 83 planted bugs caught; deployed as `judgenear-escrow.testnet` (v3 since Nov 3), code hash matching `contract/BUILD.md` |
| Agent command line tool (`agents/jn.mjs`) | Works: create, fund, submit, sealed submit, ruling, open, verify, forget; checks criteria and deliveries with the judge before sending; checks the escrow's code and judge before any live step; every path run live on testnet |
| Two agents (`agents/agent.mjs`) | Works: two passes and two fails live on testnet (jobs 5 to 8); 81 offline tests in `agents/` |

**Run the tests.** Every row below also runs in CI on every push (`.github/workflows/test.yml`), except the two
mutation runs.

| Command | Expected |
|---|---|
| `cd judge-wasm && cargo test --locked` | 38 passed (rustup installs the pinned rustc 1.99.1) |
| `node --test web/test/*.test.mjs` | 63 passed (Node 22 or newer, no dependencies) |
| `cd judge-wasm && bash scripts/fuel-check.sh 3000000000 release/judge.wasm` | all 21 adversarial inputs (6 sealed) finish under 3B instructions; needs `wasmtime` |
| `cd contract && cargo test --lib --locked` | 116 passed; building the test dependencies downloads the NEAR sandbox (about 29 MB) once, unless `NEAR_SANDBOX_BIN_PATH` names one already on disk |
| `cd contract && cargo test --test integration -- --test-threads=1` | 14 passed, 3 to 8 minutes; needs [cargo-near](https://github.com/near/cargo-near) 0.22 (`cargo install cargo-near --version 0.22.0 --locked`), which the tests use to build the escrow |
| `cd agents && npm ci && npm test` | 81 passed (Node 22 or newer); one test runs the real judge under `wasmtime` |
| `python3 judge-wasm/scripts/mutate.py` | 56 of 56 planted bugs caught, one at a time (3 to 10 minutes) |
| `python3 contract/scripts/mutate.py` | 82 of 82 planted bugs caught by the unit tests (10 to 30 minutes); the 83rd, `#[private]` removed, is caught only by the sandbox test `on_ruling_is_private`, checked by planting it by hand |

**Reproduce the judge build.** With `rustup target add wasm32-wasip1`:

```sh
cd judge-wasm
CARGO_ENCODED_RUSTFLAGS="$(printf -- '--remap-path-prefix=%s=/src\037--remap-path-prefix=%s=/cargo' "$(pwd)" "${CARGO_HOME:-$HOME/.cargo}")" \
  cargo build --release --locked --target wasm32-wasip1
shasum -a 256 target/wasm32-wasip1/release/judge.wasm
```

Expected with rustc 1.99.1 on macOS on Apple silicon, the host the published judge was built on:
`911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958` (judge v2), the hash in
`judge-wasm/release/judge.wasm.sha256`. GitHub's macOS arm64 runner rebuilds it and checks the hash on every push (job
`judge-build-macos`), and does the same for the escrow against `contract/BUILD.md` (job `contract-build-macos`). On
another host the bytes differ: cargo mixes the host into the metadata hash it gives each crate, so the functions come
out in a different order (same size, same data; the `judge-build-linux` job prints the Linux hash). The path
remapping makes the hash independent of where you clone. The first testnet run used judge v1
(`da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1`, built the same way from commit e09c6f9). The
toolchain is recorded in `judge-wasm/BUILD.md`.

## Path to mainnet

1. Remove the escrow's deploy key on testnet (one transaction), so its code can never change.
2. Deploy the same build on mainnet, pointing at OutLayer's mainnet contract, `outlayer.near`.
3. Whoever asks for a ruling pays OutLayer for the run; the first run cost 0.0011 NEAR. The escrow takes no fee.
4. Any agent that can run a command can use it today: `jn.mjs` covers every step, with `--dry-run` on each.

## Security model and honest limits

- **What you trust:** Intel TDX and OutLayer's worker registration (each worker's TEE is checked once when it
  registers, and results arrive from registered worker keys), plus the published judge build. The attestation shows
  which code ran, not that the code is right; the judge's tests, parity vectors and mutation logs are how you check
  that. Also trusted: OutLayer's keystore coordinator (the worker encrypts its key to the public key it serves over
  HTTPS; this tool does not check an attestation for it), OutLayer's contract (its owner can upgrade it), and the vault
  rule as OutLayer enforces it (off chain: a refusal is an OutLayer event, not a contract revert). The verifier trusts
  the RPC node it reads. To list rulings, the page asks FastNEAR's transaction index for the escrow's transactions; an
  index that left one out could hide a ruling, but it cannot make one pass, because Verify reads each ruling from NEAR
  archival nodes. The judge file's host (GitHub) is not trusted: OutLayer and the verifier check its SHA-256.
- **What the judge can check:** properties a program can verify (length, terms, JSON structure, checksums). It does
  not judge truth, taste or open-ended quality ([above](#what-the-judge-checks-and-what-it-cannot)).
- **What is public:** in sealed jobs the criteria, the per-check results and the hashes are on chain; the delivery and
  its key are not. `dh` is the SHA-256 of the plain delivery, so anyone who can guess the exact delivery can confirm
  the guess: sealing hides work that cannot be guessed, not a yes-or-no answer. The ciphertext's length gives the
  delivery's length (there is no padding), and OutLayer records each run's instruction count and time. On a fail the
  client sees which of its own checks failed, not the delivery.
- **Deadlines:** a delivered job becomes refundable one hour after its deadline, and from then on no ruling can
  start. While a ruling runs, no refund is possible. If no ruling lands before the hour ends (for example, if OutLayer
  is down), the client can take the refund even for a delivery that would have passed: money never locks, and a late
  worker can lose. A ruling lost for a whole day can be refunded too.
- **The refund race, fixed on Nov 3:** escrow v2 let a client ask for a ruling after the grace hour and take the
  refund a block later. OutLayer still ran the judge and published `k`, sealed to the client, while the escrow paid
  nobody. v3 closes it with the two rules above; `late_ruling_cannot_be_refunded_while_it_runs` replays the attack in
  the sandbox, with the ruling held open as OutLayer's yield holds it (it fails on v2 and passes on v3).
- **Cost bound:** the judge's measured worst case over adversarial but valid inputs is about 0.60 billion
  instructions and 22 ms; the escrow asks OutLayer for 50 billion instructions and 30 seconds
  (`judge-wasm/RESOURCE-LIMITS.md`).
- **The escrow account:** OutLayer's keystore rule names the escrow account, so a worker also trusts the code that
  account runs. `agents/` checks its code hash and judge before every live step, but an account that still has a
  full-access key can have its code replaced by its owner. `judgenear-escrow.testnet` still has its deploy key; its
  owner used it once, on Nov 3 2026, to deploy v3. The page shows this in amber and turns it green once the key is
  gone. Settled jobs keep no key in the vault (the worker
  deletes it), so a replaced escrow could not read them.
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
| `docs/interface.md` | Input, criteria, verdict, hashes, contract rules and sealed mode, in one place |

## Prior work

The check kinds are ported from the MIT-licensed JavaScript engine of
[Judge Protocol](https://github.com/vijaygopalbalasa/judge-protocol), by the same author. Everything in this
repository, including the Rust port, is new work written during the hackathon.

## License

MIT

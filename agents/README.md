# Judge on NEAR agents

A small command line tool that runs a Judge on NEAR job end to end on testnet: the client
creates and funds a job, the worker delivers, anyone involved asks for a ruling, and for a
sealed job the client opens the delivery once it has passed. `verify` re-runs any ruling
locally. It follows `../docs/interface.md` (section 6 for sealed jobs).

## Setup

Node 22 or newer. One dependency, near-api-js 7.3.1.

```sh
cd agents
npm ci
export JN_ESCROW=<escrow account id>   # the live testnet escrow is judgenear-escrow.testnet
```

Each signer needs a NEAR testnet key in `~/.near-credentials/testnet/<account>.json` (the
file near-cli writes). The tool reads it inside the process to sign, and never prints it.
Set `JN_RPC` to use another RPC endpoint (for every command except `verify`, below).

## Secrets

Sealed jobs create two secrets. Both are kept only under `~/.judge-near/<account>/`
(folder mode 0700, files 0600), never in this repository, and never printed:

- the client's X25519 secret, `x25519-<client_pk>.json`, made by `create --sealed`. Only
  this key opens the released `k`, so keep a backup.
- the worker's per-job key K, `K-<escrow>-<job>.json`, made by `submit-sealed`. It goes
  to the judge only through OutLayer's keystore, encrypted on this machine. A retry of
  `submit-sealed` reuses the saved K.

If a sealed ruling comes back `key_missing` (the judge found no key in the vault), no money
moves and the job returns to Submitted. Run `submit-sealed` again with the same file: it sees
the job is already submitted with that delivery, stores the saved K again and sends nothing
else. Then ask for a ruling again.

`open` writes the decrypted delivery to a file with mode 0600.

## Safety checks

Before any live step, every command except `open`, `status` and `verify` checks the escrow it is about to use:

- the code hash NEAR reports for it must be the published escrow build (`../contract/BUILD.md`), and
- its `get_judge` must name the published judge (`../judge-wasm/release/judge.wasm.sha256`).

OutLayer's keystore rule names the escrow account, so a fake escrow could otherwise run the real
judge on inputs it chose and take a sealed delivery without paying. `ruling` also refuses to
attach more than 0.1 NEAR. To use another build on purpose, pass its exact hash with
`--escrow-code-hash` or `--judge-hash`.

`submit-sealed` also reads the job first: it must be this worker's sealed job, Funded (or
Submitted with the same delivery, to store the key again), so a wrong job number costs no
keystore fee and saves no key.

## Commands

```
node jn.mjs create        --as CLIENT --provider WORKER --criteria file.json --expires-in 2h [--sealed]
node jn.mjs fund          --as CLIENT --job N --amount 1
node jn.mjs submit        --as WORKER --job N --file deliverable.txt
node jn.mjs submit-sealed --as WORKER --job N --file deliverable.txt
node jn.mjs ruling        --as CLIENT_OR_WORKER --job N
node jn.mjs open          --as CLIENT --job N [--out file]
node jn.mjs status        --job N
node jn.mjs verify        --tx RULING_TX --signer WHO_SIGNED_IT [--as CLIENT_OR_WORKER]
```

The criteria and deliverable files are sent byte for byte, a trailing newline included,
since the judge hashes exactly what is stored. Every command prints the exact contract
call (method, arguments with long values shortened, deposit, gas) before sending it.
With `--dry-run` it prints the call and stops: no key is read, no secret is written, and
nothing touches the network.

## Verify a ruling

`verify` runs the browser verifier's checks (`../web/verify.js`) in a terminal: it finds the
OutLayer run in the ruling transaction, downloads the wasm OutLayer ran, checks its SHA-256
against the run and against the published judge builds, re-runs it here on the same input and
compares the verdicts field by field. It needs no `JN_ESCROW` and no NEAR key: the escrow and
job come from the transaction. It exits with status 1 if anything does not verify. It reads the
ruling from a NEAR archival node (FastNEAR's, then NEAR's own if the first is down, rate limited
or lacks the transaction), because regular testnet nodes drop transactions after about 30 hours;
set `JN_ARCHIVAL_RPC` to use another.

```sh
node jn.mjs verify --tx G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1 --signer judgenear-worker.testnet
```

A sealed ruling can only be re-run with the delivery key. `--as` the job's client (once the
key is released) opens it from `k` with the client's saved X25519 key; `--as` the worker uses
the saved K. The key stays in memory and goes only to the judge build whose bytes were just
checked. A `key_missing` ruling is re-run without a key, as OutLayer ran it.

## Demo: a sealed job

`create` prints the new job number; use it for `--job`.

```sh
node jn.mjs create --as <client> --provider <worker> --criteria examples/criteria.json --expires-in 2h --sealed
node jn.mjs fund --as <client> --job <N> --amount 1
node jn.mjs submit-sealed --as <worker> --job <N> --file examples/deliverable.txt
node jn.mjs ruling --as <worker> --job <N>
node jn.mjs open --as <client> --job <N> --out delivered.txt
node jn.mjs status --job <N>
```

`examples/deliverable.txt` passes the example criteria, so the ruling pays the worker and
releases `k`, and `open` writes the delivery. `examples/deliverable-fail.txt` fails them
(it never names USDC), so the client is refunded and nothing is opened.

## Two agents, no human

`agent.mjs` runs a client and a worker as two processes that share nothing but the chain.

```sh
node agent.mjs worker --as <worker> --once
node agent.mjs client --as <client> --provider <worker> --task tasks/escrow-report.json --amount 0.5 --out-dir .
```

The client posts a sealed job with the criteria in the task file, funds it, waits for the
escrow to settle, and opens the delivery if it passed. The worker watches the escrow for
funded sealed jobs that name it and pay at least `--min-amount` (0.1 NEAR by default), fills
the fields the criteria's schema check requires from facts it reads on chain
(`lib/skill.mjs`: the escrow's job counts and what it has paid, at its clock), and runs the
judge on its report here. Every report ends with a random 128-bit nonce, so its public `dh`
cannot be guessed. Only a report that passes is delivered sealed with `submit-sealed`,
followed by the ruling: a delivery costs the worker a vault deposit, storage and gas, so it
does not pay for one the judge would fail. The skill is a plain program, not a language
model, and it never invents a field it has no fact for: `tasks/escrow-report-with-tvl.json`
also requires `mainnet_tvl_usd`, which it leaves out, so the worker declines that job, or,
with `--deliver-anyway`, delivers it and the judge fails it on chain. The worker never prints
its report; the client shows it only after opening it, with any terminal control characters
shown as visible codes.

To see what the worker would deliver for the next job, with the judge's verdict on it, run
here (reads the chain, signs nothing, no NEAR account needed):

```sh
node agent.mjs preview --task tasks/escrow-report.json
```

## Tests

```sh
npm test
```

They run offline: a fake chain and keystore stand in for the network, and each test uses a
temporary home folder. `test/agent.test.mjs` runs both agents at once against a fake escrow
and OutLayer that run the real judge through `../web/verify.js`. One test in
`test/crypto.test.mjs` runs the real judge (`../judge-wasm/release/judge.wasm`) under wasmtime
when it is installed.

## Run live

Every path above ran on testnet on Nov 2 2026 against `judgenear-escrow.testnet`: a public
pass and fail, a sealed pass (opened by the client) and fail, a `key_missing` ruling, and its
recovery with `submit-sealed`. The two agents ran jobs 5 and 7 (pass, opened by the client) and
6 and 8 (fail, refunded). Jobs 5 and 6 came from the first worker, without a nonce or a check
before delivering; jobs 7 and 8 from the current one, job 8 with `--deliver-anyway`.
`../tools/vault-probe.mjs` asked OutLayer directly for job 5's key, as the worker and as the
client; OutLayer refused both. The transactions are in the main README. One limit: the key was
stored again live only for a job whose vault profile had never been created (job 4); storing
over a key the vault already holds was not run live.

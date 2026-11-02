# Judge on NEAR agents

A small command line tool that runs a Judge on NEAR job end to end on testnet: the client
creates and funds a job, the worker delivers, anyone involved asks for a ruling, and for a
sealed job the client opens the delivery once it has passed. It follows
`../docs/interface.md` (section 6 for sealed jobs).

## Setup

Node 22 or newer. One dependency, near-api-js 7.3.1.

```sh
cd agents
npm ci
export JN_ESCROW=<escrow account id>
```

Each signer needs a NEAR testnet key in `~/.near-credentials/testnet/<account>.json` (the
file near-cli writes). The tool reads it inside the process to sign, and never prints it.
Set `JN_RPC` to use another RPC endpoint.

## Secrets

Sealed jobs create two secrets. Both are kept only under `~/.judge-near/<account>/`
(folder mode 0700, files 0600), never in this repository, and never printed:

- the client's X25519 secret, `x25519-<client_pk>.json`, made by `create --sealed`. Only
  this key opens the released `k`, so keep a backup.
- the worker's per-job key K, `K-<escrow>-<job>.json`, made by `submit-sealed`. It goes
  to the judge only through OutLayer's keystore, encrypted on this machine. A retry of
  `submit-sealed` reuses the saved K.

`open` writes the decrypted delivery to a file with mode 0600.

## Commands

```
node jn.mjs create        --as CLIENT --provider WORKER --criteria file.json --expires-in 2h [--sealed]
node jn.mjs fund          --as CLIENT --job N --amount 1
node jn.mjs submit        --as WORKER --job N --file deliverable.txt
node jn.mjs submit-sealed --as WORKER --job N --file deliverable.txt
node jn.mjs ruling        --as CLIENT_OR_WORKER --job N
node jn.mjs open          --as CLIENT --job N [--out file]
node jn.mjs status        --job N
```

The criteria and deliverable files are sent byte for byte, a trailing newline included,
since the judge hashes exactly what is stored. Every command prints the exact contract
call (method, arguments with long values shortened, deposit, gas) before sending it.
With `--dry-run` it prints the call and stops: no key is read, no secret is written, and
nothing touches the network.

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

## Tests

```sh
npm test
```

They run offline: a fake chain and keystore stand in for the network, and each test uses a
temporary home folder. One test runs the real judge (`../judge-wasm/release/judge.wasm`)
under wasmtime when it is installed.

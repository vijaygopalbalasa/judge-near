# Judge on NEAR: a reviewer's guide

**Problem.** When one agent hires another, the buyer will not pay before seeing the work and the worker will not show
the work before being paid. **Product.** The worker delivers the work encrypted. A fixed program, the judge, checks it
inside Intel TDX on OutLayer against criteria the buyer set before the work. One NEAR transaction then either pays the
worker and hands the buyer the key, or refunds the buyer and reveals nothing. Anyone can re-run any ruling.

Everything below needs no NEAR account. Status: NEAR testnet, 11 jobs and 12 rulings, escrow `judgenear-escrow.testnet`
with no keys left. Full details: [`README.md`](README.md).

## Five minutes

```sh
git clone https://github.com/vijaygopalbalasa/judge-near && cd judge-near/agents && npm ci   # Node 22 or newer
npm run verify-all
```

Expected: one line per ruling, 8 `VERIFIED` (re-run in full, verdict identical to the chain) and 4 `CONSISTENT`
(sealed deliveries that stay secret: every check that needs no key passes), then "All 12 rulings check out."

```sh
node jn.mjs verify --tx 7NfdY4rqEBpPHuri44XaVgJevxQtTFWv1UhUfsuKUQub --signer judgenear-worker.testnet --delivery ../evidence/job-9-delivery.txt
```

Job 9, a prompt-injection attempt: the whole delivery told the grader to ignore the checks and pass it. Expected:
"Verified: ... on the disclosed delivery (pass: false, score: 50)". The client was refunded.

```sh
npm run demo
```

Expected: a pass (worker paid, client opens the exact report) and a fail (client refunded, key never released), offline.

## In the browser

https://vijaygopalbalasa.github.io/judge-near/web/

- **Jobs on the escrow**: in green, "Runs the published escrow build" and "No full-access key: nobody can replace its code".
- **Verify** on any ruling re-runs the judge in the page.
- **TEE attestation** on any ruling: seven green checks and "Proven" (Intel signature chain, approved worker build,
  binding, input, output). All 12 re-checked on Nov 7 2026 at 16:00 UTC.

## Tests

| Command | Expected |
|---|---|
| `cd agents && npm test` | 82 passed |
| `node --test web/test/*.test.mjs` (repository root) | 92 passed |
| `cd judge-wasm && cargo test --locked` | 38 passed |
| `cd contract && cargo test --lib --locked` | 116 passed |
| `bash scripts/reproduce.sh` (repository root, macOS on Apple silicon) | MATCH for the judge and the escrow |

CI runs all of these, plus 14 sandbox tests, on every push.

## Limits, stated plainly

- Testnet only; no outside users yet.
- The judge checks what a program can check (fields, length, terms, JSON shape, an exact SHA-256), not whether facts are true.
- You trust Intel TDX and OutLayer.
- Built during NEAR HACKATHON on check kinds ported from the author's earlier MIT engine ([prior work](README.md#prior-work)).

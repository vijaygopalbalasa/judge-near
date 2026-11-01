# Interface: judge program <-> escrow contract <-> verifier (v1)

This file is the contract between the three parts of Judge on NEAR. If code disagrees with it, the code is wrong
or this file must be changed first.

## 1. Judge input (stdin of the WASM)

One JSON object, UTF-8:

```json
{"criteria": "<criteria JSON as a string>", "deliverable": "<deliverable text>"}
```

Both values are JSON strings. `criteria` is the exact text the client stored on chain (it is parsed inside the
judge); `deliverable` is the exact text the provider stored on chain. Hashes are taken over these exact bytes, so no
canonicalization is needed on either side.

Limits (enforced by the contract when the text is stored, and again by the judge):

| Field | Max UTF-8 bytes |
|---|---|
| criteria | 4,096 |
| deliverable | 16,384 |

## 2. Criteria schema

The same schema as Judge Protocol's JavaScript engine (`judge-protocol/judge-service/src/checkers/index.js`,
`validateCriteria`): `{"checks": [{"kind": ..., "weight"?: ..., ...}], "passThreshold"?: 0..100}`. Default threshold is
100. Network kinds (`http-endpoint`) are NOT allowed in v1: the judge treats them as invalid criteria. At most 16
checks. Scoring is the engine's `scoreOf`: weighted pass ratio, `Math.round` to an integer 0..100, capped at 99
when any check fails; `pass = score >= threshold`.

## 3. Verdict (stdout of the WASM)

Compact JSON, keys in exactly this order, no spaces, at most 900 bytes:

```json
{"v":1,"pass":true,"score":100,"th":100,"ch":"<64 hex>","dh":"<64 hex>","checks":[{"id":"length#0","ok":true}],"eh":"<64 hex>"}
```

When the criteria are invalid or the input is malformed, the verdict still prints, with `pass:false`, `score:0`,
`checks:[]` and an `err` field placed before `eh`:

```json
{"v":1,"pass":false,"score":0,"th":100,"ch":"...","dh":"...","checks":[],"err":"invalid_criteria","eh":"..."}
```

`err` codes: `invalid_input` (stdin is not the object above), `invalid_criteria`, `too_large`. When the input is
not parseable at all, `ch` and `dh` are the hashes of whatever bytes could be read for each field, or of the empty
string.

- `ch` = lowercase hex SHA-256 of the UTF-8 bytes of the `criteria` string.
- `dh` = lowercase hex SHA-256 of the UTF-8 bytes of the `deliverable` string.
- `checks[i].id` = `<kind>#<index in criteria.checks>`, at most 24 characters.
- `eh` = lowercase hex SHA-256 of the UTF-8 bytes of the verdict text that comes before `,"eh":`, with a closing `}`
  appended. In other words: serialize every field except `eh` in the order above, hash it, then insert `eh` last.
  A browser can recompute it with `JSON.stringify` on an object built in the same key order.

## 4. How the contract uses the verdict

- The contract calls `outlayer.testnet` (mainnet: `outlayer.near`) `request_execution` with
  `source = {"WasmUrl": {"url": <https URL>, "hash": <sha256 hex of the wasm>, "build_target": "wasm32-wasip1"}}`,
  the input above as `input_data`, `response_format = "Json"`, explicit `resource_limits`, and
  `payer_account_id` = the account that asked for the ruling (it gets the unused deposit back).
- The judge's URL and hash are fixed when the contract is initialised and cannot be changed by anyone.
- Only the job's client or provider can request a ruling, and the attached deposit must be at least the contract's
  `min_ruling_deposit` (also fixed at initialisation). With an adequate deposit OutLayer really runs the judge, so a
  request cannot be used to stall a job.
- Cost bound: the judge's measured worst case over adversarial but valid inputs (criteria at most 4,096 bytes,
  deliverable at most 16,384 bytes, at most 16 checks) is about 0.59 billion instructions, 1.75 MB and 21 ms
  (`judge-wasm/RESOURCE-LIMITS.md`, guarded by `judge-wasm/scripts/fuel-check.sh`). The contract asks OutLayer for
  50 billion instructions, 64 MB and 30 seconds, so valid criteria cannot exhaust the run and force a null result.
- Refunds: a Funded job (nothing delivered) refunds the client from `expires_at`. A Submitted or Ruling job refunds
  the client only from `expires_at` plus a grace period (1 hour), so delivered work always gets a window for a ruling,
  and money can never lock if nobody asks for one.
- The callback reads the raw promise result bytes (never a typed `#[callback_result]` that could panic on a
  surprise shape). OutLayer returns the guest's JSON as is when the run succeeds, and `null` for any failure.
- The contract acts on a verdict only if: it parses, `v == 1`, `ch` and `dh` equal the hashes it stored for that job,
  and the callback's `attempt` number equals the job's current ruling attempt. Then `pass:true` pays the provider and
  `pass:false` refunds the client. Anything else (null, garbage, mismatch, stale attempt) changes no money and puts
  the job back to `Submitted` so a ruling can be requested again.

## 5. OutLayer facts this design relies on (read from github.com/out-layer/outlayer at aaf60a2685, Nov 1 2026)

- `request_execution(source, resource_limits, input_data, secrets_ref, response_format, payer_account_id, params)`,
  `#[payable]`. It parks the call with a yield promise and returns the result through it.
- Success with `Json` format: the callback receives the guest's JSON bytes unchanged. Failure, timeout or no
  output: the bytes `null`.
- `WasmUrl.url` must start with `https://`; `hash` must be 64 lowercase hex characters.
- Testnet maximums (`get_max_limits`): 500,000,000,000 instructions, 180 seconds of execution, 300 seconds of
  compilation. Default `resource_limits`: 1,000,000,000 instructions, 128 MB, 60 seconds.
- Testnet pricing (`get_pricing`): base fee 0.001 NEAR, plus a fee per million instructions, per millisecond of run
  time and per millisecond of compilation. `estimate_execution_cost` gives the deposit. Unused deposit is refunded to
  `payer_account_id`.

# Interface: judge program <-> escrow contract <-> verifier (judge v2: public and sealed jobs; verdict format v1)

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
  deliverable at most 16,384 bytes, at most 16 checks) is about 0.60 billion instructions (a sealed pass with 16
  nested checks, 602.5 million), 1.75 MB and 22 ms
  (`judge-wasm/RESOURCE-LIMITS.md`, guarded by `judge-wasm/scripts/fuel-check.sh`). The contract asks OutLayer for
  50 billion instructions, 64 MB and 30 seconds, so valid criteria cannot exhaust the run and force a null result.
- Refunds: a Funded job (nothing delivered) refunds the client from `expires_at`. A Submitted or Ruling job refunds
  the client only from `expires_at` plus a grace period (1 hour), so delivered work always gets a window for a ruling,
  and money can never lock if nobody asks for one.
- The callback reads the raw promise result bytes (never a typed `#[callback_result]` that could panic on a
  surprise shape). OutLayer returns the guest's JSON as is when the run succeeds, and `null` for any failure.
- The contract acts on a verdict only if: it parses, `v == 1`, `ch` and `dh` equal the hashes it stored for that job,
  and the callback's `attempt` number equals the job's current ruling attempt. Then `pass:true` pays the provider and
  `pass:false` refunds the client. Null, garbage, a wrong version, a `ch`/`dh` mismatch, an oversized result or a
  failed call change no money and return the job to `Submitted`, so a ruling can be requested again. A stale or late
  callback (its attempt is not the current one, or the job has left `Ruling`, for example refunded after the grace
  period) changes nothing at all.

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

## 6. Sealed jobs (the deliverable stays encrypted until it passes)

A sealed job solves the "show me the work first" problem: the client never sees a failing delivery (only which of its own checks failed), and the
worker is paid for a passing one in the same step that hands the client the key.

### 6.1 Keys and ciphertext

- `K`: 32 random bytes chosen by the provider for this job. Never leaves the provider's machine in readable form.
- Deliverable ciphertext `C` = `nonce(12) | ChaCha20-Poly1305(K, nonce, plaintext) | tag(16)`, standard base64.
  Plaintext is the UTF-8 deliverable, at most 16,384 bytes, so `C` is at most 21,884 base64 characters.
- `dh` = lowercase hex SHA-256 of the plaintext bytes (the provider commits to it at submit).
- Client key `client_pk`: an X25519 public key, 64 lowercase hex characters, fixed when the job is created.

### 6.2 Getting K to the judge, and only to the judge

The provider stores `{"JN_KEY": "<64 hex of K>"}` as an OutLayer secret:

- accessor `{"WasmHash": {"hash": <judge sha256>}}`, owner = the provider, `vault_id: null`;
- profile = `jn-<first 16 hex of sha256(escrow account id)>-<job id>` (the escrow exposes it as a view, and is the
  only one that ever names it in `secrets_ref`, so a client cannot point a job at another job's key);
- access `{"Logic": {"operator": "And", "conditions": [{"WasmHash": {"hash": <judge sha256>}},
  {"Predecessor": {"condition": {"Whitelist": {"accounts": [<escrow account>]}}}}]}}`;
- encrypted locally to the key the coordinator returns for `POST /secrets/pubkey` with
  `{"accessor": {"type": "WasmHash", "hash": ...}, "owner": <provider>, "profile": ..., "secrets_json": "{}"}`
  (ECIES v1: X25519, HKDF-SHA256 with info `outlayer-keystore-v1`, ChaCha20-Poly1305, wire
  `0x01 | ephemeral public key(32) | nonce(12) | ciphertext | tag(16)`). The plaintext secret is never sent anywhere.

So only this exact judge build, running because the escrow asked, can read `K`. A provider who stores a weaker
rule only exposes their own work. Verified on testnet on Nov 1 2026 with `tools/keystore-probe` (see README).

### 6.3 Judge input and behavior

Sealed stdin: `{"criteria": "...", "deliverable_ct": "<base64 C>", "dh": "<64 hex>", "client_pk": "<64 hex>"}`
(the presence of `deliverable_ct` selects sealed mode; `deliverable` must then be absent). The judge reads `JN_KEY`
from its environment.

The first matching row wins:

| Situation | Verdict |
|---|---|
| `criteria` or `deliverable_ct` not a string, `deliverable` also present, or `dh` / `client_pk` not exactly 64 lowercase hex | `err:"invalid_input"` |
| `criteria` over 4,096 bytes or `C` over 21,884 characters (checked before the key is read) | `err:"too_large"` |
| `JN_KEY` absent or not exactly 64 hex digits (either case, no trimming) | `err:"key_missing"` |
| `C` not canonical base64, shorter than nonce + tag, failing the tag check, sha256(plaintext) != input `dh`, or plaintext not UTF-8 | `err:"bad_delivery"` |
| decrypts and matches | the normal verdict over the plaintext (`dh` = sha256(plaintext)); on `pass:true` it adds `k` |

Every error row gives `pass:false`, `score:0`, `checks:[]`, `ch` = sha256(criteria) (of the empty string when
`criteria` is not a string) and `dh` = the input `dh` (sha256 of the empty string when the input `dh` is malformed).
The longest legal verdict, a sealed pass with 16 checks, is 897 bytes including `k`, inside the 900-byte limit.

`k` = `K` sealed to `client_pk`, deterministic so the verdict stays reproducible. In the HKDF info strings below,
`client_pk` is its 32 raw bytes and `ch`, `dh` are their 64-character lowercase hex text; `eph_sk` is used as an
X25519 secret scalar (RFC 7748 clamping applies):
`eph_sk` = HKDF-SHA256(ikm `K`, no salt, info `judge-near-k-eph-v1` + `client_pk` bytes + `ch` + `dh`, 32 bytes);
`shared` = X25519(`eph_sk`, `client_pk`); `sym` = HKDF-SHA256(ikm `shared`, no salt, info `judge-near-k-v1`, 32 bytes);
`nonce` = first 12 bytes of HKDF-SHA256(ikm `K`, no salt, info `judge-near-k-nonce-v1` + `client_pk` bytes + `ch` + `dh`);
`k` = base64(`0x01 | X25519(eph_sk, basepoint) | nonce | ChaCha20-Poly1305(sym, nonce, K) | tag`), 124 characters.
The client recomputes `shared` with its secret key, recovers `K`, then decrypts `C`.

Key order with the optional fields: `v, pass, score, th, ch, dh, checks, err?, k?, eh`; `eh` covers everything
before it, as in section 3.

### 6.4 How the contract treats sealed verdicts

- `create_job(..., client_pk)` marks the job sealed; `submit_sealed(job_id, deliverable_ct, dh)` stores `C` and `dh`.
  `create_job` refuses a `client_pk` that is a known small-order X25519 point: with such a key the shared secret is
  all zeros, so anyone could open `k`.
- `request_ruling` sends the sealed stdin above and `secrets_ref = {"profile": <6.2 profile>, "account_id": provider}`.
- A pass is applied only if `k` is present and well formed (124 characters of standard base64 that decode to 93 bytes
  starting with `0x01`); the contract stores `k` on the job and in the `ruling_applied` event in the same callback that
  pays the provider. A pass without a well formed `k` moves no money and returns the job to Submitted (event
  `ruling_rejected`, reason `invalid_k`).
- The storage deposit for `submit_sealed` also covers the 128 bytes `k` takes when a pass stores it (a 4-byte length
  plus 124 characters), because the paying callback cannot take a deposit. The rest of the deposit is refunded.
- On a sealed job, `err:"key_missing"` moves no money and returns the job to Submitted (event `ruling_rejected`,
  reason `key_missing`; the provider can store the key and the job can be ruled again; if nobody fixes it, the client
  is refunded after expiry plus grace). Every other verdict that
  passes the `ch`/`dh`/attempt checks is applied as written (`pass:false`, including `bad_delivery`, refunds the client).
- Per-check results are public on chain even for sealed jobs. The deliverable and `K` are not.

### 6.5 OutLayer detail that matters here

With `response_format: "Json"` OutLayer re-serializes the judge's stdout, so the callback sees the same fields with
keys sorted alphabetically. Parse by field name; `eh` is still defined over the canonical order of section 3, which a
verifier rebuilds from the fields.

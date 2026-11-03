# Judge on NEAR, escrow contract, build notes

Design and build notes for the escrow contract, kept in sync with src/lib.rs.

## What this is

A NEAR escrow (Rust, near-sdk 5.30) whose payout follows a deterministic verdict produced by a WASM
judge run inside OutLayer (TEE-attested WASI execution). The contract never scores anything itself:
it stores the job, forwards criteria + deliverable to OutLayer, and acts on the verdict in a callback.

Source of truth: `../docs/interface.md` (sections 4 and 5 are binding). OutLayer facts were verified
against a local clone of github.com/out-layer/outlayer (the commit docs/interface.md section 5 names,
read Nov 1 2026).

## Verified OutLayer interface (from the clone, contract/src/lib.rs + execution.rs)

`request_execution` is `#[payable]` with exactly this arg order (serialized as a JSON object by NEAR
cross-contract convention, keys = param names):

    source: ExecutionSource,
    resource_limits: Option<ResourceLimits>,
    input_data: Option<String>,
    secrets_ref: Option<SecretsReference>,
    response_format: Option<ResponseFormat>,
    payer_account_id: Option<AccountId>,
    params: Option<RequestParams>,

- ExecutionSource::WasmUrl { url, hash, build_target: Option<String> } -> `{"WasmUrl":{...}}`
- ResourceLimits { max_instructions: Option<u64>, max_memory_mb: Option<u32>, max_execution_seconds: Option<u64> }
- ResponseFormat::Json -> the JSON string `"Json"`
- payer_account_id: no restriction in OutLayer (`unwrap_or(predecessor)`), unused deposit refunded to it.

Gas facts (lib.rs): `MIN_RESPONSE_GAS = 50 TGas`, `INPUT_DATA_FREE_BYTES = 32 KiB`; our input is under
32 KiB, so OutLayer reserves exactly 50 TGas for its own settlement callback from the gas we attach.

Result contract: OutLayer returns the guest's JSON bytes unchanged on success and the 4 bytes `null`
on any failure/timeout. We read the RAW result, never a typed `#[callback_result]`.

## State machine

Open -> Funded -> Submitted -> Ruling -> Completed (provider paid) | Refunded (client refunded)

- Ruling falls back to Submitted when a verdict is rejected (null, garbage, wrong version, hash
  mismatch, oversized, or the request_execution call itself failed), so a ruling can be retried.
- A stale or late callback (attempt mismatch, or the job is no longer Ruling) changes NOTHING; it does
  not return the job to Submitted (that would corrupt a job already refunded after the grace period).
- claim_refund: Funded (nothing delivered) refundable at `expires_at_ns`. Submitted or Ruling
  (delivered on time) refundable only at `expires_at_ns + GRACE_NS` (GRACE_NS = 1 hour).

## Methods

- `new(outlayer, judge_url, judge_hash, build_target, min_ruling_deposit: U128)` #[init]: judge_url
  must start with `https://`, judge_hash must be 64 lowercase hex (OutLayer's own WasmUrl rule),
  build_target non-empty, min_ruling_deposit > 0. All five are stored permanently: no owner, no admin,
  no setter.
- `create_job(provider, criteria, expires_at_ns, client_pk: Option<String>) -> u64` #[payable]:
  client = predecessor, criteria <= 4096 bytes, provider != client, expires in the future. client_pk
  present = sealed job: 64 lowercase hex and not a small-order X25519 point. Omitting client_pk in
  the JSON args gives a public job (verified in the sandbox). Stores criteria + ch. Storage deposit:
  measured bytes x storage_byte_cost, excess refunded to the client.
- `fund(job_id)` #[payable]: client only, Open -> Funded; the attached deposit is the escrow amount.
- `submit(job_id, deliverable)` #[payable]: public jobs only; provider only, Funded -> Submitted,
  strictly before expiry, deliverable <= 16384 bytes. Stores deliverable + dh. Storage deposit like
  create_job, excess refunded to the provider.
- `submit_sealed(job_id, deliverable_ct, dh)` #[payable]: sealed jobs only; same provider, Funded and
  expiry checks; deliverable_ct <= 21,884 bytes, dh 64 lowercase hex. Storage deposit covers the
  write plus the 128 bytes k will take later; the rest is refunded.
- `request_ruling(job_id)` #[payable]: only the job's client or provider; prepaid gas >= 170 TGas;
  attached deposit >= min_ruling_deposit; Submitted -> Ruling, attempt += 1. No expiry gate. Calls
  OutLayer with source WasmUrl{url, hash, Some(build_target)}, resource_limits {50_000_000_000
  instructions, 64 MB, 30 s}, input_data as a String (public: `{"criteria","deliverable"}`; sealed:
  `{"criteria","deliverable_ct","dh","client_pk"}`), secrets_ref (public: null; sealed:
  `{"profile": <6.2 profile>, "account_id": provider}`), response_format Json, payer_account_id =
  caller, params None, forwarding the whole deposit; then `.then(on_ruling(job_id, attempt))`.
- `on_ruling(job_id, attempt)` #[private]: reads `promise_result_checked(0, 1024)`. Acts only on the
  live ruling (state Ruling and attempt matches), otherwise leaves the job alone. Failed / too long /
  any other promise error -> Submitted, no money. Bytes: parse by field name; act only if v == 1 and
  ch/dh equal the stored hashes, then apply_verdict: a sealed key_missing -> Submitted, no money;
  pass:false -> Refunded + refund client; a sealed pass without a well formed k -> Submitted, no
  money; otherwise pass -> Completed (+ k stored for a sealed job) + pay provider. Anything else ->
  Submitted, no money. Never panics; state (and k) is set before every transfer.
- `claim_refund(job_id)`: anyone; money always to the client; rules above.
- Views: `get_job` (adds sealed, client_pk, deliverable_ct, k), `get_judge` (outlayer, url, hash,
  build_target, min_ruling_deposit), `get_secrets_profile(job_id)` (the sealed profile, else null),
  `list_jobs` (default page 10).

## Sealed mode (Nov 2; spec: docs/interface.md section 6)

As built (the plan was written before code and reviewed; the one change is that key_missing is now
gated to sealed jobs):
- Job gains client_pk: Option<String> (Some = sealed), deliverable_ct: String, k: Option<String>.
  JobView adds sealed (bool), client_pk, deliverable_ct, k. job_created event adds "sealed".
- create_job(provider, criteria, expires_at_ns, client_pk: Option<String>): client_pk must be 64
  lowercase hex and not a small-order X25519 point (libsodium's 7-entry blocklist, first 31 bytes
  exact plus the last byte masked with 0x7f). The blocklist bytes are proven by a dev-only
  x25519-dalek test (X25519(scalar, entry) == zeros for each entry); nothing new ships in the wasm.
- submit refuses sealed jobs. submit_sealed(job_id, deliverable_ct, dh): provider only, sealed only,
  Funded, strictly before expiry, ct <= 21,884 bytes, dh 64 lowercase hex, storage deposit with
  excess refunded.
- request_ruling on a sealed job: input_data {criteria, deliverable_ct, dh, client_pk} (exact stored
  strings, no deliverable key) and secrets_ref {profile, account_id: provider}, matching OutLayer's
  SecretsReference { profile: String, account_id: AccountId }. Profile
  "jn-" + first 16 hex of sha256(escrow account id) + "-" + job id is at most 40 bytes of letters,
  digits and '-', inside OutLayer's rule (1 to 64 bytes of alphanumerics, '-' or '_'). OutLayer does
  not check that the profile exists at request time; a missing key reaches the judge as key_missing.
- on_ruling, after the existing v/ch/dh/attempt checks: err "key_missing" -> no money, back to
  Submitted, reason "key_missing" (checked before pass, because that verdict has pass:false and must
  not refund). Sealed pass: applied only with a well formed k (124 chars of standard base64 decoding
  to 93 bytes starting with 0x01, decoded with near-sdk's re-exported base64); k is stored and put in
  ruling_applied in the same callback that pays the provider; without a valid k -> no money, back to
  Submitted, reason "invalid_k". Everything else is applied as written. Public jobs ignore k.
- Design choice: storing k in on_ruling grows the job by 128 bytes (u32 length
  prefix + 124) with no attached deposit. If the contract had no spare balance, the callback would
  fail on storage staking and a passing provider would go unpaid. submit_sealed therefore charges
  the provider for those 128 bytes up front (about 0.0013 NEAR) and keeps them as stake.
- key_missing is a sealed-job rule only, as spec 6.4 frames it (changed after review from an earlier
  "any job" plan). The public judge never emits it; if a public verdict carried it anyway, it is an
  ordinary pass:false verdict and refunds the client. A test pins this.
- A sealed pass without a well formed k is rejected with event reason "invalid_k" (the spec calls it
  an invalid verdict; the distinct reason makes the cause visible on chain).
- View get_secrets_profile(job_id) -> Option<String>: the profile for a sealed job, None otherwise.
- submit and submit_sealed share two helpers (require_can_submit, record_submission), and the
  verdict logic lives in apply_verdict, so each money-path check exists in exactly one place.
- Tests use the judge's real vectors (judge-wasm/vectors/sealed.json) via include_str!, so contract
  and judge are checked against the same bytes; verdicts are re-serialized with sorted keys the way
  OutLayer delivers them (6.5). Vector 9 is the 897-byte longest legal verdict, vectors 5 and 40 give
  the 21,884 / 21,885 ciphertext boundary.
- Not a concern, checked: the sealed input stays under OutLayer's 32 KiB free input size (criteria at
  most 4096 bytes, about 8 KiB after JSON escaping of valid JSON, plus a 21,884-character
  base64 ciphertext). Only criteria that are not valid JSON could push it past 32 KiB, and the judge
  would answer invalid_criteria for those anyway.

## Security review changes (Nov 1)

Finding: anyone could call request_ruling with a 1-yocto deposit. OutLayer then fails, the job flips
Ruling -> Submitted, and a griefer (typically the client) could time this so no real ruling happens
before expiry, then refund the Submitted job at expires_at. The provider who delivered in time loses
without a ruling. Three layered fixes, each with its own tests and planted bugs:

1. Ruling window for submitted work: a Submitted job is refundable only at expires_at + GRACE_NS
   (same as Ruling). Funded still refunds at expires_at. Delivered work always gets an hour after
   expiry in which a party can obtain a real ruling.
2. Minimum ruling deposit: an immutable init parameter `min_ruling_deposit` (yoctoNEAR, > 0),
   returned by get_judge. request_ruling rejects a smaller deposit. With an adequate deposit OutLayer
   really runs the judge and a real verdict ends the job, so cheap failing requests stop being a
   stalling tool. Docs and tests use 0.01 NEAR (10000000000000000000000). For reference, on Nov 1
   outlayer.testnet estimate_execution_cost was 0.004001 NEAR for 10B instructions / 64 MB / 30 s
   (measured that day); OutLayer refunds unused deposit to the payer.
3. Only the job's client or provider may call request_ruling. Reasoning: each party has an incentive
   to ask (the provider to get paid, the client to get a refund on a failing delivery), so restricting
   the caller loses nothing; it removes third-party spam; and the expiry-plus-grace refund means money
   can never lock if neither party asks.

Residual risk: min_ruling_deposit is fixed at init. If OutLayer raised its prices above it, a request
at exactly the floor could fail again. That still cannot steal the provider's payment: the grace
window stays open, each failing request costs its sender the deposit, and a party can always attach
more than the floor. Pick the floor with headroom at deploy time.

## Resource limits

The contract sends max_instructions 50,000,000,000, max_memory_mb 64, max_execution_seconds 30 (bound
by docs/interface.md section 4).

Why so generous: the measured worst valid input is about 0.59B instructions, 1.75 MB and 21 ms
(judge-wasm/RESOURCE-LIMITS.md, measured under OutLayer's exact metering), but a measured corpus is
not a proof that no valid criteria cost more, and a ruling that runs out of fuel stalls the job
(OutLayer returns null on every attempt). The margin also covers the 17.4B instructions the judge
needed on an adversarial input before judge-wasm made whole-word matching linear.

Why it is nearly free: on testnet pricing the deposit estimate for 50B / 30 s is about 0.004 NEAR
(base 0.001 + about 0.000005 for instructions + about 0.003 for time), under the 0.01 NEAR
min_ruling_deposit, and OutLayer charges actual usage and refunds the rest to payer_account_id.

judge-wasm's measured recommendation was 3B / 16 MB / 5 s; the wider margin is on purpose. Each limit is a single constant in lib.rs, and the test that asserts the outgoing JSON pins
the literal values.

## Deploy notes (deployed Nov 2 2026 with tools/deploy-escrow.mjs; see the README)

Init arguments for `new`, testnet:

- outlayer: `outlayer.testnet` (mainnet: `outlayer.near`)
- judge_url: the https URL where the judge wasm is hosted. Sealed-capable judge pinned at commit
  fd3dcc6: `https://raw.githubusercontent.com/vijaygopalbalasa/judge-near/fd3dcc65a9f616a6c7e9dc411a65de50560e2ed6/judge-wasm/release/judge.wasm`
- judge_hash: the sha256 in `judge-wasm/release/judge.wasm.sha256` at the commit the judge_url points to.
  Public-only judge v1: `da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1` (161736 bytes,
  commit e09c6f9). Sealed-capable judge: `911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958`
  (182133 bytes, commit fd3dcc6).
- build_target: `wasm32-wasip1`
- min_ruling_deposit: `10000000000000000000000` (0.01 NEAR)

All five are permanent once initialised.

## Gas budget (grounded in MIN_RESPONSE_GAS = 50 TGas)

- GAS_OUTLAYER_REQUEST = 100 TGas static on the request_execution call, plus
  with_unused_gas_weight(1) so OutLayer also receives all gas the caller left unused (OutLayer's own
  proxy guidance).
- GAS_ON_RULING = 40 TGas static for on_ruling, weight 0.
- MIN_PREPAID_GAS = 170 TGas required on request_ruling (the two static reserves plus the body).

An earlier draft set the OutLayer static gas to `prepaid - callback - buffer`; the near-sdk unit VM
rejected that with GasExceeded (the function's own burnt gas plus two large static reserves exceeded
prepaid). A fixed floor plus weight(1) is both correct on chain and testable. Final tuning needs
testnet; we do not deploy here.

## Money safety

- All amounts are NearToken / yoctoNEAR, no floats, overflow-checks = true in release, saturating
  time math (expires_at + GRACE cannot overflow-panic).
- State is updated before any transfer promise. Acting requires state Ruling and a matching attempt,
  and acting clears Ruling, so there is no double payout and stale or replayed callbacks move nothing.
- ch/dh compared to the stored values before acting.
- Only the client funds, only the provider submits, only the client or provider requests a ruling,
  provider != client.

## Deposits (never mixed with escrow accounting)

- create_job and submit deposits: storage only, excess refunded to the writer.
- fund deposit: the escrow amount (job.amount), only ever paid to the provider or refunded to the client.
- request_ruling deposit: the OutLayer payment, forwarded whole; OutLayer refunds the unused part to
  the caller. If the request_execution promise fails, the callback refunds nothing (a contract-level
  failure returns the deposit to this contract, a post-yield failure does not, and the callback cannot
  tell them apart, so refunding could pay out of other jobs' escrow). Such a deposit stays here.
Job payout logic only ever moves job.amount.

## Events (NEP-297, standard "judge_near", version "1.0.0")

job_created (with sealed), job_funded, deliverable_submitted, ruling_requested, ruling_applied (pass,
score, eh, k: the sealed key on a sealed pass, null otherwise), ruling_rejected (reason, including
key_missing and invalid_k), refunded, completed.

## Design decisions

1. create_job and submit are #[payable]: honest storage handling needs an attached deposit, and a
   non-payable method rejects deposits.
2. provider != client is enforced.
3. ft_on_transfer (NEP-141) deferred; v1 is NEAR-only.
4. new() takes a fifth parameter, min_ruling_deposit, and request_ruling is restricted to the parties
   (both from the security review, Nov 1).
5. on_ruling reads promise_result_checked (promise_result is deprecated in near-sdk 5.30); a result
   over 1 KiB is a clean rejection.
6. Sealed mode: submit_sealed charges the provider for the 128 bytes k will take
   when a pass stores it (the callback cannot take a deposit; without the reserve a contract with no
   spare balance would fail the callback on storage staking and leave a passing provider unpaid).
   A test pins the constant to the measured growth.

## Versions and toolchain

near-sdk 5.30.0, edition 2024, resolver 3, rust-version 1.95, cargo-near 0.22.0. near-workspaces 0.24
(feature "unstable" for compile_project) + tokio + anyhow for integration tests. hex 0.4.

near-sdk 5.30 needs rustc 1.95; the installed stable was 1.94.1 and near-workspaces 0.24 only resolves
against the 5.30 era, so the default stable channel was updated to 1.99.1 (`rustup update stable`, a
global change; reverse with `rustup toolchain install 1.94.1 && rustup default 1.94.1`).
wasm32-unknown-unknown was added. near-sdk 5.30 refuses a bare host `cargo check`; use
`cargo check --target wasm32-unknown-unknown`.

## Red-first log (security round, Nov 1)

Each change: tests written first, run, confirmed failing for the right reason, then implemented.
1. Grace for Submitted: RED `claim_refund_submitted_rejects_at_expiry` and
   `claim_refund_submitted_rejects_before_grace` ("did not panic"); GREEN after the claim_refund change.
2. Party-only rulings: RED `request_ruling_rejects_third_party` ("did not panic"); GREEN after the check.
3. Ruling floor: RED at compile (5-arg new, U128, JudgeView field missing); then plumbing only, RED
   `new_rejects_zero_min_ruling_deposit` and `request_ruling_rejects_deposit_below_min`; GREEN after
   the validation and the floor check.
4. Limits: RED `request_ruling_sends_correct_outlayer_call` (sent 1B, then 3B, expected the bound
   value); GREEN after the constants.

Note on the first build round: there the implementation came first and the tests after, with
mutation testing as the proof that the tests bite. This round was red-first throughout.

## Red-first log (sealed round, Nov 2)

Each step: tests first, a compile-level RED, then plumbing only so the rule tests fail for the right
reason (behavioral RED), then the rules (GREEN).
1. Blocklist oracle: RED at compile (no SMALL_ORDER_POINTS / is_small_order); GREEN on the first try,
   which checks the 7 entries of libsodium's small-order list (X25519 of each, and of its high-bit
   variant, is all zeros; a normal key is not flagged and gives a non-zero secret).
2. create_job + submit_sealed: RED at compile (arity, submit_sealed, view fields); plumbing only, then
   13 rule tests RED (4 client_pk validations, the k reserve, plain submit on a sealed job, 7
   submit_sealed guards); GREEN after the checks and the reserve.
3. request_ruling: profile view and helper first, then 3 outgoing-call tests RED (public input and
   null secrets_ref still sent); GREEN after the sealed input and secrets_ref.
4. on_ruling: RED at compile (is_valid_k, err/k fields); parsing plumbing only, then 5 money-path
   tests RED (key_missing refunded, a pass without a valid k paid, k not stored or emitted); GREEN
   after apply_verdict.

## Open issues

- A payout to a deleted or nonexistent provider/client account bounces back to the escrow while the
  job is already Completed/Refunded, so those funds stay in the contract. Standard NEAR limitation.
- expires_at_ns is not upper-bounded; an absurd expiry only locks the client's own escrow.
- min_ruling_deposit is immutable (see residual risk above).
- A deposit from a failed request_execution call stays in the contract (see Deposits).
- ft_on_transfer not implemented.
Accepted for v1 (Nov 1).

Sealed mode doubts (Nov 2):
- The real OutLayer path for sealed jobs (secrets fetched by the worker, key_missing when the
  profile is empty) is exercised only with the mock here; the request shape is asserted exactly.
- The contract does not check that deliverable_ct is base64 or long enough to hold a nonce and tag;
  the judge answers bad_delivery for those, which refunds the client (the provider's own mistake).
- The sealed tests compile in the judge's vectors from judge-wasm/, a deliberate coupling: if the
  judge's verdict format changes, the contract tests re-check it.
- Callback gas, checked: the heaviest sealed callback (vector 5, a 21,884-character ciphertext,
  a pass that stores k, job read from storage and written back) uses about 2 TGas of host-metered
  gas out of the 40 TGas GAS_ON_RULING reserve. The unit VM does not meter wasm instructions, so
  this is a lower bound, but the headroom is wide.

## Final state (Nov 2 2026, sealed mode)

- Unit tests: 112 pass (71 from v1 + 41 sealed). Sandbox integration tests: 13 pass (7 + 6 sealed).
  0 ignored, no warnings.
- Mutation testing: 79 planted, 79 caught (MUTATION-LOG.md), including 28 on the sealed paths.
- Escrow wasm (path-safe build, see BUILD.md): 195834 bytes, sha256
  b13cef3dd19730818f1db4ac85c135bfccf671eaca92315d853ed5f4f3b9f223, base58
  Cvs46Mpm96grgs3GdU4Cpyx3PTRiJZifHDXrWRm2qpga, no local paths, byte-identical on a forced rebuild.
- Mock wasm (tests only): 128780 bytes, sha256
  ca35736327808bb005c29368d4886c5a0ccd935926527ebf28dc9931db93e649.
- Public-only v1 (committed as 9c432bf): 179461 bytes, sha256 a0130b87...
- Deployed on testnet as `judgenear-escrow.testnet` on Nov 2 2026 (README, "The escrow on testnet"),
  where NEAR reports the code hash above.

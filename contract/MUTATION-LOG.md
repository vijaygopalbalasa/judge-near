# Mutation log

Each bug below was planted one at a time into `src/lib.rs` with the suite green beforehand, the suite
was run, the bug was confirmed caught by at least one FAILING test, and the file was restored.

**Result: 51 planted, 51 caught (100%).** M01 to M51 except M39 were run by a harness against the unit
suite (`cargo test --lib`): it applies one exact edit, runs the suite, records the failing tests, and
restores the file. M39 (`#[private]`) cannot be observed by a unit test and was planted by hand
against the integration suite. Line numbers refer to the final `contract/src/lib.rs`.

## Security round (Nov 1 to 2)

The three planted bugs requested by the team lead, one per anti-griefing fix:

- **M40**: a Submitted job refundable at plain `expires_at` (the original griefing bug). Caught by
  `claim_refund_submitted_rejects_at_expiry` and `claim_refund_submitted_rejects_before_grace`.
- **M21**: the minimum ruling deposit check removed. Caught by `request_ruling_rejects_deposit_below_min`
  and `request_ruling_rejects_zero_deposit`. M41 (the boundary turned from `>=` to `>`) is caught by
  `request_ruling_accepts_deposit_at_min`.
- **M42**: a third party allowed to request a ruling. Caught by `request_ruling_rejects_third_party`.
  M43 and M44 (provider or client wrongly excluded) are caught too.

Also from that round: M45 to M50 cover init validation, the stored floor and the view; M46 and M51 pin
the resource limits. M21 and M35 to M37 were re-anchored because the code they target changed (the old
`deposit > 0` guard became the floor check; the claim_refund arms were split).

An earlier round found and fixed one weak test: the oversized-verdict test sized its payload from
`MAX_VERDICT_BYTES`, so raising that constant (M33) also inflated the payload and the mutation
survived. The test now uses a fixed 5000-byte payload, and M33 is caught.

| # | File:line | Planted bug | Caught by (failing tests) |
|---|---|---|---|
| M01 | lib.rs:268 | create_job: provider!=client guard inverted | create_job_allows_max_criteria, create_job_happy (+57 more) |
| M02 | lib.rs:270 | create_job: criteria size off-by-one (<= -> <) | create_job_allows_max_criteria |
| M03 | lib.rs:275 | create_job: expiry future off-by-one (> -> >=) | create_job_rejects_past_expiry |
| M04 | lib.rs:595 | charge_storage: deposit floor removed (>=cost -> >=0) | create_job_rejects_insufficient_storage_deposit |
| M05 | lib.rs:599 | charge_storage: refund never sent | create_job_refunds_storage_excess, submit_refunds_storage_excess_to_provider |
| M06 | lib.rs:309 | fund: client guard inverted | claim_refund_funded_after_expiry, claim_refund_funded_exactly_at_expiry (+45 more) |
| M07 | lib.rs:312 | fund: Open-state guard inverted | claim_refund_funded_after_expiry, claim_refund_funded_exactly_at_expiry (+43 more) |
| M08 | lib.rs:305 | fund: zero-deposit guard removed | fund_rejects_zero_deposit |
| M09 | lib.rs:314 | fund: does not set Funded state | claim_refund_funded_after_expiry, claim_refund_funded_exactly_at_expiry (+40 more) |
| M10 | lib.rs:313 | fund: does not store escrow amount | claim_refund_funded_after_expiry, claim_refund_money_goes_to_client_not_caller (+5 more) |
| M11 | lib.rs:333 | submit: provider guard inverted | claim_refund_submitted_after_grace, claim_refund_submitted_rejects_at_expiry (+38 more) |
| M12 | lib.rs:336 | submit: Funded-state guard inverted | claim_refund_submitted_after_grace, claim_refund_submitted_rejects_at_expiry (+37 more) |
| M13 | lib.rs:338 | submit: expiry off-by-one (< -> <=) | submit_rejects_at_exactly_expiry |
| M14 | lib.rs:324 | submit: deliverable size off-by-one (<= -> <) | submit_allows_max_deliverable |
| M15 | lib.rs:344 | submit: does not set Submitted state | claim_refund_submitted_rejects_at_expiry, claim_refund_submitted_rejects_before_grace (+26 more) |
| M16 | lib.rs:343 | submit: does not store deliverable hash | submit_happy |
| M17 | lib.rs:384 | request_ruling: Submitted-state guard inverted | request_ruling_accepts_deposit_at_min, request_ruling_allowed_for_client (+24 more) |
| M18 | lib.rs:385 | request_ruling: attempt not incremented | request_ruling_moves_to_ruling_and_bumps_attempt, request_ruling_schedules_private_callback (+13 more) |
| M19 | lib.rs:386 | request_ruling: does not set Ruling state | request_ruling_accepts_deposit_at_min, request_ruling_allowed_for_client (+11 more) |
| M20 | lib.rs:362 | request_ruling: minimum-gas guard removed | request_ruling_rejects_low_gas |
| M21 | lib.rs:370 | request_ruling: minimum ruling deposit guard removed | request_ruling_rejects_deposit_below_min, request_ruling_rejects_zero_deposit |
| M22 | lib.rs:424 | request_ruling: wrong payer_account_id (not caller) | request_ruling_allowed_for_client, request_ruling_sends_correct_outlayer_call |
| M23 | lib.rs:396 | request_ruling: input_data criteria set to deliverable | request_ruling_sends_correct_outlayer_call |
| M24 | lib.rs:403 | request_ruling: WasmUrl hash set to url | request_ruling_sends_correct_outlayer_call |
| M25 | lib.rs:404 | request_ruling: build_target dropped (None) | request_ruling_sends_correct_outlayer_call |
| M26 | lib.rs:479 | on_ruling: pass guard inverted | on_ruling_fail_refunds_client, on_ruling_no_double_pay (+1 more) |
| M27 | lib.rs:484 | on_ruling: pass pays client instead of provider | on_ruling_pass_pays_provider |
| M28 | lib.rs:615 | parse_verdict: version check inverted (!= -> ==) | on_ruling_fail_refunds_client, on_ruling_no_double_pay (+3 more) |
| M29 | lib.rs:618 | parse_verdict: criteria-hash check dropped | on_ruling_ch_mismatch_returns_to_submitted |
| M30 | lib.rs:618 | parse_verdict: deliverable-hash check dropped | on_ruling_dh_mismatch_returns_to_submitted |
| M31 | lib.rs:451 | on_ruling: attempt guard dropped | on_ruling_stale_attempt_is_ignored |
| M32 | lib.rs:451 | on_ruling: state guard dropped | on_ruling_no_double_pay, on_ruling_on_refunded_job_is_ignored |
| M33 | lib.rs:65 | on_ruling: verdict size cap raised (oversized accepted) | on_ruling_oversized_returns_to_submitted |
| M34 | lib.rs:463 | on_ruling: Failed branch pays out instead of back to Submitted | on_ruling_failed_promise_returns_to_submitted |
| M35 | lib.rs:518 | claim_refund: Funded expiry off-by-one (>= -> >) | claim_refund_funded_exactly_at_expiry |
| M36 | lib.rs:519 | claim_refund: grace period dropped for Submitted/Ruling | claim_refund_ruling_rejects_before_grace, claim_refund_submitted_rejects_at_expiry (+2 more) |
| M37 | lib.rs:519 | claim_refund: grace boundary off-by-one (>= -> >) | claim_refund_money_goes_to_client_not_caller, claim_refund_ruling_after_grace (+3 more) |
| M38 | lib.rs:520 | claim_refund: refundable default true (wrong states allowed) | claim_refund_rejects_completed, claim_refund_rejects_open |
| M40 | lib.rs:518 | claim_refund: Submitted refundable at plain expiry (the griefing bug) | claim_refund_submitted_rejects_at_expiry, claim_refund_submitted_rejects_before_grace |
| M41 | lib.rs:370 | request_ruling: minimum deposit boundary off-by-one (>= -> >) | request_ruling_accepts_deposit_at_min |
| M42 | lib.rs:381 | request_ruling: third party allowed (party check removed) | request_ruling_rejects_third_party |
| M43 | lib.rs:381 | request_ruling: provider excluded from requesting | request_ruling_accepts_deposit_at_min, request_ruling_allowed_for_provider (+23 more) |
| M44 | lib.rs:381 | request_ruling: client excluded from requesting | request_ruling_allowed_for_client |
| M45 | lib.rs:249 | new: zero min_ruling_deposit accepted | new_rejects_zero_min_ruling_deposit |
| M46 | lib.rs:57 | resource limits: instructions regress to OutLayer's 1B default | request_ruling_sends_correct_outlayer_call |
| M47 | lib.rs:542 | get_judge: reports a wrong min_ruling_deposit | get_judge_returns_min_ruling_deposit |
| M48 | lib.rs:240 | new: judge_url https check removed | new_rejects_non_https |
| M49 | lib.rs:244 | new: judge_hash hex check removed | new_rejects_short_hash, new_rejects_uppercase_hash |
| M50 | lib.rs:257 | new: stores a different ruling floor than the init value | get_judge_returns_min_ruling_deposit, request_ruling_rejects_deposit_below_min |
| M51 | lib.rs:58 | resource limits: memory drifts from the spec (64 -> 16 MB) | request_ruling_sends_correct_outlayer_call |
| M39 | lib.rs:438 | on_ruling: `#[private]` attribute removed | integration: on_ruling_is_private |

## Note on M39 (#[private])

A near-sdk unit test calls the method directly and bypasses the macro-generated wrapper that holds the
private check, so M39 can only be observed through the sandbox. With `#[private]` removed, an external
account's call to `on_ruling` is no longer rejected as private and fails later instead ("Accessed
invalid promise result index: 0"), so `on_ruling_is_private`, which asserts the error names the private
method, fails. Re-verified against the final code on Nov 2, then restored byte-identical.

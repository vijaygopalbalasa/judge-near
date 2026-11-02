# Mutation log

Each bug below was planted one at a time into `src/lib.rs` with the suite green beforehand, the suite
was run, the bug was confirmed caught by at least one FAILING test, and the file was restored.

**Result: 79 planted, 79 caught (100%).** Everything except M39 was run by a harness against the unit
suite (`cargo test --lib`, 111 tests at the time; a 112th, the callback gas check, was added after), in three foreground batches (M01 to M26, M27 to M52, M53 to
M79): it applies one exact edit, runs the suite, records the failing tests, and restores the file.
M39 (`#[private]`) cannot be observed by a unit test and was planted by hand against the sandbox
suite. Line numbers refer to the final `contract/src/lib.rs`.

## Sealed round (Nov 2): M52 to M79

28 planted bugs on the sealed paths (interface.md section 6): client_pk validation and the
small-order blocklist (including a corrupted blocklist entry, M55, which only the x25519-dalek oracle
test can catch), the plain/sealed submit refusals, the ciphertext size boundary, the dh format, the
k storage reserve and its size, the sealed input keys and values, the secrets_ref owner and profile,
key_missing (removed, and wrongly applied to public jobs), k validation, k storage and the event,
and the views. M16, M23 and M26 were re-anchored because the code they target was refactored (shared
submit helpers, separate public and sealed input builders, the pass branch moved into
apply_verdict).

Not planted, on purpose: removing either of the two length checks in `is_valid_k`. With the
standard engine (canonical, no whitespace) a 124-character string decodes to exactly 93 bytes and
93 bytes encode to exactly 124 characters, so each check implies the other. Removing one alone is an
equivalent mutant that no test can catch. Removing both is the same bug as M70.

## Security round (Nov 1 to 2)

The three planted bugs for the anti-griefing fixes, one per fix: **M40** (a Submitted
job refundable at plain expires_at), **M21** (the minimum ruling deposit check removed; M41 is its
boundary) and **M42** (a third party allowed to request a ruling; M43 and M44 wrongly exclude a party).
M45 to M51 cover init validation, the stored floor, the view and the resource limits.

An earlier round found and fixed one weak test: the oversized-verdict test sized its payload from
`MAX_VERDICT_BYTES`, so raising that constant (M33) also inflated the payload and the mutation
survived. The test now uses a fixed 5000-byte payload, and M33 is caught.

| # | File:line | Planted bug | Caught by (failing tests) |
|---|---|---|---|
| M01 | lib.rs:314 | create_job: provider!=client guard inverted | create_job_accepts_a_normal_key, create_job_allows_max_criteria (+91 more) |
| M02 | lib.rs:316 | create_job: criteria size off-by-one (<= -> <) | create_job_allows_max_criteria |
| M03 | lib.rs:321 | create_job: expiry future off-by-one (> -> >=) | create_job_rejects_past_expiry |
| M04 | lib.rs:819 | charge_storage: deposit floor removed (>=cost -> >=0) | create_job_rejects_insufficient_storage_deposit |
| M05 | lib.rs:823 | charge_storage: refund never sent | create_job_refunds_storage_excess, submit_refunds_storage_excess_to_provider (+1 more) |
| M06 | lib.rs:367 | fund: client guard inverted | claim_refund_funded_after_expiry, claim_refund_funded_exactly_at_expiry (+71 more) |
| M07 | lib.rs:370 | fund: Open-state guard inverted | claim_refund_funded_after_expiry, claim_refund_funded_exactly_at_expiry (+69 more) |
| M08 | lib.rs:363 | fund: zero-deposit guard removed | fund_rejects_zero_deposit |
| M09 | lib.rs:372 | fund: does not set Funded state | claim_refund_funded_after_expiry, claim_refund_funded_exactly_at_expiry (+62 more) |
| M10 | lib.rs:371 | fund: does not store escrow amount | claim_refund_funded_after_expiry, claim_refund_money_goes_to_client_not_caller (+12 more) |
| M11 | lib.rs:789 | submit: provider guard inverted | claim_refund_submitted_after_grace, claim_refund_submitted_rejects_at_expiry (+62 more) |
| M12 | lib.rs:792 | submit: Funded-state guard inverted | claim_refund_submitted_after_grace, claim_refund_submitted_rejects_at_expiry (+60 more) |
| M13 | lib.rs:794 | submit: expiry off-by-one (< -> <=) | submit_rejects_at_exactly_expiry, submit_sealed_rejects_at_expiry |
| M14 | lib.rs:382 | submit: deliverable size off-by-one (<= -> <) | submit_allows_max_deliverable |
| M15 | lib.rs:802 | submit: does not set Submitted state | claim_refund_submitted_rejects_at_expiry, claim_refund_submitted_rejects_before_grace (+42 more) |
| M16 | lib.rs:801 | submit/submit_sealed: does not store deliverable hash | sealed_key_missing_returns_to_submitted, sealed_pass_without_k_returns_to_submitted (+9 more) |
| M17 | lib.rs:459 | request_ruling: Submitted-state guard inverted | request_ruling_accepts_deposit_at_min, request_ruling_allowed_for_client (+38 more) |
| M18 | lib.rs:460 | request_ruling: attempt not incremented | request_ruling_moves_to_ruling_and_bumps_attempt, request_ruling_schedules_private_callback (+24 more) |
| M19 | lib.rs:461 | request_ruling: does not set Ruling state | request_ruling_accepts_deposit_at_min, request_ruling_allowed_for_client (+21 more) |
| M20 | lib.rs:438 | request_ruling: minimum-gas guard removed | request_ruling_rejects_low_gas |
| M21 | lib.rs:446 | request_ruling: minimum ruling deposit guard removed | request_ruling_rejects_deposit_below_min, request_ruling_rejects_zero_deposit |
| M22 | lib.rs:503 | request_ruling: wrong payer_account_id (not caller) | request_ruling_allowed_for_client, request_ruling_sealed_by_client_still_names_the_providers_secret (+1 more) |
| M23 | lib.rs:759 | request_ruling: public input_data criteria set to deliverable | request_ruling_sends_correct_outlayer_call |
| M24 | lib.rs:482 | request_ruling: WasmUrl hash set to url | request_ruling_sends_correct_outlayer_call |
| M25 | lib.rs:483 | request_ruling: build_target dropped (None) | request_ruling_sends_correct_outlayer_call |
| M26 | lib.rs:648 | on_ruling: pass guard inverted | on_ruling_fail_refunds_client, on_ruling_no_double_pay (+11 more) |
| M27 | lib.rs:679 | on_ruling: pass pays client instead of provider | on_ruling_pass_pays_provider, public_job_ignores_k (+2 more) |
| M28 | lib.rs:841 | parse_verdict: version check inverted (!= -> ==) | on_ruling_fail_refunds_client, on_ruling_no_double_pay (+13 more) |
| M29 | lib.rs:844 | parse_verdict: criteria-hash check dropped | on_ruling_ch_mismatch_returns_to_submitted |
| M30 | lib.rs:844 | parse_verdict: deliverable-hash check dropped | on_ruling_dh_mismatch_returns_to_submitted |
| M31 | lib.rs:530 | on_ruling: attempt guard dropped | on_ruling_stale_attempt_is_ignored |
| M32 | lib.rs:530 | on_ruling: state guard dropped | on_ruling_no_double_pay, on_ruling_on_refunded_job_is_ignored |
| M33 | lib.rs:79 | on_ruling: verdict size cap raised (oversized accepted) | on_ruling_oversized_returns_to_submitted |
| M34 | lib.rs:542 | on_ruling: Failed branch pays out instead of back to Submitted | on_ruling_failed_promise_returns_to_submitted |
| M35 | lib.rs:581 | claim_refund: Funded expiry off-by-one (>= -> >) | claim_refund_funded_exactly_at_expiry |
| M36 | lib.rs:582 | claim_refund: grace period dropped for Submitted/Ruling | claim_refund_ruling_rejects_before_grace, claim_refund_submitted_rejects_at_expiry (+2 more) |
| M37 | lib.rs:582 | claim_refund: grace boundary off-by-one (>= -> >) | claim_refund_money_goes_to_client_not_caller, claim_refund_ruling_after_grace (+3 more) |
| M38 | lib.rs:583 | claim_refund: refundable default true (wrong states allowed) | claim_refund_rejects_completed, claim_refund_rejects_open |
| M40 | lib.rs:581 | claim_refund: Submitted refundable at plain expiry (the griefing bug) | claim_refund_submitted_rejects_at_expiry, claim_refund_submitted_rejects_before_grace |
| M41 | lib.rs:446 | request_ruling: minimum deposit boundary off-by-one (>= -> >) | request_ruling_accepts_deposit_at_min |
| M42 | lib.rs:456 | request_ruling: third party allowed (party check removed) | request_ruling_rejects_third_party |
| M43 | lib.rs:456 | request_ruling: provider excluded from requesting | request_ruling_accepts_deposit_at_min, request_ruling_allowed_for_provider (+36 more) |
| M44 | lib.rs:456 | request_ruling: client excluded from requesting | request_ruling_allowed_for_client, request_ruling_sealed_by_client_still_names_the_providers_secret |
| M45 | lib.rs:288 | new: zero min_ruling_deposit accepted | new_rejects_zero_min_ruling_deposit |
| M46 | lib.rs:71 | resource limits: instructions regress to OutLayer's 1B default | request_ruling_sends_correct_outlayer_call |
| M47 | lib.rs:614 | get_judge: reports a wrong min_ruling_deposit | get_judge_returns_min_ruling_deposit |
| M48 | lib.rs:279 | new: judge_url https check removed | new_rejects_non_https |
| M49 | lib.rs:283 | new: judge_hash hex check removed | new_rejects_short_hash, new_rejects_uppercase_hash |
| M50 | lib.rs:296 | new: stores a different ruling floor than the init value | get_judge_returns_min_ruling_deposit, request_ruling_rejects_deposit_below_min |
| M51 | lib.rs:72 | resource limits: memory drifts from the spec (64 -> 16 MB) | request_ruling_sends_correct_outlayer_call |
| M52 | lib.rs:325 | create_job: client_pk lowercase-hex check dropped | create_job_rejects_uppercase_client_pk |
| M53 | lib.rs:329 | create_job: small-order client_pk accepted | create_job_rejects_small_order_client_pk, create_job_rejects_small_order_client_pk_with_high_bit |
| M54 | lib.rs:748 | is_small_order: last-byte 0x7f mask dropped | create_job_rejects_small_order_client_pk_with_high_bit, is_small_order_flags_every_entry_and_its_high_bit_variant |
| M55 | lib.rs:713 | blocklist: an order-8 entry corrupted (first byte e0 -> e1) | small_order_blocklist_matches_x25519_oracle |
| M56 | lib.rs:391 | submit: sealed job accepted by plain submit | submit_rejects_sealed_job |
| M57 | lib.rs:417 | submit_sealed: public job accepted | submit_sealed_rejects_public_job |
| M58 | lib.rs:408 | submit_sealed: ciphertext size off-by-one (<= -> <) | submit_sealed_allows_max_ct |
| M59 | lib.rs:411 | submit_sealed: dh format check dropped | submit_sealed_rejects_short_dh, submit_sealed_rejects_uppercase_dh |
| M60 | lib.rs:423 | submit_sealed: k storage reserve not charged | submit_sealed_charges_storage_plus_k_reserve |
| M61 | lib.rs:42 | k reserve constant too small (length prefix forgotten) | k_write_grows_storage_by_exactly_the_reserve |
| M62 | lib.rs:772 | sealed input: client_pk key misnamed | request_ruling_sealed_sends_sealed_input |
| M63 | lib.rs:770 | sealed input: deliverable_ct sent under the deliverable key | request_ruling_sealed_sends_sealed_input |
| M64 | lib.rs:475 | secrets_ref names the client instead of the provider | request_ruling_sealed_by_client_still_names_the_providers_secret, request_ruling_sealed_names_the_providers_secret |
| M65 | lib.rs:782 | secrets profile uses 15 hex instead of 16 | get_secrets_profile_for_sealed_job, secrets_profile_fits_outlayer_profile_rule (+1 more) |
| M66 | lib.rs:472 | sealed job sends the public input | request_ruling_sealed_sends_sealed_input |
| M67 | lib.rs:604 | get_secrets_profile answers for public jobs | get_secrets_profile_none_for_public_or_missing_job |
| M68 | lib.rs:643 | key_missing rule removed (refunds instead) | sealed_key_missing_returns_to_submitted |
| M69 | lib.rs:643 | key_missing rule applied to public jobs too | public_job_key_missing_is_applied_as_written |
| M70 | lib.rs:660 | sealed pass accepts any k without validation | sealed_pass_with_malformed_k_returns_to_submitted |
| M71 | lib.rs:882 | is_valid_k: version byte check dropped | is_valid_k_accepts_real_k_and_rejects_malformed, sealed_pass_with_malformed_k_returns_to_submitted |
| M72 | lib.rs:880 | is_valid_k: URL-safe alphabet instead of standard | is_valid_k_accepts_real_k_and_rejects_malformed, k_write_grows_storage_by_exactly_the_reserve (+2 more) |
| M73 | lib.rs:675 | sealed pass does not store k | sealed_pass_with_valid_k_pays_provider_and_stores_k, k_write_grows_storage_by_exactly_the_reserve |
| M74 | lib.rs:677 | sealed pass leaves k out of ruling_applied | sealed_pass_with_valid_k_pays_provider_and_stores_k |
| M75 | lib.rs:659 | sealed pass skips the k requirement | sealed_pass_without_k_returns_to_submitted, k_write_grows_storage_by_exactly_the_reserve (+2 more) |
| M76 | lib.rs:218 | get_job reports sealed jobs as public | create_job_sealed_marks_job_and_stores_client_pk |
| M77 | lib.rs:355 | job_created event drops the sealed flag | create_job_sealed_marks_job_and_stores_client_pk |
| M78 | lib.rs:771 | sealed input sends ch as dh | request_ruling_sealed_sends_sealed_input |
| M79 | lib.rs:474 | secrets_ref profile names the wrong job | request_ruling_sealed_names_the_providers_secret |
| M39 | lib.rs:517 | on_ruling: `#[private]` attribute removed | sandbox: on_ruling_is_private |

## Note on M39 (#[private])

A near-sdk unit test calls the method directly and bypasses the macro-generated wrapper that holds the
private check, so M39 can only be observed through the sandbox. With `#[private]` removed, an external
account's call to `on_ruling` is no longer rejected as private and fails later instead ("Accessed
invalid promise result index: 0"), so `on_ruling_is_private`, which asserts the error names the private
method, fails. Re-verified against the final sealed-mode code on Nov 2, then restored byte-identical.

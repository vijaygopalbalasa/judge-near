# Mutation log

Each bug was planted alone in judge-wasm/src, the whole suite run (`cargo test`),
then every file restored. CAUGHT means at least one test failed. The suite is
green before and after the run. Rows marked `sealed` target the sealed-job path
(docs/interface.md section 6.3).

| # | Planted bug | Location | Result | First failing test |
|---|-------------|----------|--------|--------------------|
| 1 | sha256 hex uppercased | src/lib.rs:66 | CAUGHT | tests::sha256_empty_is_the_known_vector |
| 2 | render swaps score and th order | src/lib.rs:184 | CAUGHT | invalid_criteria_err_shape_matches_the_interface_example |
| 3 | eh hashed without the closing brace | src/lib.rs:215 | CAUGHT | eh_is_recomputable_from_the_printed_verdict |
| 4 | check_id puts index before kind | src/lib.rs:156 | CAUGHT | structured_fields_match_the_oracle |
| 5 | err verdict uses th:0 instead of 100 | src/lib.rs:167 | CAUGHT | malformed_stdin_is_invalid_input_with_empty_hashes |
| 6 | criteria size cap off by one (4097) | src/lib.rs:50 | CAUGHT | too_large_takes_priority_over_criteria_parsing |
| 7 | deliverable size cap off by one | src/lib.rs:51 | CAUGHT | too_large_takes_priority_over_criteria_parsing |
| 8 | length chars counts code points not UTF-16 | src/lib.rs:259 | CAUGHT | tests::utf16_len_counts_code_units_like_js_string_length |
| 9 | is_js_space drops U+FEFF | src/lib.rs:254 | CAUGHT | tests::is_js_space_differs_from_rust_whitespace |
| 10 | is_js_space adds U+0085 (NEL) | src/lib.rs:253 | CAUGHT | tests::is_js_space_differs_from_rust_whitespace |
| 11 | word_count loses the in_word guard | src/lib.rs:276 | CAUGHT | structured_fields_match_the_oracle |
| 12 | js_typeof makes null -> null not object | src/lib.rs:406 | CAUGHT | structured_fields_match_the_oracle |
| 13 | is_type integer accepts fractional | src/lib.rs:424 | CAUGHT | structured_fields_match_the_oracle |
| 14 | whole-word left boundary negation dropped | src/lib.rs:332 | CAUGHT | tests::indexed_whole_word_handles_overlapping_occurrences |
| 15 | whole-word right boundary negation dropped | src/lib.rs:333 | CAUGHT | tests::indexed_whole_word_equals_the_reference_on_a_large_random_sweep |
| 16 | KMP restarts at 0 after a match (misses overlaps) | src/lib.rs:374 | CAUGHT | tests::indexed_whole_word_handles_overlapping_occurrences |
| 17 | KMP failure function always 0 | src/lib.rs:360 | CAUGHT | tests::indexed_whole_word_handles_overlapping_occurrences |
| 18 | empty-term boundary search collapses to one position | src/lib.rs:348 | CAUGHT | tests::indexed_whole_word_equals_the_reference_on_a_large_random_sweep |
| 19 | MAX_CHECKS raised to 64 (ignores interface cap) | src/engine.rs:13 | CAUGHT | every_verdict_is_valid_json_within_900_bytes |
| 20 | http-endpoint added to known kinds | src/engine.rs:20 | CAUGHT | structured_fields_match_the_oracle |
| 21 | weight default 0 instead of 1 | src/engine.rs:94 | CAUGHT | extra_stdin_fields_are_tolerated |
| 22 | passThreshold default 0 instead of 100 | src/engine.rs:69 | CAUGHT | structured_fields_match_the_oracle |
| 23 | depth gate off by one (allows 13 levels) | src/engine.rs:14 | CAUGHT | structured_fields_match_the_oracle |
| 24 | score cap raised from 99 to 100 | src/engine.rs:455 | CAUGHT | structured_fields_match_the_oracle |
| 25 | threshold comparison uses > not >= | src/engine.rs:457 | CAUGHT | extra_stdin_fields_are_tolerated |
| 26 | checksum comparison inverted | src/engine.rs:348 | CAUGHT | structured_fields_match_the_oracle |
| 27 | contains ignores wholeWords (always substring) | src/engine.rs:389 | CAUGHT | a_term_keeps_separate_answers_for_plain_and_whole_word_matching |
| 28 | contains_term shares plain and whole memos on lookup | src/engine.rs:309 | CAUGHT | a_term_keeps_separate_answers_for_plain_and_whole_word_matching |
| 29 | Ctx.json caches the wrong text (parses null) | src/engine.rs:302 | CAUGHT | structured_fields_match_the_oracle |
| 30 | json-shape minLength uses UTF-16 not code points | src/shape.rs:239 | CAUGHT | structured_fields_match_the_oracle |
| 31 | enum number compare by representation (1 != 1.0) | src/shape.rs:408 | CAUGHT | structured_fields_match_the_oracle |
| 32 | domain_of stops stripping leading www. | src/shape.rs:528 | CAUGHT | tests::domain_of_lowercases_and_drops_one_leading_www |
| 33 | is_url port length cap off by one (allows 6 digits) | src/shape.rs:476 | CAUGHT | tests::url_rules_match_the_js_suite |
| 34 | sealed: k emitted on a failing verdict | src/sealed.rs:64 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 35 | sealed: k emitted with an err | src/sealed.rs:64 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 36 | sealed: sha256(plaintext) not checked against dh | src/sealed.rs:81 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 37 | sealed: decrypt failure ignored (raw ciphertext used) | src/sealed.rs:79 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 38 | sealed: plaintext UTF-8 not enforced (lossy) | src/sealed.rs:84 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 39 | sealed: key_missing reported as bad_delivery | src/sealed.rs:57 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 40 | sealed: bad_delivery reported as key_missing | src/sealed.rs:61 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 41 | sealed: JN_KEY whitespace trimmed | src/sealed.rs:55 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 42 | sealed: wrong HKDF info for eph_sk | src/sealed.rs:32 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 43 | sealed: wrong HKDF info for sym | src/sealed.rs:33 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 44 | sealed: nonce not bound to client_pk, ch, dh | src/sealed.rs:105 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 45 | sealed: HKDF for K uses a salt | src/sealed.rs:101 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 46 | sealed: AAD added when sealing K | src/sealed.rs:111 | CAUGHT | sealed::tests::small_order_client_pk_is_sealed_as_specified |
| 47 | sealed: k carries client_pk instead of eph_pk | src/sealed.rs:115 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 48 | sealed: k version byte 0x02 | src/sealed.rs:31 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 49 | sealed: client_pk uppercase accepted | src/sealed.rs:44 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 50 | sealed: deliverable and deliverable_ct both accepted | src/sealed.rs:49 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 51 | sealed: deliverable_ct size cap off by one | src/sealed.rs:28 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 52 | sealed: err verdicts report sha256("") as dh | src/sealed.rs:40 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 53 | sealed: mode chosen by a missing deliverable | src/lib.rs:88 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 54 | sealed: eh does not cover k | src/lib.rs:209 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 55 | sealed: key order changed (k right after dh) | src/lib.rs:209 | CAUGHT | sealed_vectors_match_the_reference_byte_for_byte |
| 56 | sealed: base64 trailing bits unchecked | src/b64.rs:44 | CAUGHT | b64::tests::non_canonical_or_malformed_input_is_refused |

Total: 56 mutations (23 on the sealed path), 56 caught, 0 escaped, 0 anchor misses.


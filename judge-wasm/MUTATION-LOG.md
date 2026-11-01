# Mutation log

Each bug was planted alone in judge-wasm/src, the suite run, then reverted.
CAUGHT = at least one test failed (or the change did not compile). The suite
is green before and after. Regenerate with scripts/jw_mutate (kept out of the repo).

| # | Planted bug | Location | Result | First failing test |
|---|-------------|----------|--------|--------------------|
| 1 | sha256 hex uppercased | src/lib.rs:60 | CAUGHT | tests::sha256_empty_is_the_known_vector |
| 2 | render swaps score and th order | src/lib.rs:162 | CAUGHT | invalid_criteria_err_shape_matches_the_interface_example |
| 3 | eh hashed without the closing brace | src/lib.rs:188 | CAUGHT | eh_is_recomputable_from_the_printed_verdict |
| 4 | check_id puts index before kind | src/lib.rs:135 | CAUGHT | structured_fields_match_the_oracle |
| 5 | err verdict uses th:0 instead of 100 | src/lib.rs:146 | CAUGHT | malformed_stdin_is_invalid_input_with_empty_hashes |
| 6 | criteria size cap off by one (<=4097) | src/lib.rs:44 | CAUGHT | too_large_takes_priority_over_criteria_parsing |
| 7 | deliverable size cap off by one | src/lib.rs:45 | CAUGHT | too_large_takes_priority_over_criteria_parsing |
| 8 | length chars counts code points not UTF-16 | src/lib.rs:227 | CAUGHT | tests::utf16_len_counts_code_units_like_js_string_length |
| 9 | is_js_space drops U+FEFF | src/lib.rs:222 | CAUGHT | tests::is_js_space_differs_from_rust_whitespace |
| 10 | is_js_space adds U+0085 (NEL) | src/lib.rs:221 | CAUGHT | tests::is_js_space_differs_from_rust_whitespace |
| 11 | word_count loses the in_word guard | src/lib.rs:244 | CAUGHT | structured_fields_match_the_oracle |
| 12 | js_typeof makes null -> null not object | src/lib.rs:373 | CAUGHT | structured_fields_match_the_oracle |
| 13 | is_type integer accepts fractional | src/lib.rs:392 | CAUGHT | structured_fields_match_the_oracle |
| 14 | whole-word left boundary negation dropped | src/lib.rs:300 | CAUGHT | tests::indexed_whole_word_handles_overlapping_occurrences |
| 15 | whole-word right boundary negation dropped | src/lib.rs:301 | CAUGHT | tests::whole_word_empty_term_matches_only_between_non_words |
| 16 | KMP restarts at 0 after a match (misses overlaps) | src/lib.rs:342 | CAUGHT | tests::indexed_whole_word_handles_overlapping_occurrences |
| 17 | KMP failure function always 0 | src/lib.rs:328 | CAUGHT | tests::indexed_whole_word_handles_overlapping_occurrences |
| 18 | empty-term boundary search collapses to a single position | src/lib.rs:316 | CAUGHT | tests::whole_word_empty_term_matches_only_between_non_words |
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
| 29 | Ctx.json caches the wrong text (parses "null") | src/engine.rs:302 | CAUGHT | structured_fields_match_the_oracle |
| 30 | json-shape minLength uses UTF-16 not code points | src/shape.rs:239 | CAUGHT | structured_fields_match_the_oracle |
| 31 | enum number compare by representation (1 != 1.0) | src/shape.rs:407 | CAUGHT | structured_fields_match_the_oracle |
| 32 | domain_of stops stripping leading www. | src/shape.rs:528 | CAUGHT | tests::domain_of_lowercases_and_drops_one_leading_www |
| 33 | is_url port length cap off by one (allows 6 digits) | src/shape.rs:476 | CAUGHT | tests::url_rules_match_the_js_suite |

Total: 33 mutations, 33 caught, 0 escaped, 0 anchor-miss.


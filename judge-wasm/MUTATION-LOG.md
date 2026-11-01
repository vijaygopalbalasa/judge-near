# Mutation log

Each bug was planted alone, the suite run, then reverted. A bug is
CAUGHT when at least one test failed (or the change failed to compile,
which also blocks a bad build). The suite is green before and after.

| # | Planted bug | Location | Result | First failing test |
|---|-------------|----------|--------|--------------------|
| 1 | sha256 hex uppercased | src/lib.rs:60 | CAUGHT | tests::sha256_empty_is_the_known_vector |
| 2 | render swaps score and th order | src/lib.rs:160 | CAUGHT | invalid_criteria_err_shape_matches_the_interface_example |
| 3 | eh hashed without the closing brace | src/lib.rs:186 | CAUGHT | eh_is_recomputable_from_the_printed_verdict |
| 4 | length chars counts code points not UTF-16 | src/lib.rs:225 | CAUGHT | tests::utf16_len_counts_code_units_like_js_string_length |
| 5 | is_js_space drops U+FEFF | src/lib.rs:220 | CAUGHT | tests::is_js_space_differs_from_rust_whitespace |
| 6 | is_js_space adds U+0085 (NEL) | src/lib.rs:219 | CAUGHT | tests::is_js_space_differs_from_rust_whitespace |
| 7 | word_count loses the in_word guard | src/lib.rs:242 | CAUGHT | structured_fields_match_the_oracle |
| 8 | has_whole_word drops the left boundary negation | src/lib.rs:284 | CAUGHT | tests::whole_word_empty_term_matches_only_between_non_words |
| 9 | check_id puts index before kind | src/lib.rs:133 | CAUGHT | structured_fields_match_the_oracle |
| 10 | err verdict uses th:0 instead of 100 | src/lib.rs:144 | CAUGHT | malformed_stdin_is_invalid_input_with_empty_hashes |
| 11 | criteria size cap off by one (<=4097) | src/lib.rs:44 | CAUGHT | too_large_takes_priority_over_criteria_parsing |
| 12 | deliverable size cap off by one | src/lib.rs:45 | CAUGHT | too_large_takes_priority_over_criteria_parsing |
| 13 | js_typeof makes null -> null not object | src/lib.rs:318 | CAUGHT | structured_fields_match_the_oracle |
| 14 | MAX_CHECKS raised to 64 (ignores interface cap) | src/engine.rs:14 | CAUGHT | every_verdict_is_valid_json_within_900_bytes |
| 15 | http-endpoint added to known kinds | src/engine.rs:21 | CAUGHT | structured_fields_match_the_oracle |
| 16 | weight default 0 instead of 1 | src/engine.rs:95 | CAUGHT | extra_stdin_fields_are_tolerated |
| 17 | passThreshold default 0 instead of 100 | src/engine.rs:70 | CAUGHT | structured_fields_match_the_oracle |
| 18 | depth gate off by one (allows 13 levels) | src/engine.rs:15 | CAUGHT | structured_fields_match_the_oracle |
| 19 | score cap raised from 99 to 100 | src/engine.rs:385 | CAUGHT | structured_fields_match_the_oracle |
| 20 | threshold comparison uses > not >= | src/engine.rs:387 | CAUGHT | extra_stdin_fields_are_tolerated |
| 21 | checksum comparison inverted | src/engine.rs:273 | CAUGHT | structured_fields_match_the_oracle |
| 22 | contains ignores wholeWords (always substring) | src/engine.rs:314 | CAUGHT | structured_fields_match_the_oracle |
| 23 | json-shape minLength uses UTF-16 not code points | src/shape.rs:239 | CAUGHT | structured_fields_match_the_oracle |
| 24 | is_type integer accepts fractional | src/lib.rs:337 | CAUGHT | structured_fields_match_the_oracle |
| 25 | enum number compare by representation (1 != 1.0) | src/shape.rs:407 | CAUGHT | structured_fields_match_the_oracle |
| 26 | domain_of stops stripping leading www. | src/shape.rs:528 | CAUGHT | tests::domain_of_lowercases_and_drops_one_leading_www |
| 27 | is_url port length cap off by one (allows 6 digits) | src/shape.rs:476 | CAUGHT | tests::url_rules_match_the_js_suite |

Total: 27 mutations, 27 caught, 0 escaped.


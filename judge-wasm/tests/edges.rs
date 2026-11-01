//! Hashing known-vectors and stdin edge cases (invalid_input, too_large, the err
//! verdict shape). These exercise the pipeline branches that parity.json, which
//! always supplies a well-formed stdin, does not reach.

use judge_wasm::run;
use serde_json::Value;

const SHA_EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn field<'a>(out: &'a Value, k: &str) -> &'a str {
    out[k].as_str().unwrap_or("")
}

fn parse(out: &str) -> Value {
    serde_json::from_str(out).expect("verdict is valid JSON")
}

#[test]
fn malformed_stdin_is_invalid_input_with_empty_hashes() {
    for bad in [
        &b""[..],
        b"not json",
        b"[1,2,3]",       // JSON, but not an object
        b"\"a string\"",  // JSON string, not an object
        b"42",
        b"{",             // truncated
        &[0xff, 0xfe][..], // invalid UTF-8
    ] {
        let out = parse(&run(bad));
        assert_eq!(out["err"].as_str(), Some("invalid_input"), "{bad:?}");
        assert_eq!(out["pass"].as_bool(), Some(false));
        assert_eq!(out["score"].as_i64(), Some(0));
        assert_eq!(out["th"].as_i64(), Some(100));
        assert!(out["checks"].as_array().unwrap().is_empty());
        assert_eq!(field(&out, "ch"), SHA_EMPTY, "{bad:?}");
        assert_eq!(field(&out, "dh"), SHA_EMPTY, "{bad:?}");
    }
}

#[test]
fn missing_or_nonstring_fields_are_invalid_input_hashing_what_can_be_read() {
    // criteria present (a string), deliverable missing -> ch over "abc", dh over "".
    let out = parse(&run(br#"{"criteria":"abc"}"#));
    assert_eq!(out["err"].as_str(), Some("invalid_input"));
    assert_eq!(field(&out, "ch"), SHA_ABC);
    assert_eq!(field(&out, "dh"), SHA_EMPTY);

    // deliverable present, criteria missing.
    let out = parse(&run(br#"{"deliverable":"abc"}"#));
    assert_eq!(out["err"].as_str(), Some("invalid_input"));
    assert_eq!(field(&out, "ch"), SHA_EMPTY);
    assert_eq!(field(&out, "dh"), SHA_ABC);

    // criteria present but not a string -> its hash is the empty hash.
    let out = parse(&run(br#"{"criteria":123,"deliverable":"abc"}"#));
    assert_eq!(out["err"].as_str(), Some("invalid_input"));
    assert_eq!(field(&out, "ch"), SHA_EMPTY);
    assert_eq!(field(&out, "dh"), SHA_ABC);
}

#[test]
fn extra_stdin_fields_are_tolerated() {
    // A well-formed object with an extra field still judges normally.
    let out = parse(&run(
        br#"{"criteria":"{\"checks\":[{\"kind\":\"length\"}]}","deliverable":"hi","extra":1}"#,
    ));
    assert_eq!(out["err"].as_str(), None);
    assert_eq!(out["pass"].as_bool(), Some(true));
    assert_eq!(out["score"].as_i64(), Some(100));
}

#[test]
fn known_hash_vectors_on_the_criteria_and_deliverable() {
    // "abc" is not valid criteria JSON -> invalid_criteria, but ch/dh are still
    // the exact SHA-256 of the decoded strings.
    let out = parse(&run(br#"{"criteria":"abc","deliverable":"abc"}"#));
    assert_eq!(out["err"].as_str(), Some("invalid_criteria"));
    assert_eq!(field(&out, "ch"), SHA_ABC);
    assert_eq!(field(&out, "dh"), SHA_ABC);

    // Empty deliverable hashes to the empty vector.
    let out = parse(&run(
        br#"{"criteria":"{\"checks\":[{\"kind\":\"length\"}]}","deliverable":""}"#,
    ));
    assert_eq!(field(&out, "dh"), SHA_EMPTY);
}

#[test]
fn too_large_takes_priority_over_criteria_parsing() {
    // A 4097-byte criteria string (valid JSON) is too_large, not scored.
    let pad = "a".repeat(4097 - r#"{"checks":[{"kind":"length"}],"pad":""}"#.len());
    let criteria = format!(r#"{{"checks":[{{"kind":"length"}}],"pad":"{pad}"}}"#);
    assert_eq!(criteria.len(), 4097);
    let stdin = serde_json::json!({ "criteria": criteria, "deliverable": "x" }).to_string();
    let out = parse(&run(stdin.as_bytes()));
    assert_eq!(out["err"].as_str(), Some("too_large"));

    // A deliverable of 16385 bytes is too_large.
    let stdin = serde_json::json!({
        "criteria": r#"{"checks":[{"kind":"length"}]}"#,
        "deliverable": "d".repeat(16385),
    })
    .to_string();
    let out = parse(&run(stdin.as_bytes()));
    assert_eq!(out["err"].as_str(), Some("too_large"));
}

#[test]
fn a_term_keeps_separate_answers_for_plain_and_whole_word_matching() {
    // "Arc" is a substring of "Architecture" but not a whole word there. The
    // judge memoizes term results per evaluation; the plain and whole-word
    // answers must never be mixed up, whichever is computed first.
    let text = "A software Architecture paid in USDC.";
    for (first_whole, second_whole) in [(false, true), (true, false)] {
        let criteria = serde_json::json!({ "passThreshold": 0, "checks": [
            { "kind": "contains", "params": { "all": ["Arc", "Arc"], "wholeWords": first_whole } },
            { "kind": "contains", "params": { "all": ["Arc"], "wholeWords": second_whole } },
        ] })
        .to_string();
        let stdin = serde_json::json!({ "criteria": criteria, "deliverable": text }).to_string();
        let out = parse(&run(stdin.as_bytes()));
        let checks = out["checks"].as_array().unwrap();
        assert_eq!(checks[0]["ok"].as_bool(), Some(!first_whole), "first check, whole={first_whole}");
        assert_eq!(checks[1]["ok"].as_bool(), Some(!second_whole), "second check, whole={second_whole}");
    }
}

#[test]
fn invalid_criteria_err_shape_matches_the_interface_example() {
    // Empty checks -> invalid_criteria, with the exact documented field shape.
    let stdin = serde_json::json!({ "criteria": r#"{"checks":[]}"#, "deliverable": "x" }).to_string();
    let out = run(stdin.as_bytes());
    // err appears right before eh, and the keys are in the documented order.
    let order = ["\"v\":", "\"pass\":", "\"score\":", "\"th\":", "\"ch\":", "\"dh\":", "\"checks\":", "\"err\":", "\"eh\":"];
    let mut last = 0usize;
    for key in order {
        let at = out.find(key).unwrap_or_else(|| panic!("missing key {key} in {out}"));
        assert!(at >= last, "key {key} out of order in {out}");
        last = at;
    }
    let v = parse(&out);
    assert_eq!(v["err"].as_str(), Some("invalid_criteria"));
    assert_eq!(v["pass"].as_bool(), Some(false));
    assert_eq!(v["score"].as_i64(), Some(0));
    assert!(v["checks"].as_array().unwrap().is_empty());
}

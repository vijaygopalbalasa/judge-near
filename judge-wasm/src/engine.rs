//! Criteria validation, the deterministic checkers, and scoring. Ported from
//! judge-protocol/judge-service/src/checkers/index.js (validateCriteria, LIMITS,
//! runCheck, scoreOf), with the docs/interface.md overrides applied: at most 16
//! checks (JS allowed 64), and the network kind `http-endpoint` is not known at
//! all (so any such check makes the criteria invalid).

use crate::shape::{matches_shape, shape_valid};
use crate::{
    has_whole_word, js_typeof, sha256_hex, utf16_len, word_count,
};
use serde_json::{Map, Value};

// LIMITS (interface overrides noted).
const MAX_CHECKS: usize = 16; // interface: 16 (JS LIMITS.checks was 64)
const DEPTH: usize = 12;
const TERMS: usize = 256;
const TERM_CHARS: usize = 1024;
const WEIGHT_CAP: f64 = 1000.0;

// http-endpoint is intentionally absent: it is a network kind and is not allowed in v1.
const KNOWN_KINDS: [&str; 5] = ["checksum", "schema", "contains", "length", "json"];
const TYPE_NAMES: [&str; 4] = ["string", "number", "boolean", "object"];

pub(crate) struct CheckSpec {
    pub kind: String,
    pub params: Value,
    pub weight: f64,
}

pub(crate) struct Prepared {
    pub checks: Vec<CheckSpec>,
    pub threshold: i64,
}

fn allowed_params(kind: &str) -> &'static [&'static str] {
    match kind {
        "length" => &["min", "max", "unit"],
        "contains" => &["all", "wholeWords"],
        "schema" => &["required", "types"],
        "checksum" => &["sha256"],
        "json" => &["shape"],
        _ => &[],
    }
}

/// `has()` from the JS: present and not null. A null param is treated as absent.
fn has(obj: &Map<String, Value>, k: &str) -> bool {
    obj.get(k).map(|v| !v.is_null()).unwrap_or(false)
}

/// validateCriteria + prepare. None means "invalid, abstain". The interface
/// overrides are folded in here.
pub(crate) fn validate_and_prepare(criteria: &Value) -> Option<Prepared> {
    let obj = criteria.as_object()?; // criteria must be an object
    if nests_deeper_than(criteria, DEPTH) {
        return None;
    }
    if has_proto_member(criteria) {
        return None;
    }
    let checks = match criteria.get("checks").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => return None, // checks must be a non-empty array
    };
    if checks.len() > MAX_CHECKS {
        return None;
    }

    let threshold: i64 = match obj.get("passThreshold") {
        None => 100, // omitted: all-must-pass
        Some(t) => match t.as_f64() {
            Some(x) if x.fract() == 0.0 && (0.0..=100.0).contains(&x) => x as i64,
            _ => return None,
        },
    };

    let empty = Value::Object(Map::new());
    let mut specs: Vec<CheckSpec> = Vec::with_capacity(checks.len());
    for c in checks {
        let co = match c.as_object() {
            Some(o) => o,
            None => return None, // a check must be an object
        };
        // A check has only kind, params and weight.
        for k in co.keys() {
            if k != "kind" && k != "params" && k != "weight" {
                return None;
            }
        }
        let kind = match co.get("kind").and_then(|v| v.as_str()) {
            Some(k) if KNOWN_KINDS.contains(&k) => k,
            _ => return None, // unknown kind (http-endpoint lands here)
        };
        let weight = match co.get("weight") {
            None => 1.0,
            Some(w) => match w.as_f64() {
                Some(x) if x > 0.0 && x <= WEIGHT_CAP => x,
                _ => return None,
            },
        };
        // params: present and not null must be an object; otherwise treated as {}.
        let params: &Value = match co.get("params") {
            None => &empty,
            Some(Value::Null) => &empty,
            Some(p) if p.is_object() => p,
            Some(_) => return None,
        };
        if !params_valid(kind, params) {
            return None;
        }
        specs.push(CheckSpec {
            kind: kind.to_string(),
            params: params.clone(),
            weight,
        });
    }
    Some(Prepared {
        checks: specs,
        threshold,
    })
}

fn params_valid(kind: &str, params: &Value) -> bool {
    let po = match params.as_object() {
        Some(o) => o,
        None => return false,
    };
    for k in po.keys() {
        if !allowed_params(kind).contains(&k.as_str()) {
            return false;
        }
    }
    match kind {
        "length" => {
            for k in ["min", "max"] {
                if has(po, k) && !is_num_ge0(&po[k]) {
                    return false;
                }
            }
            if has(po, "min") && has(po, "max") {
                if let (Some(mn), Some(mx)) = (po["min"].as_f64(), po["max"].as_f64()) {
                    if mn > mx {
                        return false;
                    }
                }
            }
            if has(po, "unit") && !matches!(po["unit"].as_str(), Some("chars") | Some("words")) {
                return false;
            }
            true
        }
        "contains" => {
            if has(po, "all") && !is_string_list(&po["all"]) {
                return false;
            }
            if has(po, "wholeWords") && !po["wholeWords"].is_boolean() {
                return false;
            }
            true
        }
        "schema" => {
            if has(po, "required") && !is_string_list(&po["required"]) {
                return false;
            }
            if has(po, "types") {
                let types = match po["types"].as_object() {
                    Some(m) => m,
                    None => return false,
                };
                if types.len() > TERMS {
                    return false;
                }
                for tval in types.values() {
                    if !matches!(tval.as_str(), Some(s) if TYPE_NAMES.contains(&s)) {
                        return false;
                    }
                }
            }
            true
        }
        "checksum" => matches!(po.get("sha256").and_then(|v| v.as_str()), Some(s) if is_hex64(s)),
        "json" => match po.get("shape") {
            None => true,
            Some(Value::Null) => true,
            Some(shape) => shape_valid(shape),
        },
        _ => true,
    }
}

fn is_num_ge0(v: &Value) -> bool {
    // isNumberIn(v, 0, Infinity): a finite number >= 0 (fractional allowed).
    v.as_f64().map(|x| x >= 0.0).unwrap_or(false)
}

fn is_string_list(v: &Value) -> bool {
    v.as_array()
        .map(|a| {
            a.len() <= TERMS
                && a.iter()
                    .all(|s| matches!(s.as_str(), Some(x) if utf16_len(x) <= TERM_CHARS))
        })
        .unwrap_or(false)
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// True if any object or array nests deeper than `limit` (the root is level 1).
/// Iterative, so no input can overflow the stack.
pub(crate) fn nests_deeper_than(value: &Value, limit: usize) -> bool {
    let mut stack: Vec<(&Value, usize)> = vec![(value, 1)];
    while let Some((v, d)) = stack.pop() {
        match v {
            Value::Object(m) => {
                if d > limit {
                    return true;
                }
                for child in m.values() {
                    stack.push((child, d + 1));
                }
            }
            Value::Array(a) => {
                if d > limit {
                    return true;
                }
                for child in a {
                    stack.push((child, d + 1));
                }
            }
            _ => {}
        }
    }
    false
}

/// True when any object inside the value has its own member named `__proto__`.
pub(crate) fn has_proto_member(value: &Value) -> bool {
    let mut stack: Vec<&Value> = vec![value];
    while let Some(v) = stack.pop() {
        match v {
            Value::Object(m) => {
                if m.contains_key("__proto__") {
                    return true;
                }
                for child in m.values() {
                    stack.push(child);
                }
            }
            Value::Array(a) => {
                for child in a {
                    stack.push(child);
                }
            }
            _ => {}
        }
    }
    false
}

// --------------------------------- checkers --------------------------------

/// Run one check against the deliverable text; returns its pass flag.
pub(crate) fn run_check(kind: &str, params: &Value, deliverable: &str) -> bool {
    match kind {
        "checksum" => {
            let expected = params
                .get("sha256")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            sha256_hex(deliverable.as_bytes()) == expected
        }
        "schema" => check_schema(params, deliverable),
        "contains" => check_contains(params, deliverable),
        "length" => check_length(params, deliverable),
        "json" => check_json(params, deliverable),
        _ => false,
    }
}

fn check_schema(params: &Value, deliverable: &str) -> bool {
    let value: Value = match serde_json::from_str(deliverable) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return false, // not a JSON object (null, array, scalar)
    };
    if let Some(req) = params.get("required").and_then(|v| v.as_array()) {
        for f in req {
            if let Some(name) = f.as_str() {
                if !obj.contains_key(name) {
                    return false;
                }
            }
        }
    }
    if let Some(types) = params.get("types").and_then(|v| v.as_object()) {
        for (field, tval) in types {
            if let Some(child) = obj.get(field) {
                if Some(js_typeof(child)) != tval.as_str() {
                    return false;
                }
            }
        }
    }
    true
}

fn check_contains(params: &Value, deliverable: &str) -> bool {
    let whole = params.get("wholeWords") == Some(&Value::Bool(true));
    if let Some(all) = params.get("all").and_then(|v| v.as_array()) {
        for t in all {
            if let Some(term) = t.as_str() {
                let found = if whole {
                    has_whole_word(deliverable, term)
                } else {
                    deliverable.contains(term)
                };
                if !found {
                    return false;
                }
            }
        }
    }
    true
}

fn check_length(params: &Value, deliverable: &str) -> bool {
    let unit_chars = params.get("unit").and_then(|v| v.as_str()) == Some("chars");
    let n = if unit_chars {
        utf16_len(deliverable)
    } else {
        word_count(deliverable)
    } as f64;
    let min = params
        .get("min")
        .filter(|v| !v.is_null())
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let max = params
        .get("max")
        .filter(|v| !v.is_null())
        .and_then(|v| v.as_f64())
        .unwrap_or(f64::INFINITY);
    n >= min && n <= max
}

fn check_json(params: &Value, deliverable: &str) -> bool {
    let value: Value = match serde_json::from_str(deliverable) {
        Ok(v) => v,
        Err(_) => return false,
    };
    match params.get("shape") {
        None | Some(Value::Null) => true,
        Some(shape) => matches_shape(&value, shape),
    }
}

/// Weighted score 0..100 and the pass decision. `weighted` is (pass, weight) per
/// check, in order. A score of 100 means every check passed: a failing check
/// whose weight rounds away scores 99, never 100.
pub(crate) fn score_of(weighted: &[(bool, f64)], threshold: i64) -> (i64, bool) {
    let mut weight_sum = 0.0f64;
    let mut weighted_pass = 0.0f64;
    let mut all_pass = true;
    for (ok, w) in weighted {
        weight_sum += *w;
        if *ok {
            weighted_pass += *w;
        } else {
            all_pass = false;
        }
    }
    let rounded = if weight_sum == 0.0 {
        0.0
    } else {
        // Match JS: (weightedPass / weightSum) * 100, then Math.round. For a
        // non-negative value Rust's round (half away from zero) equals Math.round.
        ((weighted_pass / weight_sum) * 100.0).round()
    };
    let score = if all_pass { rounded } else { rounded.min(99.0) };
    let score_i = score as i64;
    (score_i, score_i >= threshold)
}

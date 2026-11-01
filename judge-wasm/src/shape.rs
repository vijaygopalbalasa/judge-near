//! The `json` check's shape language: a pinned subset of JSON Schema. Ported from
//! judge-protocol/judge-service/src/checkers/json-shape.js. Two entry points:
//! `shape_valid` (the criteria gate) and `matches_shape` (does a deliverable value
//! satisfy the shape). Only pass/fail is needed, so the message machinery of the
//! JS version is dropped and `matches_shape` short-circuits on the first problem.

use crate::{cp_len, finite_f64, is_scalar, is_type, utf16_len};
use serde_json::{Map, Value};

const NODES: usize = 128;
const ANY_OF: usize = 4;
const TERMS: usize = 256;
const TERM_CHARS: usize = 1024;
const URL_CHARS: usize = 2048;
const EMAIL_CHARS: usize = 254;

const TYPES: [&str; 7] = [
    "object", "array", "string", "number", "integer", "boolean", "null",
];
const FORMATS: [&str; 2] = ["url", "email"];

/// (keyword, the one type it applies to). "number" also accepts "integer".
const NEEDS: [(&str, &str); 12] = [
    ("required", "object"),
    ("properties", "object"),
    ("additionalProperties", "object"),
    ("items", "array"),
    ("minItems", "array"),
    ("maxItems", "array"),
    ("uniqueBy", "array"),
    ("minLength", "string"),
    ("maxLength", "string"),
    ("format", "string"),
    ("minimum", "number"),
    ("maximum", "number"),
];

fn keyword_known(k: &str) -> bool {
    k == "type" || k == "enum" || k == "anyOf" || NEEDS.iter().any(|(n, _)| *n == k)
}

/// What is wrong with a shape? True = valid (JS returned null). The criteria gate
/// calls this before any deliverable is read.
pub(crate) fn shape_valid(shape: &Value) -> bool {
    let mut nodes = 0usize;
    visit(shape, false, &mut nodes)
}

fn visit(node: &Value, in_any_of: bool, nodes: &mut usize) -> bool {
    *nodes += 1;
    if *nodes > NODES {
        return false;
    }
    let obj = match node.as_object() {
        Some(o) => o,
        None => return false, // "must be an object"
    };
    for k in obj.keys() {
        if !keyword_known(k) {
            return false; // unknown keyword
        }
    }
    if obj.contains_key("anyOf") {
        if obj.len() != 1 {
            return false; // anyOf stands alone
        }
        if in_any_of {
            return false; // anyOf directly inside anyOf
        }
        let alts = match obj.get("anyOf").and_then(|v| v.as_array()) {
            Some(a) if a.len() >= 2 && a.len() <= ANY_OF => a,
            _ => return false,
        };
        for alt in alts {
            if !visit(alt, true, nodes) {
                return false;
            }
        }
        return true;
    }

    // `type`, if present, must be one of the known type names.
    let type_str = obj.get("type").and_then(|v| v.as_str());
    if obj.contains_key("type") && !matches!(type_str, Some(t) if TYPES.contains(&t)) {
        return false;
    }

    if let Some(e) = obj.get("enum") {
        let ok = e.as_array().is_some_and(|arr| {
            !arr.is_empty()
                && arr.len() <= TERMS
                && arr.iter().all(|x| {
                    is_scalar(x) && x.as_str().map(|s| utf16_len(s) <= TERM_CHARS).unwrap_or(true)
                })
        });
        if !ok {
            return false;
        }
    }

    // Each keyword must sit on its declared type.
    for (k, want) in NEEDS.iter() {
        if !obj.contains_key(*k) {
            continue;
        }
        let type_ok = if *want == "number" {
            type_str == Some("number") || type_str == Some("integer")
        } else {
            type_str == Some(*want)
        };
        if !type_ok {
            return false;
        }
    }

    for k in ["minItems", "maxItems", "minLength", "maxLength"] {
        if let Some(v) = obj.get(k) {
            if !is_count(v) {
                return false;
            }
        }
    }
    for k in ["minimum", "maximum"] {
        if let Some(v) = obj.get(k) {
            if finite_f64(v).is_none() {
                return false; // must be a finite number
            }
        }
    }
    for (lo, hi) in [
        ("minItems", "maxItems"),
        ("minLength", "maxLength"),
        ("minimum", "maximum"),
    ] {
        if let (Some(a), Some(b)) = (obj.get(lo), obj.get(hi)) {
            if let (Some(av), Some(bv)) = (finite_f64(a), finite_f64(b)) {
                if av > bv {
                    return false;
                }
            }
        }
    }
    if let Some(f) = obj.get("format") {
        if !matches!(f.as_str(), Some(s) if FORMATS.contains(&s)) {
            return false;
        }
    }
    if let Some(ap) = obj.get("additionalProperties") {
        if !ap.is_boolean() {
            return false;
        }
    }
    if let Some(r) = obj.get("required") {
        let ok = r.as_array().is_some_and(|arr| {
            arr.len() <= TERMS
                && arr
                    .iter()
                    .all(|f| matches!(f.as_str(), Some(s) if utf16_len(s) <= TERM_CHARS))
        });
        if !ok {
            return false;
        }
    }
    if let Some(u) = obj.get("uniqueBy") {
        if !unique_by_valid(u) {
            return false;
        }
    }
    if let Some(p) = obj.get("properties") {
        let props = match p.as_object() {
            Some(m) => m,
            None => return false,
        };
        if props.len() > TERMS || props.keys().any(|f| utf16_len(f) > TERM_CHARS) {
            return false;
        }
        for sub in props.values() {
            if !visit(sub, false, nodes) {
                return false;
            }
        }
    }
    if let Some(items) = obj.get("items") {
        return visit(items, false, nodes);
    }
    true
}

fn unique_by_valid(u: &Value) -> bool {
    let obj = match u.as_object() {
        Some(o) => o,
        None => return false,
    };
    if obj.len() != 2 {
        return false;
    }
    let field_ok = matches!(obj.get("field").and_then(|v| v.as_str()), Some(s) if !s.is_empty() && utf16_len(s) <= TERM_CHARS);
    let key_ok = matches!(obj.get("key").and_then(|v| v.as_str()), Some("value") | Some("domain"));
    field_ok && key_ok
}

fn is_count(v: &Value) -> bool {
    // Number.isInteger(v) && v >= 0
    matches!(v, Value::Number(_)) && finite_f64(v).map(|x| x.fract() == 0.0 && x >= 0.0).unwrap_or(false)
}

// ---------------------------- runtime matching -----------------------------

/// True if `value` satisfies `shape` with zero violations (count == 0 in the JS
/// `shapeViolations`). Called only after `shape_valid`, so every node is a
/// well-formed object.
pub(crate) fn matches_shape(value: &Value, shape: &Value) -> bool {
    matches(value, shape)
}

fn matches(v: &Value, node: &Value) -> bool {
    let obj = match node.as_object() {
        Some(o) => o,
        None => return true, // no constraints (validated shapes never hit this)
    };
    if let Some(any) = obj.get("anyOf").and_then(|x| x.as_array()) {
        return any.iter().any(|alt| matches(v, alt));
    }
    let type_str = obj.get("type").and_then(|x| x.as_str());
    if obj.contains_key("type") {
        match type_str {
            Some(t) if !is_type(v, t) => return false,
            None => return false, // type present but not a string (validated away, defensive)
            _ => {}
        }
    }
    if let Some(en) = obj.get("enum").and_then(|x| x.as_array()) {
        if !en.iter().any(|e| strict_eq(e, v)) {
            return false;
        }
    }
    match type_str {
        Some("string") => {
            if let Some(s) = v.as_str() {
                let n = cp_len(s);
                if let Some(min) = count_at(obj, "minLength") {
                    if n < min {
                        return false;
                    }
                }
                if let Some(max) = count_at(obj, "maxLength") {
                    if n > max {
                        return false;
                    }
                }
                match obj.get("format").and_then(|x| x.as_str()) {
                    Some("url") if !is_url(s) => return false,
                    Some("email") if !is_email(s) => return false,
                    _ => {}
                }
            }
        }
        Some("number") | Some("integer") => {
            if let Some(x) = v.as_f64() {
                if let Some(min) = finite_f64(obj.get("minimum").unwrap_or(&Value::Null)) {
                    if x < min {
                        return false;
                    }
                }
                if let Some(max) = finite_f64(obj.get("maximum").unwrap_or(&Value::Null)) {
                    if x > max {
                        return false;
                    }
                }
            }
        }
        Some("object") => {
            if let Some(map) = v.as_object() {
                let empty = Map::new();
                let props = obj
                    .get("properties")
                    .and_then(|x| x.as_object())
                    .unwrap_or(&empty);
                if let Some(req) = obj.get("required").and_then(|x| x.as_array()) {
                    for f in req {
                        if let Some(name) = f.as_str() {
                            if !map.contains_key(name) {
                                return false;
                            }
                        }
                    }
                }
                if obj.get("additionalProperties") == Some(&Value::Bool(false)) {
                    for k in map.keys() {
                        if !props.contains_key(k) {
                            return false;
                        }
                    }
                }
                for (f, sub) in props {
                    if let Some(child) = map.get(f) {
                        if !matches(child, sub) {
                            return false;
                        }
                    }
                }
            }
        }
        Some("array") => {
            if let Some(arr) = v.as_array() {
                if let Some(min) = count_at(obj, "minItems") {
                    if arr.len() < min {
                        return false;
                    }
                }
                if let Some(max) = count_at(obj, "maxItems") {
                    if arr.len() > max {
                        return false;
                    }
                }
                if let Some(items) = obj.get("items") {
                    for it in arr {
                        if !matches(it, items) {
                            return false;
                        }
                    }
                }
                if let Some(u) = obj.get("uniqueBy").and_then(|x| x.as_object()) {
                    if !unique_ok(arr, u) {
                        return false;
                    }
                }
            }
        }
        _ => {}
    }
    true
}

fn count_at(obj: &Map<String, Value>, key: &str) -> Option<usize> {
    obj.get(key).and_then(|v| v.as_f64()).map(|x| x as usize)
}

/// A collision key for uniqueBy. Numbers normalize so 1 and 1.0 collide (JS
/// String(1) === String(1.0)); -0 folds to 0; non-finite numbers key by sign.
/// Ord (not Hash) so a BTreeSet can hold it: a HashSet would pull in
/// RandomState, which links the WASI `random_get` import this guest must not have.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Str(String),
    Bool(bool),
    Num(u64),
}

fn num_key(v: &Value) -> Key {
    match v.as_f64() {
        Some(x) => {
            let norm = if x == 0.0 { 0.0 } else { x };
            Key::Num(norm.to_bits())
        }
        None => {
            // non-finite: +inf or -inf by the literal's sign.
            let neg = v.to_string().starts_with('-');
            let inf = if neg { f64::NEG_INFINITY } else { f64::INFINITY };
            Key::Num(inf.to_bits())
        }
    }
}

fn unique_ok(items: &[Value], u: &Map<String, Value>) -> bool {
    let field = match u.get("field").and_then(|v| v.as_str()) {
        Some(f) => f,
        None => return true,
    };
    let key = u.get("key").and_then(|v| v.as_str()).unwrap_or("value");
    let mut seen: std::collections::BTreeSet<Key> = std::collections::BTreeSet::new();
    for item in items {
        let obj = match item.as_object() {
            Some(o) => o,
            None => continue,
        };
        let raw = match obj.get(field) {
            Some(r) => r,
            None => continue,
        };
        let k = if key == "domain" {
            match raw.as_str() {
                Some(s) if is_url(s) => Key::Str(domain_of(s)),
                _ => continue,
            }
        } else {
            match raw {
                Value::String(s) => Key::Str(s.clone()),
                Value::Bool(b) => Key::Bool(*b),
                Value::Number(_) => num_key(raw),
                _ => continue, // null, object, array are skipped
            }
        };
        if !seen.insert(k) {
            return false;
        }
    }
    true
}

fn strict_eq(e: &Value, v: &Value) -> bool {
    use Value::*;
    match (e, v) {
        (Null, Null) => true,
        (Bool(a), Bool(b)) => a == b,
        (String(a), String(b)) => a == b,
        (Number(_), Number(_)) => match (e.as_f64(), v.as_f64()) {
            (Some(a), Some(b)) => a == b,
            (None, None) => e.to_string().starts_with('-') == v.to_string().starts_with('-'),
            _ => false,
        },
        _ => false,
    }
}

// ------------------------------- url / email -------------------------------

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    let sb = s.as_bytes();
    let pb = prefix.as_bytes();
    sb.len() >= pb.len() && sb[..pb.len()].eq_ignore_ascii_case(pb)
}

fn is_label(l: &str) -> bool {
    let b = l.as_bytes();
    let n = b.len();
    if n == 0 || n > 63 {
        return false;
    }
    if !b[0].is_ascii_alphanumeric() {
        return false;
    }
    if n == 1 {
        return true;
    }
    if !b[n - 1].is_ascii_alphanumeric() {
        return false;
    }
    b[1..n - 1]
        .iter()
        .all(|&c| c.is_ascii_alphanumeric() || c == b'-')
}

fn is_host(h: &str) -> bool {
    if utf16_len(h) > 253 {
        return false;
    }
    let labels: Vec<&str> = h.split('.').collect();
    if labels.len() < 2 || !labels.iter().all(|l| is_label(l)) {
        return false;
    }
    // last label must not be all digits (so no IP addresses, no localhost)
    let last = labels[labels.len() - 1];
    !(!last.is_empty() && last.bytes().all(|c| c.is_ascii_digit()))
}

pub(crate) fn is_url(s: &str) -> bool {
    if utf16_len(s) > URL_CHARS {
        return false;
    }
    let tail = if starts_with_ci(s, "https://") {
        &s[8..]
    } else if starts_with_ci(s, "http://") {
        &s[7..]
    } else {
        return false;
    };
    let end = tail.bytes().position(|b| b == b'/' || b == b'?' || b == b'#');
    let (authority, rest) = match end {
        Some(i) => (&tail[..i], &tail[i..]),
        None => (tail, ""),
    };
    let host = match authority.bytes().position(|b| b == b':') {
        Some(i) => {
            let port = &authority[i + 1..];
            if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            &authority[..i]
        }
        None => authority,
    };
    is_host(host) && rest.bytes().all(|b| (0x21..=0x7E).contains(&b))
}

fn is_atext(part: &str) -> bool {
    !part.is_empty()
        && part.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'/' | b'=' | b'?'
                        | b'^' | b'_' | b'`' | b'{' | b'|' | b'}' | b'~' | b'-'
                )
        })
}

pub(crate) fn is_email(s: &str) -> bool {
    if utf16_len(s) > EMAIL_CHARS {
        return false;
    }
    let at = match s.bytes().position(|b| b == b'@') {
        Some(i) => i,
        None => return false,
    };
    // exactly one '@', and not at position 0
    if at < 1 || s.bytes().rposition(|b| b == b'@') != Some(at) {
        return false;
    }
    let local = &s[..at];
    let domain = &s[at + 1..];
    utf16_len(local) <= 64 && local.split('.').all(is_atext) && is_host(domain)
}

pub(crate) fn domain_of(url: &str) -> String {
    let after = match url.find("//") {
        Some(i) => &url[i + 2..],
        None => url,
    };
    let end = after
        .bytes()
        .position(|b| matches!(b, b'/' | b'?' | b'#' | b':'));
    let host_raw = match end {
        Some(i) => &after[..i],
        None => after,
    };
    let host = host_raw.to_ascii_lowercase();
    if host.starts_with("www.") && host.split('.').count() > 2 {
        host["www.".len()..].to_string()
    } else {
        host
    }
}

//! judge-wasm: a deterministic ERC-8183 job-escrow judge.
//!
//! Reads one judge-input JSON object from `input`, runs the deterministic
//! acceptance checks, and produces a compact verdict JSON exactly as
//! `../docs/interface.md` (sections 1 to 3) specifies. Ported from Judge
//! Protocol's MIT JavaScript engine (same author); the JS engine is the oracle
//! for every accept/reject and pass/fail decision.
//!
//! Determinism: no randomness, clock, env, filesystem or network. The output is
//! a pure function of the input bytes. Malformed input never panics; it yields a
//! verdict carrying an `err` code.

use sha2::{Digest, Sha256};

mod engine;
mod shape;
mod word_ranges;

#[cfg(test)]
mod tests;

/// One check's line in the verdict: `<kind>#<index>` and its pass flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckResult {
    pub id: String,
    pub ok: bool,
}

/// The verdict, before serialization. `v` is always 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub pass: bool,
    pub score: i64,
    pub th: i64,
    pub ch: String,
    pub dh: String,
    pub checks: Vec<CheckResult>,
    /// `invalid_input`, `invalid_criteria` or `too_large`, or none for a scored verdict.
    pub err: Option<String>,
}

// Interface limits (docs/interface.md section 1 and 2). These OVERRIDE the JS
// engine where they differ (the JS engine allowed 64 checks and http-endpoint).
const MAX_CRITERIA_BYTES: usize = 4_096;
const MAX_DELIVERABLE_BYTES: usize = 16_384;
const MAX_VERDICT_BYTES: usize = 900;

/// lowercase hex SHA-256 of `bytes`.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        // Two lowercase hex digits per byte; no formatting machinery that could
        // vary by locale.
        out.push(char::from(HEX[(b >> 4) as usize]));
        out.push(char::from(HEX[(b & 0x0f) as usize]));
    }
    out
}
const HEX: &[u8; 16] = b"0123456789abcdef";

/// Evaluate judge input bytes into a `Verdict`. Never panics.
pub fn evaluate(input: &[u8]) -> Verdict {
    // Step 1: stdin must be a JSON object with string `criteria` and
    // `deliverable`. Anything else is `invalid_input`, with ch/dh taken over
    // whatever string bytes could be read, or the empty string.
    let value: serde_json::Value = match serde_json::from_slice(input) {
        Ok(v) => v,
        Err(_) => return err_verdict("invalid_input", &sha256_hex(b""), &sha256_hex(b"")),
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return err_verdict("invalid_input", &sha256_hex(b""), &sha256_hex(b"")),
    };
    let criteria_str = obj.get("criteria").and_then(|v| v.as_str());
    let deliverable_str = obj.get("deliverable").and_then(|v| v.as_str());
    let (criteria, deliverable) = match (criteria_str, deliverable_str) {
        (Some(c), Some(d)) => (c, d),
        // A field that is missing or not a string: hash what we can, empty for the rest.
        (c, d) => {
            let ch = sha256_hex(c.unwrap_or("").as_bytes());
            let dh = sha256_hex(d.unwrap_or("").as_bytes());
            return err_verdict("invalid_input", &ch, &dh);
        }
    };

    // From here on both strings exist, so ch/dh are always their exact bytes.
    let ch = sha256_hex(criteria.as_bytes());
    let dh = sha256_hex(deliverable.as_bytes());

    // Step 2: size gate (UTF-8 bytes), before parsing the criteria.
    if criteria.len() > MAX_CRITERIA_BYTES || deliverable.len() > MAX_DELIVERABLE_BYTES {
        return err_verdict("too_large", &ch, &dh);
    }

    // Step 3: the criteria is itself JSON (stored as a string). Unparseable or
    // invalid criteria are abstained on: `invalid_criteria`, no score.
    let criteria_value: serde_json::Value = match serde_json::from_str(criteria) {
        Ok(v) => v,
        Err(_) => return err_verdict("invalid_criteria", &ch, &dh),
    };
    let prepared = match engine::validate_and_prepare(&criteria_value) {
        Some(p) => p,
        None => return err_verdict("invalid_criteria", &ch, &dh),
    };

    // Step 4: run every check on the deliverable and score it. One context per
    // evaluation, so the deliverable is indexed and parsed at most once.
    let mut ctx = engine::Ctx::new(deliverable, &dh);
    let mut results = Vec::with_capacity(prepared.checks.len());
    let mut weighted: Vec<(bool, f64)> = Vec::with_capacity(prepared.checks.len());
    for (i, c) in prepared.checks.iter().enumerate() {
        let ok = engine::run_check(&c.kind, &c.params, &mut ctx);
        results.push(CheckResult {
            id: check_id(&c.kind, i),
            ok,
        });
        weighted.push((ok, c.weight));
    }
    let (score, pass) = engine::score_of(&weighted, prepared.threshold);
    Verdict {
        pass,
        score,
        th: prepared.threshold,
        ch,
        dh,
        checks: results,
        err: None,
    }
}

/// `<kind>#<index>`, at most 24 characters (the ported kinds and 0..15 indices
/// never reach that, but it is clamped so the field can never break the schema).
fn check_id(kind: &str, index: usize) -> String {
    let mut id = format!("{}#{}", kind, index);
    if id.len() > 24 {
        id.truncate(24);
    }
    id
}

fn err_verdict(code: &str, ch: &str, dh: &str) -> Verdict {
    Verdict {
        pass: false,
        score: 0,
        th: 100,
        ch: ch.to_string(),
        dh: dh.to_string(),
        checks: Vec::new(),
        err: Some(code.to_string()),
    }
}

/// Serialize a verdict to its compact JSON, keys in the documented order, with
/// `eh` computed and inserted last. Byte-for-byte what a browser would produce
/// with `JSON.stringify` on an object built in the same key order.
pub fn render(verdict: &Verdict) -> String {
    // Build the prefix: the whole object except the closing brace and `eh`.
    let mut s = String::with_capacity(256);
    s.push_str("{\"v\":1,\"pass\":");
    s.push_str(if verdict.pass { "true" } else { "false" });
    s.push_str(",\"score\":");
    push_int(&mut s, verdict.score);
    s.push_str(",\"th\":");
    push_int(&mut s, verdict.th);
    s.push_str(",\"ch\":\"");
    s.push_str(&verdict.ch);
    s.push_str("\",\"dh\":\"");
    s.push_str(&verdict.dh);
    s.push_str("\",\"checks\":[");
    for (i, c) in verdict.checks.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"id\":\"");
        s.push_str(&c.id);
        s.push_str("\",\"ok\":");
        s.push_str(if c.ok { "true" } else { "false" });
        s.push('}');
    }
    s.push(']');
    if let Some(code) = &verdict.err {
        s.push_str(",\"err\":\"");
        s.push_str(code);
        s.push('"');
    }
    // eh = sha256 of the prefix with a closing brace appended.
    let mut with_brace = s.clone();
    with_brace.push('}');
    let eh = sha256_hex(with_brace.as_bytes());
    s.push_str(",\"eh\":\"");
    s.push_str(&eh);
    s.push_str("\"}");
    s
}

/// Convenience: evaluate and render in one call.
pub fn run(input: &[u8]) -> String {
    render(&evaluate(input))
}

/// True once the rendered verdict would be at most the documented 900 bytes.
/// (Used by tests; the ported bounds keep every verdict well under it.)
pub fn within_size_limit(rendered: &str) -> bool {
    rendered.len() <= MAX_VERDICT_BYTES
}

fn push_int(s: &mut String, n: i64) {
    // Minimal base-10 integer form, matching JSON.stringify of an integer.
    s.push_str(&n.to_string());
}

// ----- text and type helpers (pub(crate), shared by shape.rs and engine.rs) -----

/// The ECMAScript WhiteSpace + LineTerminator set, used by String.prototype.trim
/// and the regular-expression `\s` class. NOT Rust's `char::is_whitespace`
/// (which includes U+0085 and excludes U+FEFF).
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c as u32,
        0x0009 | 0x000A | 0x000B | 0x000C | 0x000D | 0x0020 | 0x00A0 | 0x1680
            | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

/// UTF-16 code-unit count, which is what every JS `String#length` returns.
pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Unicode code-point count, which is what `[...s].length` returns (used only by
/// json-shape minLength/maxLength).
pub(crate) fn cp_len(s: &str) -> usize {
    s.chars().count()
}

/// Word count = maximal runs of non-whitespace, i.e. `trim().split(/\s+/).filter(Boolean).length`.
pub(crate) fn word_count(s: &str) -> usize {
    let mut count = 0usize;
    let mut in_word = false;
    for c in s.chars() {
        if is_js_space(c) {
            in_word = false;
        } else if !in_word {
            count += 1;
            in_word = true;
        }
    }
    count
}

/// True for `_` and the pinned Unicode 17.0.0 letters and digits. Binary search
/// over the sorted, disjoint ranges.
pub(crate) fn is_word_code_point(cp: u32) -> bool {
    if cp == 0x5f {
        return true;
    }
    let r = &word_ranges::WORD_RANGES;
    let (mut lo, mut hi) = (0usize, r.len());
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let (a, b) = r[mid];
        if cp < a {
            hi = mid;
        } else if cp > b {
            lo = mid + 1;
        } else {
            return true;
        }
    }
    false
}

/// `term` occurs in `text` with a non-word code point (or an edge) on each side.
/// Test convenience; the engine builds one `TextIndex` per deliverable.
#[cfg(test)]
pub(crate) fn has_whole_word(text: &str, term: &str) -> bool {
    TextIndex::new(text).has_whole_word(term)
}

/// A deliverable's code points and their word flags, computed once so that every
/// whole-word term costs O(n + m) instead of a table lookup per position per
/// term. Results equal the code-point reference from the JS test suite (which
/// the JS scan is proven equal to); a differential test holds them together.
pub(crate) struct TextIndex {
    chars: Vec<char>,
    word: Vec<bool>,
}

impl TextIndex {
    pub(crate) fn new(text: &str) -> Self {
        let chars: Vec<char> = text.chars().collect();
        let word = chars.iter().map(|&c| is_word_code_point(c as u32)).collect();
        TextIndex { chars, word }
    }

    /// No word character touches the span [start, start + len) on either side.
    fn boundary_ok(&self, start: usize, len: usize) -> bool {
        let n = self.chars.len();
        let left_ok = start == 0 || !self.word[start - 1];
        let right_ok = start + len == n || !self.word[start + len];
        left_ok && right_ok
    }

    /// True if any occurrence of `term`, overlapping ones included, stands as a
    /// whole word. Knuth-Morris-Pratt: one pass over the text per term.
    pub(crate) fn has_whole_word(&self, term: &str) -> bool {
        let w: Vec<char> = term.chars().collect();
        let n = self.chars.len();
        let m = w.len();
        if m > n {
            return false;
        }
        if m == 0 {
            // The empty term occurs at every position 0..=n.
            return (0..=n).any(|i| self.boundary_ok(i, 0));
        }
        // fail[q] = length of the longest proper border of w[..=q].
        let mut fail = vec![0usize; m];
        let mut k = 0usize;
        for q in 1..m {
            while k > 0 && w[q] != w[k] {
                k = fail[k - 1];
            }
            if w[q] == w[k] {
                k += 1;
            }
            fail[q] = k;
        }
        let mut q = 0usize; // chars of w matched so far (always < m here)
        for (i, &c) in self.chars.iter().enumerate() {
            while q > 0 && c != w[q] {
                q = fail[q - 1];
            }
            if c == w[q] {
                q += 1;
            }
            if q == m {
                if self.boundary_ok(i + 1 - m, m) {
                    return true;
                }
                q = fail[m - 1]; // keep going: occurrences may overlap
            }
        }
        false
    }
}

/// json-shape `typeOf`: null -> "null", array -> "array", a number that
/// overflowed a double -> "non-finite number", otherwise the JS `typeof`.
pub(crate) fn type_of(v: &serde_json::Value) -> &'static str {
    use serde_json::Value::*;
    match v {
        Null => "null",
        Bool(_) => "boolean",
        Number(n) => {
            if n.as_f64().is_some() {
                "number"
            } else {
                "non-finite number"
            }
        }
        String(_) => "string",
        Array(_) => "array",
        Object(_) => "object",
    }
}

/// The schema check's `typeof`: null, array and object are all "object", and a
/// number (finite or not) is "number".
pub(crate) fn js_typeof(v: &serde_json::Value) -> &'static str {
    use serde_json::Value::*;
    match v {
        Null => "object",
        Bool(_) => "boolean",
        Number(_) => "number",
        String(_) => "string",
        Array(_) => "object",
        Object(_) => "object",
    }
}

/// A finite f64 if `v` is an in-range JSON number, else None (non-finite numbers,
/// and non-numbers, both give None).
pub(crate) fn finite_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
}

/// json-shape `isType` with "integer" meaning `Number.isInteger`.
pub(crate) fn is_type(v: &serde_json::Value, t: &str) -> bool {
    if t == "integer" {
        return matches!(v, serde_json::Value::Number(_))
            && v.as_f64().map(|x| x.fract() == 0.0).unwrap_or(false);
    }
    type_of(v) == t
}

/// json-shape `isScalar`: null, string, boolean, or a finite number.
pub(crate) fn is_scalar(v: &serde_json::Value) -> bool {
    use serde_json::Value::*;
    matches!(v, Null | Bool(_) | String(_)) || v.as_f64().is_some()
}

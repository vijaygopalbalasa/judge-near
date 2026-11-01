//! Output robustness: a large, deterministic sweep of generated inputs must each
//! produce valid JSON of at most 900 bytes, with v == 1 and keys in the
//! documented order. Catches any verdict that could blow the contract's size
//! budget or reorder fields.

use judge_wasm::run;
use serde_json::{json, Value};

/// A tiny deterministic LCG so the sweep is reproducible with no external seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
}

const KINDS: [&str; 5] = ["length", "contains", "schema", "checksum", "json"];
const WORDS: [&str; 8] = ["USDC", "Arc", "ERC-8183", "\u{1F600}", "pays", "work", "\u{00e9}tude", "settle"];
const DELIVERABLES: [&str; 6] = [
    "Paid in USDC on Arc.",
    "{\"invoiceId\":\"A-1\",\"total\":3}",
    "[1,2,3]",
    "\u{1F600}\u{1F600} short",
    "",
    "not json at all, just prose with Arc and USDC",
];

fn random_check(rng: &mut Rng) -> Value {
    let kind = *rng.pick(&KINDS);
    let params = match kind {
        "length" => json!({ "min": rng.below(5), "max": 50 + rng.below(100), "unit": if rng.below(2) == 0 { "words" } else { "chars" } }),
        "contains" => {
            let n = 1 + rng.below(3) as usize;
            let terms: Vec<&str> = (0..n).map(|_| *rng.pick(&WORDS)).collect();
            json!({ "all": terms, "wholeWords": rng.below(2) == 0 })
        }
        "schema" => json!({ "required": [*rng.pick(&WORDS)], "types": { "total": "number" } }),
        "checksum" => json!({ "sha256": "a".repeat(64) }),
        "json" => json!({ "shape": { "type": "array", "minItems": rng.below(3), "maxItems": 10 } }),
        _ => json!({}),
    };
    let mut check = json!({ "kind": kind, "params": params });
    if rng.below(2) == 0 {
        check["weight"] = json!(1 + rng.below(1000));
    }
    check
}

fn keys_in_documented_order(out: &str) -> bool {
    let base = ["\"v\":", "\"pass\":", "\"score\":", "\"th\":", "\"ch\":", "\"dh\":", "\"checks\":"];
    let mut last = 0usize;
    for k in base {
        match out.find(k) {
            Some(at) if at >= last => last = at,
            _ => return false,
        }
    }
    // Optional fields in their documented order: err, then k (sealed passes), then eh.
    for k in ["\"err\":", "\"k\":"] {
        if let Some(at) = out.find(k) {
            if at < last {
                return false;
            }
            last = at;
        }
    }
    match out.find("\"eh\":") {
        Some(at) => at >= last,
        None => false,
    }
}

/// Standard base64 with padding (test helper).
fn b64(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { A[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// Sealed jobs: the same sweep, encrypted under a fixed test key, so verdicts that
/// carry k (131 extra bytes) are held to the 900-byte limit and the key order too.
#[test]
fn generated_sealed_inputs_always_produce_small_well_formed_verdicts() {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
    use sha2::{Digest, Sha256};
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let key = [0x42u8; 32];
    let client_pk = x25519_dalek::x25519([0x17u8; 32], x25519_dalek::X25519_BASEPOINT_BYTES);
    let mut rng = Rng(0xD1B54A32D192ED03);
    let mut with_k = 0;
    for i in 0..400 {
        let count = 1 + rng.below(16) as usize;
        let checks: Vec<Value> = (0..count).map(|_| random_check(&mut rng)).collect();
        let mut criteria = json!({ "checks": checks });
        criteria["passThreshold"] = json!(rng.below(101));
        let plaintext = rng.pick(&DELIVERABLES).as_bytes();
        let nonce = [i as u8; 12];
        let sealed = ChaCha20Poly1305::new(Key::from_slice(&key)).encrypt(Nonce::from_slice(&nonce), plaintext).unwrap();
        let c = b64(&[nonce.as_slice(), &sealed].concat());
        let stdin = json!({
            "criteria": criteria.to_string(),
            "deliverable_ct": c,
            "dh": hex(&Sha256::digest(plaintext)),
            "client_pk": hex(&client_pk),
        })
        .to_string();
        let out = judge_wasm::run_with_key(stdin.as_bytes(), Some(&hex(&key)));
        assert!(out.len() <= 900, "sealed input #{i} produced {} bytes: {out}", out.len());
        let parsed: Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("sealed #{i} invalid JSON ({e}): {out}"));
        assert_eq!(parsed["v"].as_i64(), Some(1));
        assert!(keys_in_documented_order(&out), "sealed #{i}: keys out of order: {out}");
        assert_eq!(parsed["k"].is_string(), parsed["pass"] == json!(true), "sealed #{i}: k iff pass: {out}");
        if parsed["k"].is_string() {
            with_k += 1;
        }
    }
    assert!(with_k >= 40, "only {with_k} sealed passes carried k");
}

#[test]
fn generated_inputs_always_produce_small_well_formed_verdicts() {
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let n = 1200;
    for i in 0..n {
        // Mostly well-formed stdin; a slice is deliberately malformed.
        let stdin = if rng.below(10) == 0 {
            // malformed criteria string or stdin
            match rng.below(3) {
                0 => "{not valid".to_string(),
                1 => json!({ "criteria": "{bad json", "deliverable": rng.pick(&DELIVERABLES) }).to_string(),
                _ => json!({ "criteria": "[]", "deliverable": rng.pick(&DELIVERABLES) }).to_string(),
            }
        } else {
            let count = 1 + rng.below(16) as usize; // 1..=16 checks, the interface cap
            let checks: Vec<Value> = (0..count).map(|_| random_check(&mut rng)).collect();
            let mut criteria = json!({ "checks": checks });
            if rng.below(2) == 0 {
                criteria["passThreshold"] = json!(rng.below(101));
            }
            json!({ "criteria": criteria.to_string(), "deliverable": rng.pick(&DELIVERABLES) }).to_string()
        };

        let out = run(stdin.as_bytes());
        assert!(
            out.len() <= 900,
            "input #{i} produced {} bytes:\n{}\n{}",
            out.len(),
            stdin,
            out
        );
        let parsed: Value = serde_json::from_str(&out)
            .unwrap_or_else(|e| panic!("input #{i} produced invalid JSON ({e}): {out}"));
        assert_eq!(parsed["v"].as_i64(), Some(1), "input #{i}: v != 1");
        assert!(
            keys_in_documented_order(&out),
            "input #{i}: keys out of order: {out}"
        );
    }
}

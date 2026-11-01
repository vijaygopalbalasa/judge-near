//! Sealed mode (docs/interface.md section 6.3) against vectors/sealed.json, which
//! scripts/gen-sealed.mjs produces from an independent Node reference (built-in
//! crypto for sealing, Judge Protocol's JS engine for the checks). Keys in the
//! vectors are test fixtures derived from fixed public seeds.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use judge_wasm::{run, run_with_key};
use serde_json::Value;
use sha2::{Digest, Sha256};
use x25519_dalek::x25519;

const SEALED: &str = include_str!("../vectors/sealed.json");
const PARITY: &str = include_str!("../vectors/parity.json");

fn vectors() -> Vec<Value> {
    serde_json::from_str::<Value>(SEALED)
        .expect("sealed.json parses")
        .as_array()
        .expect("sealed.json is an array")
        .clone()
}

/// Minimal standard base64 decoder for test inputs (all canonical here).
fn b64(s: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let v = A.iter().position(|&x| x == c).expect("base64 char") as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

fn key_of(v: &Value) -> Option<&str> {
    v["test_jn_key"].as_str()
}

#[test]
fn sealed_vectors_match_the_reference_byte_for_byte() {
    let arr = vectors();
    assert!(arr.len() >= 20, "expected >= 20 sealed vectors, got {}", arr.len());
    let mut failures = Vec::new();
    for v in &arr {
        let name = v["name"].as_str().unwrap();
        let want = v["expected"].as_str().unwrap();
        let got = run_with_key(v["stdin"].as_str().unwrap().as_bytes(), key_of(v));
        if got != want {
            failures.push(format!("[{name}]\n    want: {want}\n    got:  {got}"));
        }
    }
    assert!(failures.is_empty(), "{} of {} sealed vectors mismatched:\n{}", failures.len(), arr.len(), failures.join("\n"));
}

/// The client's side, in Rust: open k with the client's secret key, recover K,
/// decrypt C, and get back exactly the provider's plaintext.
#[test]
fn the_client_opens_k_recovers_k_and_decrypts_c() {
    let mut opened = 0;
    for v in &vectors() {
        let name = v["name"].as_str().unwrap();
        let verdict: Value = serde_json::from_str(v["expected"].as_str().unwrap()).unwrap();
        let Some(k) = verdict["k"].as_str() else { continue };
        assert_eq!(k.len(), 124, "[{name}] k length");
        let raw = b64(k);
        assert_eq!(raw.len(), 93, "[{name}] k bytes");
        assert_eq!(raw[0], 0x01, "[{name}] k version");
        let eph_pk: [u8; 32] = raw[1..33].try_into().unwrap();
        let client_sk: [u8; 32] = hex(v["test_client_sk"].as_str().unwrap()).try_into().unwrap();
        let shared = x25519(client_sk, eph_pk);
        let mut sym = [0u8; 32];
        Hkdf::<Sha256>::new(None, &shared).expand(b"judge-near-k-v1", &mut sym).unwrap();
        let k_bytes = ChaCha20Poly1305::new(Key::from_slice(&sym))
            .decrypt(Nonce::from_slice(&raw[33..45]), &raw[45..])
            .unwrap_or_else(|_| panic!("[{name}] k does not open with the client key"));
        assert_eq!(k_bytes, hex(&key_of(v).unwrap().to_ascii_lowercase()), "[{name}] recovered K");

        let stdin: Value = serde_json::from_str(v["stdin"].as_str().unwrap()).unwrap();
        let c = b64(stdin["deliverable_ct"].as_str().unwrap());
        let plaintext = ChaCha20Poly1305::new(Key::from_slice(&k_bytes))
            .decrypt(Nonce::from_slice(&c[..12]), &c[12..])
            .unwrap_or_else(|_| panic!("[{name}] C does not decrypt with the recovered K"));
        assert_eq!(plaintext, b64(v["plaintext_b64"].as_str().unwrap()), "[{name}] plaintext");
        assert_eq!(sha256_hex(&plaintext), verdict["dh"].as_str().unwrap(), "[{name}] dh");
        opened += 1;
    }
    assert!(opened >= 10, "only {opened} vectors carried k");
}

/// A scored sealed verdict is the public verdict over the plaintext plus k: drop
/// k, recompute eh, and it must equal public mode run on the plaintext.
#[test]
fn a_scored_sealed_verdict_equals_the_public_verdict_over_the_plaintext() {
    let mut compared = 0;
    for v in &vectors() {
        let name = v["name"].as_str().unwrap();
        let sealed = v["expected"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(sealed).unwrap();
        let err = parsed["err"].as_str();
        if matches!(err, Some("invalid_input" | "key_missing" | "bad_delivery")) || name.starts_with("too_large") {
            continue; // not a verdict over a decrypted plaintext
        }
        let stdin: Value = serde_json::from_str(v["stdin"].as_str().unwrap()).unwrap();
        let plaintext = String::from_utf8(b64(v["plaintext_b64"].as_str().unwrap())).unwrap();
        let public_stdin = serde_json::json!({ "criteria": stdin["criteria"], "deliverable": plaintext }).to_string();
        let public = run(public_stdin.as_bytes());

        let without_k = match parsed["k"].as_str() {
            Some(k) => sealed.replacen(&format!(",\"k\":\"{k}\""), "", 1),
            None => sealed.to_string(),
        };
        let at = without_k.find(",\"eh\":\"").unwrap();
        let body = format!("{}}}", &without_k[..at]);
        let rebuilt = format!("{},\"eh\":\"{}\"}}", &without_k[..at], sha256_hex(body.as_bytes()));
        assert_eq!(rebuilt, public, "[{name}] sealed minus k differs from public mode");
        compared += 1;
    }
    assert!(compared >= 12, "only {compared} scored sealed vectors compared");
}

#[test]
fn the_longest_legal_verdict_fits_in_900_bytes() {
    let v = vectors()
        .into_iter()
        .find(|v| v["name"].as_str().unwrap().starts_with("pass: longest verdict"))
        .expect("the longest-verdict vector");
    let out = run_with_key(v["stdin"].as_str().unwrap().as_bytes(), key_of(&v));
    assert_eq!(out.len(), 897, "longest sealed verdict: {out}");
}

/// Public mode never reads JN_KEY: with or without a key, every parity vector
/// prints the same verdict.
#[test]
fn public_mode_ignores_jn_key() {
    let key = "11".repeat(32);
    let parity: Value = serde_json::from_str(PARITY).unwrap();
    for v in parity.as_array().unwrap() {
        let stdin = serde_json::json!({ "criteria": v["criteria"], "deliverable": v["deliverable"] }).to_string();
        assert_eq!(run_with_key(stdin.as_bytes(), Some(&key)), run(stdin.as_bytes()), "{}", v["name"]);
    }
}

//! Sealed mode (docs/interface.md section 6.3): the deliverable arrives encrypted
//! as `deliverable_ct`, the provider's key K arrives as `JN_KEY` (passed in by the
//! caller, so this module stays pure), and a pass releases `k` = K sealed to the
//! client's X25519 key. Order of outcomes, first match wins:
//!
//! 1. `invalid_input`: criteria or deliverable_ct not a string, `deliverable` also
//!    present, `dh` or `client_pk` not exactly 64 lowercase hex.
//! 2. `too_large`: criteria over 4096 bytes or deliverable_ct over 21884 bytes (so an
//!    oversized input never touches the key).
//! 3. `key_missing`: JN_KEY absent or not exactly 64 hex digits (either case).
//! 4. `bad_delivery`: C not canonical base64, shorter than nonce + tag, failing the
//!    tag check, sha256(plaintext) != dh, or plaintext not UTF-8.
//! 5. otherwise the normal verdict over the plaintext (its own size gate, then the
//!    criteria), plus `k` when it passes.
//!
//! On every error above, `ch` = sha256(criteria) (or of "" if criteria is not a
//! string) and `dh` = the input `dh` (or sha256("") if it is malformed).

use crate::{b64, err_verdict, evaluate_texts, sha256_hex, Verdict, MAX_CRITERIA_BYTES};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use serde_json::{Map, Value};
use sha2::Sha256;
use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};

/// base64 length of nonce(12) + 16384 plaintext bytes + tag(16).
const MAX_CT_BYTES: usize = 21_884;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const K_VERSION: u8 = 0x01;
const K_EPH_INFO: &[u8] = b"judge-near-k-eph-v1";
const K_INFO: &[u8] = b"judge-near-k-v1";
const K_NONCE_INFO: &[u8] = b"judge-near-k-nonce-v1";

pub(crate) fn evaluate_sealed(obj: &Map<String, Value>, jn_key: Option<&str>) -> Verdict {
    let criteria = obj.get("criteria").and_then(Value::as_str);
    let dh_in = obj.get("dh").and_then(Value::as_str).filter(|s| is_lower_hex64(s));
    let ch = sha256_hex(criteria.unwrap_or("").as_bytes());
    let dh_out = dh_in.map_or_else(|| sha256_hex(b""), str::to_string);
    let client_pk = obj
        .get("client_pk")
        .and_then(Value::as_str)
        .filter(|s| is_lower_hex64(s))
        .and_then(hex32);
    let ct = obj.get("deliverable_ct").and_then(Value::as_str);

    let (criteria, dh_in, client_pk, ct) = match (criteria, dh_in, client_pk, ct) {
        (Some(c), Some(d), Some(p), Some(t)) if !obj.contains_key("deliverable") => (c, d, p, t),
        _ => return err_verdict("invalid_input", &ch, &dh_out),
    };
    if criteria.len() > MAX_CRITERIA_BYTES || ct.len() > MAX_CT_BYTES {
        return err_verdict("too_large", &ch, &dh_out);
    }
    let key = match jn_key.filter(|s| is_hex64(s)).and_then(hex32) {
        Some(k) => k,
        None => return err_verdict("key_missing", &ch, &dh_out),
    };
    let plaintext = match open_deliverable(&key, ct, dh_in) {
        Some(p) => p,
        None => return err_verdict("bad_delivery", &ch, &dh_out),
    };
    let mut verdict = evaluate_texts(criteria, &plaintext);
    if verdict.pass && verdict.err.is_none() {
        verdict.k = seal_k(&key, &client_pk, &verdict.ch, &verdict.dh);
    }
    verdict
}

/// C = base64(nonce | ChaCha20-Poly1305(K, nonce, plaintext) | tag), empty AAD.
/// The plaintext, if C opens under K, hashes to `dh`, and is UTF-8.
fn open_deliverable(key: &[u8; 32], ct: &str, dh: &str) -> Option<String> {
    let raw = b64::decode(ct)?;
    if raw.len() < NONCE_LEN + TAG_LEN {
        return None;
    }
    let (nonce, sealed) = raw.split_at(NONCE_LEN);
    let plaintext = ChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(Nonce::from_slice(nonce), sealed)
        .ok()?;
    if sha256_hex(&plaintext) != dh {
        return None;
    }
    String::from_utf8(plaintext).ok()
}

/// `label | client_pk (32 raw bytes) | ch (64 hex chars) | dh (64 hex chars)`.
fn bound_info(label: &[u8], client_pk: &[u8; 32], ch: &str, dh: &str) -> Vec<u8> {
    let mut info = Vec::with_capacity(label.len() + 32 + ch.len() + dh.len());
    info.extend_from_slice(label);
    info.extend_from_slice(client_pk);
    info.extend_from_slice(ch.as_bytes());
    info.extend_from_slice(dh.as_bytes());
    info
}

/// k = base64(0x01 | X25519(eph_sk, basepoint) | nonce | ChaCha20-Poly1305(sym, nonce, K) | tag):
/// 93 bytes, 124 characters. Deterministic, so the verdict is reproducible. HKDF
/// expansion to 12 or 32 bytes and AEAD over 32 bytes cannot fail; None is unreachable.
fn seal_k(key: &[u8; 32], client_pk: &[u8; 32], ch: &str, dh: &str) -> Option<String> {
    let from_key = Hkdf::<Sha256>::new(None, key);
    let mut eph_sk = [0u8; 32];
    from_key.expand(&bound_info(K_EPH_INFO, client_pk, ch, dh), &mut eph_sk).ok()?;
    let mut nonce = [0u8; NONCE_LEN];
    from_key.expand(&bound_info(K_NONCE_INFO, client_pk, ch, dh), &mut nonce).ok()?;
    // x25519() clamps the scalar (RFC 7748) for both multiplications.
    let shared = x25519(eph_sk, *client_pk);
    let mut sym = [0u8; 32];
    Hkdf::<Sha256>::new(None, &shared).expand(K_INFO, &mut sym).ok()?;
    let sealed_key = ChaCha20Poly1305::new(Key::from_slice(&sym))
        .encrypt(Nonce::from_slice(&nonce), key.as_slice())
        .ok()?;
    let mut out = Vec::with_capacity(1 + 32 + NONCE_LEN + sealed_key.len());
    out.push(K_VERSION);
    out.extend_from_slice(&x25519(eph_sk, X25519_BASEPOINT_BYTES));
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed_key);
    Some(b64::encode(&out))
}

fn is_lower_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 64 hex digits (either case) to 32 bytes.
fn hex32(s: &str) -> Option<[u8; 32]> {
    let b = s.as_bytes();
    if b.len() != 64 {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (slot, pair) in out.iter_mut().zip(b.chunks(2)) {
        *slot = (nib(pair[0])? << 4) | nib(pair[1])?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// RFC 5869 test case 3: HKDF-SHA256 with no salt, as the k derivation uses it.
    #[test]
    fn hkdf_without_salt_matches_rfc5869_case_3() {
        let mut okm = [0u8; 42];
        Hkdf::<Sha256>::new(None, &[0x0b; 22]).expand(&[], &mut okm).unwrap();
        assert_eq!(
            okm.to_vec(),
            unhex("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
        );
    }

    /// RFC 7748 section 5.2 test vector 1 (clamping included).
    #[test]
    fn x25519_matches_rfc7748() {
        let k: [u8; 32] = unhex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4").try_into().unwrap();
        let u: [u8; 32] = unhex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c").try_into().unwrap();
        assert_eq!(x25519(k, u).to_vec(), unhex("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"));
    }

    #[test]
    fn k_is_124_chars_with_version_1() {
        let k = seal_k(&[7u8; 32], &[9u8; 32], &"a".repeat(64), &"b".repeat(64)).unwrap();
        assert_eq!(k.len(), 124);
        assert_eq!(b64::decode(&k).unwrap()[0], K_VERSION);
    }

    /// A small-order client key gives an all-zero shared secret. The spec defines k
    /// for any well-formed client_pk, so the judge still emits it (pinned here so a
    /// change is deliberate); such a k opens with the zero secret. Rejecting
    /// small-order keys belongs where the job is created.
    #[test]
    fn small_order_client_pk_is_sealed_as_specified() {
        let key = [5u8; 32];
        let k = seal_k(&key, &[0u8; 32], &"c".repeat(64), &"d".repeat(64)).unwrap();
        let raw = b64::decode(&k).unwrap();
        let mut sym = [0u8; 32];
        Hkdf::<Sha256>::new(None, &[0u8; 32]).expand(K_INFO, &mut sym).unwrap();
        let opened = ChaCha20Poly1305::new(Key::from_slice(&sym))
            .decrypt(Nonce::from_slice(&raw[33..45]), &raw[45..])
            .unwrap();
        assert_eq!(opened, key.to_vec());
    }

    #[test]
    fn hex_parsing_is_exact() {
        assert!(hex32(&"Ab".repeat(32)).is_some());
        assert!(hex32(&"ab".repeat(31)).is_none());
        assert!(hex32(&("g".to_string() + &"a".repeat(63))).is_none());
        assert!(is_lower_hex64(&"0f".repeat(32)));
        assert!(!is_lower_hex64(&"0F".repeat(32)));
    }
}

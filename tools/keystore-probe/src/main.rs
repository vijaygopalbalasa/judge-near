//! Keystore probe for OutLayer (wasm32-wasip1). It reports which secrets the worker injected
//! into this run as environment variables: their names and the SHA-256 of each value, never
//! the value itself. It also reports the predecessor and signer OutLayer passes in. Used to
//! check a secret's access rule on testnet before the judge relies on it.

use sha2::{Digest, Sha256};
use std::io::Write;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let pred = std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default();
    let sender = std::env::var("NEAR_SENDER_ID").unwrap_or_default();
    let mut secrets: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| !k.starts_with("NEAR_"))
        .map(|(k, v)| (k, hex(&Sha256::digest(v.as_bytes()))))
        .collect();
    secrets.sort();
    let list: Vec<String> = secrets
        .iter()
        .map(|(k, h)| format!("{{\"name\":{},\"sha256\":\"{}\"}}", json_str(k), h))
        .collect();
    let out = format!(
        "{{\"predecessor\":{},\"sender\":{},\"secrets\":[{}]}}",
        json_str(&pred),
        json_str(&sender),
        list.join(",")
    );
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(out.as_bytes());
    let _ = stdout.flush();
}

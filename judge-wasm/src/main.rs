//! Thin wasm32-wasip1 entry point: read all of stdin and the JN_KEY environment
//! variable (set only for sealed jobs, by OutLayer's keystore), evaluate, write the
//! verdict JSON to stdout, flush. No trailing newline. All logic lives in the
//! library, which reads no environment itself.

use std::io::{Read, Write};

fn main() {
    let mut input = Vec::new();
    // An unreadable stdin is treated as empty input, which yields an
    // `invalid_input` verdict rather than a crash.
    if std::io::stdin().read_to_end(&mut input).is_err() {
        input.clear();
    }
    // Unset or not valid Unicode: no key (a sealed job then reports key_missing).
    let jn_key = std::env::var("JN_KEY").ok();
    let out = judge_wasm::run_with_key(&input, jn_key.as_deref());
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(out.as_bytes());
    let _ = handle.flush();
}

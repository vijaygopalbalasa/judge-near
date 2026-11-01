//! Thin wasm32-wasip1 entry point: read all of stdin, evaluate, write the verdict
//! JSON to stdout, flush. No trailing newline. All logic lives in the library.

use std::io::{Read, Write};

fn main() {
    let mut input = Vec::new();
    // An unreadable stdin is treated as empty input, which yields an
    // `invalid_input` verdict rather than a crash.
    if std::io::stdin().read_to_end(&mut input).is_err() {
        input.clear();
    }
    let out = judge_wasm::run(&input);
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    let _ = handle.write_all(out.as_bytes());
    let _ = handle.flush();
}

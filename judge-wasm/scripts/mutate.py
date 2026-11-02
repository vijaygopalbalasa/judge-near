#!/usr/bin/env python3
"""judge-wasm mutation harness. Plants one bug at a time in judge-wasm/src (each bug
is a list of exact (old, new) edits), runs `cargo test`, records whether at least one
test failed, and restores the files. Writes target/mutation-log.md; MUTATION-LOG.md has the
results. Run from anywhere: python3 judge-wasm/scripts/mutate.py"""
import os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")

def m(desc, fname, *edits):
    return (desc, fname, list(edits))

K_BLOCK = ('    if let Some(k) = &verdict.k {\n        s.push_str(",\\"k\\":\\"");\n'
           '        s.push_str(k);\n        s.push(\'"\');\n    }\n')
EH_LINES = ("    // eh = sha256 of the prefix with a closing brace appended.\n"
            "    let mut with_brace = s.clone();\n    with_brace.push('}');\n"
            "    let eh = sha256_hex(with_brace.as_bytes());\n")

MUTATIONS = [
    # ---------------- public mode (as before) ----------------
    m("sha256 hex uppercased", "lib.rs",
      ('const HEX: &[u8; 16] = b"0123456789abcdef";', 'const HEX: &[u8; 16] = b"0123456789ABCDEF";')),
    m("render swaps score and th order", "lib.rs",
      ('s.push_str(",\\"score\\":");\n    push_int(&mut s, verdict.score);\n    s.push_str(",\\"th\\":");\n    push_int(&mut s, verdict.th);',
       's.push_str(",\\"th\\":");\n    push_int(&mut s, verdict.th);\n    s.push_str(",\\"score\\":");\n    push_int(&mut s, verdict.score);')),
    m("eh hashed without the closing brace", "lib.rs",
      ("let mut with_brace = s.clone();\n    with_brace.push('}');\n    let eh = sha256_hex(with_brace.as_bytes());",
       "let with_brace = s.clone();\n    let eh = sha256_hex(with_brace.as_bytes());")),
    m("check_id puts index before kind", "lib.rs",
      ('let mut id = format!("{}#{}", kind, index);', 'let mut id = format!("{}#{}", index, kind);')),
    m("err verdict uses th:0 instead of 100", "lib.rs",
      ("        th: 100,\n        ch: ch.to_string(),", "        th: 0,\n        ch: ch.to_string(),")),
    m("criteria size cap off by one (4097)", "lib.rs",
      ("const MAX_CRITERIA_BYTES: usize = 4_096;", "const MAX_CRITERIA_BYTES: usize = 4_097;")),
    m("deliverable size cap off by one", "lib.rs",
      ("const MAX_DELIVERABLE_BYTES: usize = 16_384;", "const MAX_DELIVERABLE_BYTES: usize = 16_385;")),
    m("length chars counts code points not UTF-16", "lib.rs",
      ("pub(crate) fn utf16_len(s: &str) -> usize {\n    s.encode_utf16().count()\n}",
       "pub(crate) fn utf16_len(s: &str) -> usize {\n    s.chars().count()\n}")),
    m("is_js_space drops U+FEFF", "lib.rs",
      ("| 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF",
       "| 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000")),
    m("is_js_space adds U+0085 (NEL)", "lib.rs",
      ("0x0009 | 0x000A | 0x000B | 0x000C | 0x000D | 0x0020 | 0x00A0 | 0x1680",
       "0x0009 | 0x000A | 0x000B | 0x000C | 0x000D | 0x0020 | 0x0085 | 0x00A0 | 0x1680")),
    m("word_count loses the in_word guard", "lib.rs",
      ("} else if !in_word {\n            count += 1;\n            in_word = true;\n        }",
       "} else {\n            count += 1;\n            in_word = true;\n        }")),
    m("js_typeof makes null -> null not object", "lib.rs",
      ('        Null => "object",\n        Bool(_) => "boolean",\n        Number(_) => "number",',
       '        Null => "null",\n        Bool(_) => "boolean",\n        Number(_) => "number",')),
    m("is_type integer accepts fractional", "lib.rs",
      ("        return matches!(v, serde_json::Value::Number(_))\n            && v.as_f64().map(|x| x.fract() == 0.0).unwrap_or(false);",
       "        return matches!(v, serde_json::Value::Number(_)) && v.as_f64().is_some();")),
    m("whole-word left boundary negation dropped", "lib.rs",
      ("let left_ok = start == 0 || !self.word[start - 1];", "let left_ok = start == 0 || self.word[start - 1];")),
    m("whole-word right boundary negation dropped", "lib.rs",
      ("let right_ok = start + len == n || !self.word[start + len];", "let right_ok = start + len == n || self.word[start + len];")),
    m("KMP restarts at 0 after a match (misses overlaps)", "lib.rs",
      ("q = fail[m - 1]; // keep going: occurrences may overlap", "q = 0; // keep going: occurrences may overlap")),
    m("KMP failure function always 0", "lib.rs", ("            fail[q] = k;", "            fail[q] = 0;")),
    m("empty-term boundary search collapses to one position", "lib.rs",
      ("return (0..=n).any(|i| self.boundary_ok(i, 0));", "return self.boundary_ok(0, 0);")),
    m("MAX_CHECKS raised to 64 (ignores interface cap)", "engine.rs",
      ("const MAX_CHECKS: usize = 16;", "const MAX_CHECKS: usize = 64;")),
    m("http-endpoint added to known kinds", "engine.rs",
      ('const KNOWN_KINDS: [&str; 5] = ["checksum", "schema", "contains", "length", "json"];',
       'const KNOWN_KINDS: [&str; 6] = ["checksum", "schema", "contains", "length", "json", "http-endpoint"];')),
    m("weight default 0 instead of 1", "engine.rs",
      ("            None => 1.0,\n            Some(w) => match w.as_f64() {", "            None => 0.0,\n            Some(w) => match w.as_f64() {")),
    m("passThreshold default 0 instead of 100", "engine.rs",
      ("        None => 100, // omitted: all-must-pass", "        None => 0, // omitted: all-must-pass")),
    m("depth gate off by one (allows 13 levels)", "engine.rs",
      ("const DEPTH: usize = 12;", "const DEPTH: usize = 13;")),
    m("score cap raised from 99 to 100", "engine.rs",
      ("let score = if all_pass { rounded } else { rounded.min(99.0) };", "let score = if all_pass { rounded } else { rounded.min(100.0) };")),
    m("threshold comparison uses > not >=", "engine.rs",
      ("(score_i, score_i >= threshold)", "(score_i, score_i > threshold)")),
    m("checksum comparison inverted", "engine.rs", ("            ctx.dh == expected", "            ctx.dh != expected")),
    m("contains ignores wholeWords (always substring)", "engine.rs",
      ('let whole = params.get("wholeWords") == Some(&Value::Bool(true));', 'let whole = false;\n    let _ = params.get("wholeWords");')),
    m("contains_term shares plain and whole memos on lookup", "engine.rs",
      ("        } else {\n            self.plain_memo.get(term)\n        };", "        } else {\n            self.whole_memo.get(term)\n        };")),
    m("Ctx.json caches the wrong text (parses null)", "engine.rs",
      (".get_or_insert_with(|| serde_json::from_str(text).ok())", '.get_or_insert_with(|| serde_json::from_str("null").ok())')),
    m("json-shape minLength uses UTF-16 not code points", "shape.rs",
      ("            if let Some(s) = v.as_str() {\n                let n = cp_len(s);", "            if let Some(s) = v.as_str() {\n                let n = utf16_len(s);")),
    m("enum number compare by representation (1 != 1.0)", "shape.rs",
      ("            (Some(a), Some(b)) => a == b,\n            (None, None) =>", "            (Some(a), Some(b)) => e.to_string() == v.to_string() && a == b,\n            (None, None) =>")),
    m("domain_of stops stripping leading www.", "shape.rs",
      ('if host.starts_with("www.") && host.split(\'.\').count() > 2 {\n        host["www.".len()..].to_string()\n    } else {\n        host\n    }', "host")),
    m("is_url port length cap off by one (allows 6 digits)", "shape.rs",
      ("if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {",
       "if port.is_empty() || port.len() > 6 || !port.bytes().all(|b| b.is_ascii_digit()) {")),
    # ---------------- sealed mode (section 6.3) ----------------
    m("sealed: k emitted on a failing verdict", "sealed.rs",
      ("    if verdict.pass && verdict.err.is_none() {", "    if verdict.err.is_none() {")),
    m("sealed: k emitted with an err", "sealed.rs",
      ("    if verdict.pass && verdict.err.is_none() {", "    if verdict.pass || verdict.err.is_some() {")),
    m("sealed: sha256(plaintext) not checked against dh", "sealed.rs",
      ("    if sha256_hex(&plaintext) != dh {", "    if false && sha256_hex(&plaintext) != dh {")),
    m("sealed: decrypt failure ignored (raw ciphertext used)", "sealed.rs",
      ("        .decrypt(Nonce::from_slice(nonce), sealed)\n        .ok()?;",
       "        .decrypt(Nonce::from_slice(nonce), sealed)\n        .unwrap_or_else(|_| sealed[..sealed.len() - TAG_LEN].to_vec());")),
    m("sealed: plaintext UTF-8 not enforced (lossy)", "sealed.rs",
      ("    String::from_utf8(plaintext).ok()", "    Some(String::from_utf8_lossy(&plaintext).into_owned())")),
    m("sealed: key_missing reported as bad_delivery", "sealed.rs",
      ('        None => return err_verdict("key_missing", &ch, &dh_out),', '        None => return err_verdict("bad_delivery", &ch, &dh_out),')),
    m("sealed: bad_delivery reported as key_missing", "sealed.rs",
      ('        None => return err_verdict("bad_delivery", &ch, &dh_out),', '        None => return err_verdict("key_missing", &ch, &dh_out),')),
    m("sealed: JN_KEY whitespace trimmed", "sealed.rs",
      ("    let key = match jn_key.filter(|s| is_hex64(s)).and_then(hex32) {", "    let key = match jn_key.map(str::trim).filter(|s| is_hex64(s)).and_then(hex32) {")),
    m("sealed: wrong HKDF info for eph_sk", "sealed.rs",
      ('const K_EPH_INFO: &[u8] = b"judge-near-k-eph-v1";', 'const K_EPH_INFO: &[u8] = b"judge-near-k-eph-v2";')),
    m("sealed: wrong HKDF info for sym", "sealed.rs",
      ('const K_INFO: &[u8] = b"judge-near-k-v1";', 'const K_INFO: &[u8] = b"judge-near-k-v0";')),
    m("sealed: nonce not bound to client_pk, ch, dh", "sealed.rs",
      ("    from_key.expand(&bound_info(K_NONCE_INFO, client_pk, ch, dh), &mut nonce).ok()?;", "    from_key.expand(K_NONCE_INFO, &mut nonce).ok()?;")),
    m("sealed: HKDF for K uses a salt", "sealed.rs",
      ("    let from_key = Hkdf::<Sha256>::new(None, key);", '    let from_key = Hkdf::<Sha256>::new(Some(b"judge-near"), key);')),
    m("sealed: AAD added when sealing K", "sealed.rs",
      (".encrypt(Nonce::from_slice(&nonce), key.as_slice())",
       ".encrypt(Nonce::from_slice(&nonce), chacha20poly1305::aead::Payload { msg: key.as_slice(), aad: ch.as_bytes() })")),
    m("sealed: k carries client_pk instead of eph_pk", "sealed.rs",
      ("    out.extend_from_slice(&x25519(eph_sk, X25519_BASEPOINT_BYTES));", "    out.extend_from_slice(client_pk);")),
    m("sealed: k version byte 0x02", "sealed.rs",
      ("const K_VERSION: u8 = 0x01;", "const K_VERSION: u8 = 0x02;")),
    m("sealed: client_pk uppercase accepted", "sealed.rs",
      ("        .filter(|s| is_lower_hex64(s))\n        .and_then(hex32);", "        .filter(|s| is_hex64(s))\n        .and_then(hex32);")),
    m("sealed: deliverable and deliverable_ct both accepted", "sealed.rs",
      ('        (Some(c), Some(d), Some(p), Some(t)) if !obj.contains_key("deliverable") => (c, d, p, t),', "        (Some(c), Some(d), Some(p), Some(t)) => (c, d, p, t),")),
    m("sealed: deliverable_ct size cap off by one", "sealed.rs",
      ("const MAX_CT_BYTES: usize = 21_884;", "const MAX_CT_BYTES: usize = 21_885;")),
    m("sealed: err verdicts report sha256(\"\") as dh", "sealed.rs",
      ('    let dh_out = dh_in.map_or_else(|| sha256_hex(b""), str::to_string);', '    let dh_out = sha256_hex(b"");')),
    m("sealed: mode chosen by a missing deliverable", "lib.rs",
      ('    if obj.contains_key("deliverable_ct") {', '    if !obj.contains_key("deliverable") {')),
    m("sealed: eh does not cover k", "lib.rs",
      (K_BLOCK + EH_LINES, EH_LINES + K_BLOCK)),
    m("sealed: key order changed (k right after dh)", "lib.rs",
      (K_BLOCK, ""),
      ('    s.push_str(&verdict.dh);\n', '    s.push_str(&verdict.dh);\n    if let Some(k) = &verdict.k {\n        s.push_str("\\",\\"k\\":\\"");\n        s.push_str(k);\n    }\n')),
    m("sealed: base64 trailing bits unchecked", "b64.rs",
      ("            2 if n & 0xffff == 0 => out.push((n >> 16) as u8),", "            2 => out.push((n >> 16) as u8),")),
]

def run_tests():
    p = subprocess.run(["cargo", "test"], cwd=ROOT, capture_output=True, text=True)
    out = p.stdout + p.stderr
    failed = re.findall(r"^test (\S+) \.\.\. FAILED", out, re.M)
    compile_err = bool(re.search(r"^error(\[|:)", out, re.M)) and "test result:" not in out
    return p.returncode, failed, compile_err

def main():
    rc, failed, _ = run_tests()
    if rc != 0:
        sys.exit(f"suite is not green before mutating: {failed}")
    results = []
    for desc, fname, edits in MUTATIONS:
        path = os.path.join(SRC, fname)
        original = open(path).read()
        mutated, line = original, 0
        for i, (old, new) in enumerate(edits):
            if mutated.count(old) != 1:
                line = -1
                break
            if i == 0:
                line = original[: original.index(old)].count("\n") + 1
            mutated = mutated.replace(old, new, 1)
        if line < 0:
            results.append((desc, fname, 0, "ANCHOR_MISS", []))
            print(f"ANCHOR_MISS  src/{fname}  {desc}")
            continue
        try:
            open(path, "w").write(mutated)
            rc, failed, compile_err = run_tests()
        finally:
            open(path, "w").write(original)
        status = "CAUGHT" if rc != 0 else "ESCAPED"
        how = failed[0] if failed else ("did not compile" if compile_err else "-")
        results.append((desc, fname, line, status, [how]))
        print(f"{status:8} src/{fname}:{line}  {desc}  [{how}]")
        sys.stdout.flush()

    rc, failed, _ = run_tests()
    print("\nafter restoring every file, suite green:", rc == 0 and not failed)

    sealed_n = sum(1 for r in results if r[0].startswith("sealed"))
    caught = sum(1 for r in results if r[3] == "CAUGHT")
    lines = ["# Mutation log", "",
             "Each bug was planted alone in judge-wasm/src, the whole suite run (`cargo test`),",
             "then every file restored. CAUGHT means at least one test failed. The suite is",
             "green before and after the run. Rows marked `sealed` target the sealed-job path",
             "(docs/interface.md section 6.3).", "",
             "| # | Planted bug | Location | Result | First failing test |",
             "|---|-------------|----------|--------|--------------------|"]
    for i, (desc, fname, line, status, how) in enumerate(results, 1):
        loc = f"src/{fname}:{line}" if line else f"src/{fname}"
        lines.append(f"| {i} | {desc} | {loc} | {status} | {how[0] if how else '-'} |")
    lines += ["", f"Total: {len(results)} mutations ({sealed_n} on the sealed path), {caught} caught, "
              f"{sum(1 for r in results if r[3] == 'ESCAPED')} escaped, "
              f"{sum(1 for r in results if r[3] == 'ANCHOR_MISS')} anchor misses.", ""]
    os.makedirs(os.path.join(ROOT, "target"), exist_ok=True)
    open(os.path.join(ROOT, "target", "mutation-log.md"), "w").write("\n".join(lines) + "\n")
    print(f"wrote target/mutation-log.md: {caught}/{len(results)} caught, {sealed_n} on the sealed path")

if __name__ == "__main__":
    main()

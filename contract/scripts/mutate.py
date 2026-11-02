#!/usr/bin/env python3
"""Mutation testing harness for the Judge-on-NEAR escrow.

Plants one bug at a time into src/lib.rs, runs `cargo test --lib`, records whether the suite caught
it (and which tests), then restores the file. Prints a table and writes target/mutation-results-<tag>.json.
Run from anywhere: python3 contract/scripts/mutate.py [M01-M26] [--out=tag]. MUTATION-LOG.md has the results.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

CONTRACT = Path(__file__).resolve().parent.parent
SRC = CONTRACT / "src" / "lib.rs"

# (id, description, old_stripped, new_stripped). Single-line, matched on stripped content.
SINGLE = [
    ("M01", "create_job: provider!=client guard inverted",
     'require!(provider != client, "provider must differ from client");',
     'require!(provider == client, "provider must differ from client");'),
    ("M02", "create_job: criteria size off-by-one (<= -> <)",
     'criteria.len() <= MAX_CRITERIA_BYTES,',
     'criteria.len() < MAX_CRITERIA_BYTES,'),
    ("M03", "create_job: expiry future off-by-one (> -> >=)",
     'require!(expires > now, "expires_at_ns must be in the future");',
     'require!(expires >= now, "expires_at_ns must be in the future");'),
    ("M04", "charge_storage: deposit floor removed (>=cost -> >=0)",
     'attached >= cost,',
     'attached >= NearToken::from_yoctonear(0),'),
    ("M05", "charge_storage: refund never sent",
     'if refund.as_yoctonear() > 0 {',
     'if false {'),
    ("M06", "fund: client guard inverted",
     'env::predecessor_account_id() == job.client,',
     'env::predecessor_account_id() != job.client,'),
    ("M07", "fund: Open-state guard inverted",
     'require!(job.state == JobState::Open, "job is not Open");',
     'require!(job.state != JobState::Open, "job is not Open");'),
    ("M08", "fund: zero-deposit guard removed",
     'require!(amount.as_yoctonear() > 0, "attach the escrow amount");',
     'require!(amount.as_yoctonear() >= 0, "attach the escrow amount");'),
    ("M09", "fund: does not set Funded state",
     'job.state = JobState::Funded;',
     'job.state = JobState::Open;'),
    ("M10", "fund: does not store escrow amount",
     'job.amount = amount;',
     'job.amount = NearToken::from_yoctonear(0);'),
    ("M11", "submit: provider guard inverted",
     'env::predecessor_account_id() == job.provider,',
     'env::predecessor_account_id() != job.provider,'),
    ("M12", "submit: Funded-state guard inverted",
     'require!(job.state == JobState::Funded, "job is not Funded");',
     'require!(job.state != JobState::Funded, "job is not Funded");'),
    ("M13", "submit: expiry off-by-one (< -> <=)",
     'env::block_timestamp() < job.expires_at_ns,',
     'env::block_timestamp() <= job.expires_at_ns,'),
    ("M14", "submit: deliverable size off-by-one (<= -> <)",
     'deliverable.len() <= MAX_DELIVERABLE_BYTES,',
     'deliverable.len() < MAX_DELIVERABLE_BYTES,'),
    ("M15", "submit: does not set Submitted state",
     'job.state = JobState::Submitted;',
     'job.state = JobState::Funded;'),
    ("M16", "submit/submit_sealed: does not store deliverable hash",
     'job.dh = dh.to_string();',
     'job.dh = String::new();'),
    ("M17", "request_ruling: Submitted-state guard inverted",
     'require!(job.state == JobState::Submitted, "job is not Submitted");',
     'require!(job.state != JobState::Submitted, "job is not Submitted");'),
    ("M18", "request_ruling: attempt not incremented",
     'job.attempt += 1;',
     'job.attempt += 0;'),
    ("M19", "request_ruling: does not set Ruling state",
     'job.state = JobState::Ruling;',
     'job.state = JobState::Submitted;'),
    ("M20", "request_ruling: minimum-gas guard removed",
     'env::prepaid_gas() >= MIN_PREPAID_GAS,',
     'env::prepaid_gas() >= Gas::from_tgas(0),'),
    ("M21", "request_ruling: minimum ruling deposit guard removed",
     'deposit >= self.min_ruling_deposit,',
     'deposit >= NearToken::from_yoctonear(0),'),
    ("M22", "request_ruling: wrong payer_account_id (not caller)",
     'Some(payer),',
     'Some(self.outlayer.clone()),'),
    ("M23", "request_ruling: public input_data criteria set to deliverable",
     '"criteria": job.criteria.as_str(),',
     '"criteria": job.deliverable.as_str(),'),
    ("M25", "request_ruling: build_target dropped (None)",
     'build_target: Some(self.build_target.clone()),',
     'build_target: None,'),
    ("M26", "on_ruling: pass guard inverted",
     'if !v.pass {',
     'if v.pass {'),
    ("M27", "on_ruling: pass pays client instead of provider",
     'Promise::new(job.provider.clone())',
     'Promise::new(job.client.clone())'),
    ("M28", "parse_verdict: version check inverted (!= -> ==)",
     'if v.v != VERDICT_VERSION {',
     'if v.v == VERDICT_VERSION {'),
    ("M29", "parse_verdict: criteria-hash check dropped",
     'if v.ch != want_ch || v.dh != want_dh {',
     'if v.dh != want_dh {'),
    ("M30", "parse_verdict: deliverable-hash check dropped",
     'if v.ch != want_ch || v.dh != want_dh {',
     'if v.ch != want_ch {'),
    ("M31", "on_ruling: attempt guard dropped",
     'if job.state != JobState::Ruling || job.attempt != attempt {',
     'if job.state != JobState::Ruling {'),
    ("M32", "on_ruling: state guard dropped",
     'if job.state != JobState::Ruling || job.attempt != attempt {',
     'if job.attempt != attempt {'),
    ("M33", "on_ruling: verdict size cap raised (oversized accepted)",
     'const MAX_VERDICT_BYTES: usize = 1_024;',
     'const MAX_VERDICT_BYTES: usize = 100_000;'),
    ("M35", "claim_refund: Funded expiry off-by-one (>= -> >)",
     'JobState::Funded => now >= job.expires_at_ns,',
     'JobState::Funded => now > job.expires_at_ns,'),
    ("M36", "claim_refund: grace period dropped for Submitted",
     'JobState::Submitted => now >= job.expires_at_ns.saturating_add(GRACE_NS),',
     'JobState::Submitted => now >= job.expires_at_ns,'),
    ("M37", "claim_refund: grace boundary off-by-one (>= -> >)",
     'JobState::Submitted => now >= job.expires_at_ns.saturating_add(GRACE_NS),',
     'JobState::Submitted => now > job.expires_at_ns.saturating_add(GRACE_NS),'),
    ("M38", "claim_refund: refundable default true (wrong states allowed)",
     '_ => false,',
     '_ => true,'),
    ("M40", "claim_refund: Submitted refundable at plain expiry (the griefing bug)",
     'JobState::Funded => now >= job.expires_at_ns,',
     'JobState::Funded | JobState::Submitted => now >= job.expires_at_ns,'),
    ("M41", "request_ruling: minimum deposit boundary off-by-one (>= -> >)",
     'deposit >= self.min_ruling_deposit,',
     'deposit > self.min_ruling_deposit,'),
    ("M42", "request_ruling: third party allowed (party check removed)",
     'payer == job.client || payer == job.provider,',
     'true,'),
    ("M43", "request_ruling: provider excluded from requesting",
     'payer == job.client || payer == job.provider,',
     'payer == job.client,'),
    ("M44", "request_ruling: client excluded from requesting",
     'payer == job.client || payer == job.provider,',
     'payer == job.provider,'),
    ("M45", "new: zero min_ruling_deposit accepted",
     'min_ruling_deposit.0 > 0,',
     'min_ruling_deposit.0 >= 0,'),
    ("M46", "resource limits: instructions regress to OutLayer's 1B default",
     'const JUDGE_MAX_INSTRUCTIONS: u64 = 50_000_000_000;',
     'const JUDGE_MAX_INSTRUCTIONS: u64 = 1_000_000_000;'),
    ("M47", "get_judge: reports a wrong min_ruling_deposit",
     'min_ruling_deposit: U128(self.min_ruling_deposit.as_yoctonear()),',
     'min_ruling_deposit: U128(0),'),
    ("M48", "new: judge_url https check removed",
     'judge_url.starts_with("https://"),',
     'true,'),
    ("M49", "new: judge_hash hex check removed",
     'is_64_lower_hex(&judge_hash),',
     'true,'),
    ("M50", "new: stores a different ruling floor than the init value",
     'min_ruling_deposit: NearToken::from_yoctonear(min_ruling_deposit.0),',
     'min_ruling_deposit: NearToken::from_yoctonear(1),'),
    ("M51", "resource limits: memory drifts from the spec (64 -> 16 MB)",
     'const JUDGE_MAX_MEMORY_MB: u32 = 64;',
     'const JUDGE_MAX_MEMORY_MB: u32 = 16;'),
    ("M52", "create_job: client_pk lowercase-hex check dropped",
     'is_64_lower_hex(pk) && hex::decode_to_slice(pk, &mut key).is_ok(),',
     'hex::decode_to_slice(pk, &mut key).is_ok(),'),
    ("M53", "create_job: small-order client_pk accepted",
     'require!(!is_small_order(&key), "client_pk is a small-order X25519 point");',
     'require!(true, "client_pk is a small-order X25519 point");'),
    ("M54", "is_small_order: last-byte 0x7f mask dropped",
     '.any(|e| pk[..31] == e[..31] && (pk[31] & 0x7f) == e[31])',
     '.any(|e| pk[..31] == e[..31] && pk[31] == e[31])'),
    ("M55", "blocklist: an order-8 entry corrupted (first byte e0 -> e1)",
     '0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4,',
     '0xe1, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4,'),
    ("M56", "submit: sealed job accepted by plain submit",
     'require!(job.client_pk.is_none(), "job is sealed: use submit_sealed");',
     'require!(true, "job is sealed: use submit_sealed");'),
    ("M57", "submit_sealed: public job accepted",
     'require!(job.client_pk.is_some(), "job is not sealed: use submit");',
     'require!(true, "job is not sealed: use submit");'),
    ("M58", "submit_sealed: ciphertext size off-by-one (<= -> <)",
     'deliverable_ct.len() <= MAX_DELIVERABLE_CT_BYTES,',
     'deliverable_ct.len() < MAX_DELIVERABLE_CT_BYTES,'),
    ("M59", "submit_sealed: dh format check dropped",
     'require!(is_64_lower_hex(&dh), "dh must be 64 lowercase hex characters");',
     'require!(true, "dh must be 64 lowercase hex characters");'),
    ("M60", "submit_sealed: k storage reserve not charged",
     'charge_storage(before, &provider, K_STORAGE_RESERVE_BYTES);',
     'charge_storage(before, &provider, 0);'),
    ("M61", "k reserve constant too small (length prefix forgotten)",
     'const K_STORAGE_RESERVE_BYTES: u64 = 4 + K_B64_LEN as u64;',
     'const K_STORAGE_RESERVE_BYTES: u64 = K_B64_LEN as u64;'),
    ("M62", "sealed input: client_pk key misnamed",
     '"client_pk": client_pk,',
     '"client_key": client_pk,'),
    ("M63", "sealed input: deliverable_ct sent under the deliverable key",
     '"deliverable_ct": &job.deliverable_ct,',
     '"deliverable": &job.deliverable_ct,'),
    ("M64", "secrets_ref names the client instead of the provider",
     'account_id: snapshot.provider.clone(),',
     'account_id: snapshot.client.clone(),'),
    ("M65", "secrets profile uses 15 hex instead of 16",
     'format!("jn-{}-{}", &h[..16], job_id)',
     'format!("jn-{}-{}", &h[..15], job_id)'),
    ("M66", "sealed job sends the public input",
     'sealed_input(&snapshot, client_pk),',
     'public_input(&snapshot),'),
    ("M67", "get_secrets_profile answers for public jobs",
     'job.client_pk.as_ref()?;',
     'let _ = &job.client_pk;'),
    ("M68", "key_missing rule removed (refunds instead)",
     'if sealed && v.err.as_deref() == Some("key_missing") {',
     'if false {'),
    ("M69", "key_missing rule applied to public jobs too",
     'if sealed && v.err.as_deref() == Some("key_missing") {',
     'if v.err.as_deref() == Some("key_missing") {'),
    ("M70", "sealed pass accepts any k without validation",
     'match v.k.filter(|k| is_valid_k(k)) {',
     'match v.k {'),
    ("M71", "is_valid_k: version byte check dropped",
     '.is_ok_and(|raw| raw.len() == K_RAW_LEN && raw[0] == K_VERSION_BYTE)',
     '.is_ok_and(|raw| raw.len() == K_RAW_LEN)'),
    ("M72", "is_valid_k: URL-safe alphabet instead of standard",
     '&& STANDARD',
     '&& near_sdk::base64::engine::general_purpose::URL_SAFE'),
    ("M73", "sealed pass does not store k",
     'stored.k = k.clone();',
     'stored.k = None;'),
    ("M74", "sealed pass leaves k out of ruling_applied",
     'event_ruling_applied(job_id, true, v.score, &v.eh, k.as_deref());',
     'event_ruling_applied(job_id, true, v.score, &v.eh, None);'),
    ("M75", "sealed pass skips the k requirement",
     'let k = if sealed {',
     'let k = if false {'),
    ("M76", "get_job reports sealed jobs as public",
     'sealed: j.client_pk.is_some(),',
     'sealed: false,'),
    ("M77", "job_created event drops the sealed flag",
     'event_job_created(id, &client, &provider, &ch, expires, client_pk.is_some());',
     'event_job_created(id, &client, &provider, &ch, expires, false);'),
    ("M78", "sealed input sends ch as dh",
     '"dh": &job.dh,',
     '"dh": &job.ch,'),
    ("M79", "secrets_ref profile names the wrong job",
     'profile: secrets_profile(&env::current_account_id(), job_id),',
     'profile: secrets_profile(&env::current_account_id(), job_id + 1),'),
    ("M80", "claim_refund: Ruling refundable once the grace window ends (the v2 refund race)",
     '.saturating_add(RULING_STALE_NS)',
     '.saturating_add(0)'),
    ("M81", "claim_refund: stale-window boundary off-by-one (>= -> >)",
     'now >= job',
     'now > job'),
    ("M82", "request_ruling: no deadline at the end of the grace window",
     'env::block_timestamp() < job.expires_at_ns.saturating_add(GRACE_NS),',
     'true,'),
    ("M83", "request_ruling: grace deadline off-by-one (< -> <=)",
     'env::block_timestamp() < job.expires_at_ns.saturating_add(GRACE_NS),',
     'env::block_timestamp() <= job.expires_at_ns.saturating_add(GRACE_NS),'),
]

# Two-line mutations: (id, desc, anchor_stripped, target_old_stripped, target_new_stripped).
# Used where the target line is not unique on its own but is unique within a few lines of its anchor.
TWO_LINE = [
    ("M24", "request_ruling: WasmUrl hash set to url",
     'let source = ExecutionSource::WasmUrl {',
     'hash: self.judge_hash.clone(),',
     'hash: self.judge_url.clone(),'),
    ("M34", "on_ruling: Failed branch pays out instead of back to Submitted",
     'Err(PromiseError::Failed) => {',
     'self.set_state(job_id, JobState::Submitted);',
     'self.set_state(job_id, JobState::Completed);'),
]


def run_tests():
    r = subprocess.run(["cargo", "test", "--lib"], cwd=CONTRACT,
                       capture_output=True, text=True)
    out = r.stdout + "\n" + r.stderr
    compile_err = bool(re.search(r"^error(\[|:)", out, re.M)) and "test result:" not in out
    m = re.search(r"test result: (ok|FAILED)\. (\d+) passed; (\d+) failed", out)
    failed_names = sorted(set(re.findall(
        r"test (tests::\w+)(?: - should panic)? \.\.\. FAILED", out)))
    passed = int(m.group(2)) if m else -1
    failed = int(m.group(3)) if m else -1
    return {"compile_error": compile_err, "passed": passed, "failed": failed,
            "failed_names": failed_names}


def apply_single(content, old_s, new_s):
    lines = content.split("\n")
    idxs = [i for i, l in enumerate(lines) if l.strip() == old_s]
    if len(idxs) != 1:
        return None, None, len(idxs)
    i = idxs[0]
    indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
    lines[i] = indent + new_s
    return "\n".join(lines), i + 1, 1


def apply_two_line(content, anchor_s, old_s, new_s):
    lines = content.split("\n")
    anchor = [i for i, l in enumerate(lines) if l.strip() == anchor_s]
    if len(anchor) != 1:
        return None, None
    for j in range(anchor[0] + 1, min(anchor[0] + 7, len(lines))):
        if lines[j].strip() == old_s:
            indent = lines[j][: len(lines[j]) - len(lines[j].lstrip())]
            lines[j] = indent + new_s
            return "\n".join(lines), j + 1
    return None, None


def main():
    lo, hi, out_tag = "M00", "M99", "all"
    for a in sys.argv[1:]:
        if re.fullmatch(r"M\d\d-M\d\d", a):
            lo, hi = a.split("-")
        elif a.startswith("--out="):
            out_tag = a.split("=", 1)[1]
    orig = SRC.read_text()
    results = []
    try:
        all_muts = [(mid, desc, "single", old, new, None) for (mid, desc, old, new) in SINGLE]
        all_muts += [(mid, desc, "two", old, new, anchor)
                     for (mid, desc, anchor, old, new) in TWO_LINE]
        all_muts.sort(key=lambda t: t[0])
        all_muts = [t for t in all_muts if lo <= t[0] <= hi]
        for item in all_muts:
            mid, desc, kind = item[0], item[1], item[2]
            if kind == "single":
                mutated, lineno, n = apply_single(orig, item[3], item[4])
                if mutated is None:
                    results.append({"id": mid, "desc": desc, "status": "ANCHOR_ERROR",
                                    "occurrences": n})
                    print(f"{mid}: ANCHOR_ERROR (found {n} occurrences)")
                    continue
            else:
                mutated, lineno = apply_two_line(orig, item[5], item[3], item[4])
                if mutated is None:
                    results.append({"id": mid, "desc": desc, "status": "ANCHOR_ERROR"})
                    print(f"{mid}: ANCHOR_ERROR")
                    continue
            SRC.write_text(mutated)
            res = run_tests()
            SRC.write_text(orig)
            if res["compile_error"]:
                status = "COMPILE_ERROR"
            elif res["failed"] > 0:
                status = "CAUGHT"
            else:
                status = "SURVIVED"
            results.append({"id": mid, "desc": desc, "line": lineno, "status": status,
                            "failed": res["failed"], "failed_names": res["failed_names"]})
            tag = {"CAUGHT": "caught", "SURVIVED": "SURVIVED!!",
                   "COMPILE_ERROR": "compile-error"}[status]
            print(f"{mid} L{lineno}: {tag} ({res['failed']} failing) {desc}")
            if status == "CAUGHT":
                print("      by: " + ", ".join(res["failed_names"][:4]))
    finally:
        SRC.write_text(orig)
    out = CONTRACT / "target" / f"mutation-results-{out_tag}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(results, indent=2))
    print(f"results written to {out.relative_to(CONTRACT)}")
    caught = sum(1 for r in results if r.get("status") == "CAUGHT")
    survived = [r["id"] for r in results if r.get("status") != "CAUGHT"]
    print(f"\nSUMMARY: {caught}/{len(results)} caught. Problems: {survived}")


if __name__ == "__main__":
    main()

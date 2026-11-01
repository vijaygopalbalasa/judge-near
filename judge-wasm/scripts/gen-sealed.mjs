// Generate judge-wasm/vectors/sealed.json: known-answer vectors for sealed jobs
// (docs/interface.md section 6.3). Expected verdicts come from an independent
// pipeline written here in JavaScript: Node built-in crypto (scripts/sealed.mjs)
// for decryption and for sealing k, and Judge Protocol's JS engine for the checks,
// exactly as scripts/gen-parity.mjs uses it. It shares no code with the Rust judge.
//
// Every key below is a TEST FIXTURE derived from a fixed public seed string. None of
// them protects anything.
//
// Run: node scripts/gen-sealed.mjs   (from judge-wasm/; same JUDGE_PROTOCOL_DIR rule
// as gen-parity.mjs)

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aeadOpen, decryptDeliverable, encryptDeliverable, openK, publicFromSecret, sealK } from "./sealed.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS_ROOT = path.join(
  process.env.JUDGE_PROTOCOL_DIR ?? path.resolve(HERE, "..", "..", "..", "judge-protocol"),
  "judge-service",
);
const { validateCriteria, runAllChecks } = await import(`${JS_ROOT}/src/checkers/index.js`);

const MAX_CRITERIA = 4096;
const MAX_DELIVERABLE = 16384;
const MAX_CT = 21884; // base64 length of nonce + 16384 bytes + tag
const LOWER_HEX64 = /^[0-9a-f]{64}$/;
const ANY_HEX64 = /^[0-9a-fA-F]{64}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const sha256Raw = (b) => crypto.createHash("sha256").update(b).digest();
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const bytes = (s) => Buffer.byteLength(s, "utf8");

// ---- test fixtures (fixed seeds; public on purpose) ----
const seed = (label) => sha256Raw(Buffer.from(`judge-near sealed test ${label}`, "utf8"));
const TEST_K = seed("K 1");
const TEST_K_OTHER = seed("K 2");
const TEST_CLIENT_SK = seed("client sk 1");
const TEST_CLIENT_PK = publicFromSecret(TEST_CLIENT_SK).toString("hex");

// ---- the reference pipeline ----
function buildVerdict(f) {
  const o = { v: 1, pass: f.pass, score: f.score, th: f.th, ch: f.ch, dh: f.dh, checks: f.checks };
  if (f.err) o.err = f.err;
  if (f.k) o.k = f.k;
  const s = JSON.stringify(o);
  return s.slice(0, -1) + `,"eh":"${sha256(s)}"}`;
}
const errVerdict = (code, ch, dh) => buildVerdict({ pass: false, score: 0, th: 100, ch, dh, checks: [], err: code });

/** Canonical RFC 4648 standard base64 (padding, no whitespace, zero trailing bits), or null. */
function canonicalBase64(s) {
  if (!B64.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return b.toString("base64") === s ? b : null;
}

function interfaceInvalid(parsed) {
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.checks)) {
    if (parsed.checks.some((c) => c && c.kind === "http-endpoint")) return true;
    if (parsed.checks.length > 16) return true;
  }
  return !validateCriteria(parsed).valid;
}

/** The public pipeline from its size gate on, over (criteria text, deliverable bytes). */
async function publicPipeline(criteria, deliverable) {
  const ch = sha256(Buffer.from(criteria, "utf8"));
  const dh = sha256(deliverable);
  const err = (code) => ({ pass: false, score: 0, th: 100, ch, dh, checks: [], err: code });
  if (bytes(criteria) > MAX_CRITERIA || deliverable.length > MAX_DELIVERABLE) return err("too_large");
  let parsed;
  try { parsed = JSON.parse(criteria); } catch { return err("invalid_criteria"); }
  if (interfaceInvalid(parsed)) return err("invalid_criteria");
  if (parsed.checks.some((c) => c && c.kind === "http-endpoint")) throw new Error("probe kind reached the engine");
  const r = await runAllChecks(parsed, { content: Buffer.from(deliverable) });
  const checks = r.results.map((x, i) => ({ id: `${parsed.checks[i].kind}#${i}`, ok: x.pass }));
  return { pass: r.pass, score: r.score, th: r.threshold, ch, dh, checks };
}

/** The verdict a correct judge prints for a sealed stdin and JN_KEY (or null). */
async function expectedSealed(stdin, jnKey) {
  let obj;
  try { obj = JSON.parse(stdin); } catch { return errVerdict("invalid_input", sha256(""), sha256("")); }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return errVerdict("invalid_input", sha256(""), sha256(""));
  }
  if (!Object.hasOwn(obj, "deliverable_ct")) throw new Error("not a sealed stdin");
  const criteria = typeof obj.criteria === "string" ? obj.criteria : null;
  const ch = sha256(Buffer.from(criteria ?? "", "utf8"));
  const dhIn = typeof obj.dh === "string" && LOWER_HEX64.test(obj.dh) ? obj.dh : null;
  const err = (code) => errVerdict(code, ch, dhIn ?? sha256(""));
  const pkOk = typeof obj.client_pk === "string" && LOWER_HEX64.test(obj.client_pk);
  if (criteria === null || typeof obj.deliverable_ct !== "string" || Object.hasOwn(obj, "deliverable") || dhIn === null || !pkOk) {
    return err("invalid_input");
  }
  if (bytes(criteria) > MAX_CRITERIA || bytes(obj.deliverable_ct) > MAX_CT) return err("too_large");
  if (typeof jnKey !== "string" || !ANY_HEX64.test(jnKey)) return err("key_missing");
  const K = Buffer.from(jnKey, "hex");
  const raw = canonicalBase64(obj.deliverable_ct);
  if (raw === null || raw.length < 28) return err("bad_delivery");
  let plaintext;
  try { plaintext = aeadOpen(K, raw.subarray(0, 12), raw.subarray(12)); } catch { return err("bad_delivery"); }
  if (sha256(plaintext) !== dhIn) return err("bad_delivery");
  try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext); } catch { return err("bad_delivery"); }
  const f = await publicPipeline(criteria, plaintext);
  if (f.pass) f.k = sealK(K, obj.client_pk, f.ch, f.dh);
  return buildVerdict(f);
}

// ---- cases ----
const cases = [];
/** A sealed stdin for `plaintext` under key `K`, with optional field overrides. */
function sealed(name, criteria, plaintext, { K = TEST_K, jnKey = TEST_K.toString("hex"), set = {}, del = [], ct } = {}) {
  const crit = typeof criteria === "string" ? criteria : JSON.stringify(criteria);
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8");
  const nonce = sha256Raw(Buffer.from(`judge-near sealed test nonce ${name}`, "utf8")).subarray(0, 12);
  const C = encryptDeliverable(K, pt, nonce);
  const obj = { criteria: crit, deliverable_ct: ct ? ct(C) : C, dh: sha256(pt), client_pk: TEST_CLIENT_PK, ...set };
  for (const k of del) delete obj[k];
  cases.push({ name, stdin: JSON.stringify(obj), jnKey, pt });
}
/** Re-encode C after changing its decoded bytes. */
const tamper = (fn) => (C) => { const b = Buffer.from(C, "base64"); fn(b); return b.toString("base64"); };

const K_HEX = TEST_K.toString("hex");
const TEXT = "Paid in USDC on Arc for the agreed work, delivered in full.";
const LEN1 = { checks: [{ kind: "length", params: { min: 1 } }] };
const TWO = { passThreshold: 100, checks: [{ kind: "length", params: { min: 3, max: 200, unit: "words" } }, { kind: "contains", params: { all: ["USDC", "Arc"], wholeWords: true } }] };

// passes (k present)
sealed("pass: one length check", LEN1, TEXT);
sealed("pass: length words + contains wholeWords", TWO, TEXT);
sealed("pass: threshold 50 with one failing check", { passThreshold: 50, checks: [{ kind: "contains", params: { all: ["USDC"] } }, { kind: "contains", params: { all: ["Solana"] } }] }, TEXT);
sealed("pass: uppercase JN_KEY hex is accepted", LEN1, TEXT, { jnKey: K_HEX.toUpperCase() });
sealed("pass: an extra unknown stdin field is tolerated", LEN1, TEXT, { set: { note: "ignored" } });
sealed("pass: max-size plaintext of 16384 bytes", { checks: [{ kind: "length", params: { min: 16384, max: 16384, unit: "chars" } }] }, "a".repeat(MAX_DELIVERABLE));
sealed("pass: Unicode plaintext (emoji, combining mark, CJK)", { checks: [{ kind: "length", params: { min: 5, unit: "chars" } }, { kind: "contains", params: { all: ["中文", "café"], wholeWords: true } }] }, "Résumé \u{1F600} café café 中文 à la carte");
sealed("pass: JSON plaintext with a json shape", { checks: [{ kind: "json", params: { shape: { type: "object", required: ["id", "tags"], properties: { id: { type: "integer", minimum: 1 }, tags: { type: "array", minItems: 2, items: { type: "string" } } } } } }] }, JSON.stringify({ id: 7, tags: ["a", "é"] }));
sealed("pass: checksum over the plaintext bytes", { checks: [{ kind: "checksum", params: { sha256: sha256(Buffer.from(TEXT, "utf8")) } }] }, TEXT);
{
  // The longest legal verdict: k plus 16 checks with 8-character kinds, 15 failing.
  const checks = Array.from({ length: 15 }, () => ({ kind: "checksum", params: { sha256: sha256("x") }, weight: 0.5 }));
  checks.push({ kind: "contains", params: { all: [] }, weight: 1000 });
  sealed("pass: longest verdict (16 checks, 15 failing, th 99)", { passThreshold: 99, checks }, TEXT);
}
// fails (no k)
sealed("fail: a missing term", { checks: [{ kind: "contains", params: { all: ["Solana"] } }] }, TEXT);
sealed("fail: one of two checks at threshold 100 (score 50)", { checks: [{ kind: "contains", params: { all: ["USDC"] } }, { kind: "contains", params: { all: ["Solana"] } }] }, TEXT);
sealed("fail: invalid criteria after a good decrypt", { checks: [] }, TEXT);
sealed("fail: criteria not JSON after a good decrypt", "not json", TEXT);
sealed("fail: plaintext of 16385 bytes is too_large after decrypt", LEN1, "a".repeat(MAX_DELIVERABLE + 1));
// key_missing
sealed("key_missing: JN_KEY absent", LEN1, TEXT, { jnKey: null });
sealed("key_missing: JN_KEY of 63 hex", LEN1, TEXT, { jnKey: K_HEX.slice(1) });
sealed("key_missing: JN_KEY with a non-hex character", LEN1, TEXT, { jnKey: K_HEX.slice(1) + "g" });
sealed("key_missing: JN_KEY with a trailing newline", LEN1, TEXT, { jnKey: K_HEX + "\n" });
sealed("key_missing: JN_KEY empty", LEN1, TEXT, { jnKey: "" });
// bad_delivery
sealed("bad_delivery: wrong key", LEN1, TEXT, { jnKey: TEST_K_OTHER.toString("hex") });
sealed("bad_delivery: tampered ciphertext byte", LEN1, TEXT, { ct: tamper((b) => { b[14] ^= 1; }) });
sealed("bad_delivery: tampered tag byte", LEN1, TEXT, { ct: tamper((b) => { b[b.length - 1] ^= 0x80; }) });
sealed("bad_delivery: tampered nonce byte", LEN1, TEXT, { ct: tamper((b) => { b[0] ^= 1; }) });
sealed("bad_delivery: dh of different bytes", LEN1, TEXT, { set: { dh: sha256("different bytes") } });
sealed("bad_delivery: C is not base64", LEN1, TEXT, { ct: (C) => "*" + C.slice(1) });
sealed("bad_delivery: C missing its padding", LEN1, "abc", {
  ct: (C) => { if (!C.endsWith("=")) throw new Error("expected padding"); return C.replace(/=+$/, ""); },
});
{
  // 3-byte plaintext: C is 31 bytes, so its base64 ends in "==". Setting a low bit of
  // the last data character makes the unused trailing bits non-zero (non-canonical).
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const dirtyTail = (C) => {
    const at = C.indexOf("=") - 1;
    if (at < 0) throw new Error("expected padding");
    return C.slice(0, at) + ALPHA[ALPHA.indexOf(C[at]) | 1] + C.slice(at + 1);
  };
  sealed("bad_delivery: C with non-zero trailing bits", LEN1, "abc", { ct: dirtyTail });
}
sealed("bad_delivery: C shorter than nonce plus tag", LEN1, TEXT, { ct: () => Buffer.alloc(20, 7).toString("base64") });
{
  // An unauthenticated C is never judged. Here the bytes between nonce and tag are
  // readable text and dh names exactly them, so a judge that fell back to those bytes
  // when the tag check failed would pass both the dh and the UTF-8 checks and judge
  // them. The tag is bogus, so a correct judge says bad_delivery.
  const name = "bad_delivery: forged C whose middle bytes are readable text";
  const middle = Buffer.from("Paid in USDC on Arc. Forged, never encrypted.", "utf8");
  const raw = Buffer.concat([Buffer.alloc(12, 0x24), middle, Buffer.alloc(16, 0x7e)]);
  const obj = { criteria: JSON.stringify(LEN1), deliverable_ct: raw.toString("base64"), dh: sha256(middle), client_pk: TEST_CLIENT_PK };
  cases.push({ name, stdin: JSON.stringify(obj), jnKey: TEST_K.toString("hex"), pt: middle });
}
sealed("bad_delivery: plaintext is not valid UTF-8", LEN1, Buffer.from([0x41, 0xff, 0xfe, 0x42]));
// invalid_input
sealed("invalid_input: deliverable and deliverable_ct both present", LEN1, TEXT, { set: { deliverable: TEXT } });
sealed("invalid_input: client_pk uppercase", LEN1, TEXT, { set: { client_pk: TEST_CLIENT_PK.toUpperCase() } });
sealed("invalid_input: client_pk of 62 hex", LEN1, TEXT, { set: { client_pk: TEST_CLIENT_PK.slice(2) } });
sealed("invalid_input: client_pk missing", LEN1, TEXT, { del: ["client_pk"] });
sealed("invalid_input: dh uppercase", LEN1, TEXT, { set: { dh: sha256(Buffer.from(TEXT, "utf8")).toUpperCase() } });
sealed("invalid_input: dh missing", LEN1, TEXT, { del: ["dh"] });
sealed("invalid_input: deliverable_ct not a string", LEN1, TEXT, { set: { deliverable_ct: 12345 } });
sealed("invalid_input: criteria not a string", LEN1, TEXT, { set: { criteria: { checks: [] } } });
// too_large (checked before the key is read)
{
  const big = { checks: [{ kind: "length" }], pad: "" };
  big.pad = "a".repeat(MAX_CRITERIA + 1 - bytes(JSON.stringify(big)));
  sealed("too_large: criteria of 4097 bytes", big, TEXT);
}
sealed("too_large: deliverable_ct of 21885 characters", LEN1, TEXT, { ct: () => "A".repeat(MAX_CT + 1) });
sealed("too_large: oversized C wins over a missing key", LEN1, TEXT, { jnKey: null, ct: () => "A".repeat(MAX_CT + 1) });

// ---- generate and self-check ----
const out = [];
for (const c of cases) {
  const expected = await expectedSealed(c.stdin, c.jnKey);
  const v = JSON.parse(expected);
  if (v.k !== undefined) {
    // Round trip through the client: open k, recover K, decrypt C, compare bytes.
    if (v.k.length !== 124) throw new Error(`${c.name}: k is ${v.k.length} chars`);
    const K = openK(v.k, TEST_CLIENT_SK.toString("hex"));
    const C = JSON.parse(c.stdin).deliverable_ct;
    if (!decryptDeliverable(K, C).equals(c.pt)) throw new Error(`${c.name}: round trip failed`);
  }
  if (bytes(expected) > 900) throw new Error(`${c.name}: verdict is ${bytes(expected)} bytes`);
  // Each vector's name states its category; a construction mistake (say a tamper
  // that changed nothing) must not slip through as a silently different case.
  const category = c.name.split(":")[0];
  const ok =
    category === "pass" ? v.pass === true && typeof v.k === "string" && v.err === undefined
    : category === "fail" ? v.pass === false && v.k === undefined
    : v.err === category && v.pass === false && v.k === undefined;
  if (!ok) throw new Error(`${c.name}: outcome does not match its category: ${expected}`);
  out.push({
    name: c.name,
    stdin: c.stdin,
    test_jn_key: c.jnKey,
    test_client_sk: TEST_CLIENT_SK.toString("hex"),
    plaintext_b64: c.pt.toString("base64"),
    expected,
  });
}

const outPath = path.join(HERE, "..", "vectors", "sealed.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
const tally = {};
for (const v of out) {
  const p = JSON.parse(v.expected);
  const key = p.err ?? (p.k ? "pass+k" : "fail");
  tally[key] = (tally[key] ?? 0) + 1;
}
console.log(`wrote ${out.length} sealed vectors to vectors/sealed.json`);
console.log(Object.entries(tally).map(([k, n]) => `  ${k}: ${n}`).join("\n"));
console.log(`  longest verdict: ${Math.max(...out.map((v) => bytes(v.expected)))} bytes`);

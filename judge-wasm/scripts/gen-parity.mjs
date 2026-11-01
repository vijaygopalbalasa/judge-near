// Generate judge-wasm/vectors/parity.json by running Judge Protocol's MIT JS
// engine (the oracle) through the SAME pipeline the WASM uses, with the
// docs/interface.md overrides applied (16-check cap, no http-endpoint, size
// limits). Read-only: it imports the engine and the shared case list, never
// modifies them, and makes no network request.
//
// Run: node scripts/gen-parity.mjs   (from judge-wasm/)
// Needs a clone of https://github.com/vijaygopalbalasa/judge-protocol with its
// judge-service dependencies installed. By default it is expected next to this
// repository (../judge-protocol); set JUDGE_PROTOCOL_DIR to point elsewhere.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JS_ROOT = path.join(
  process.env.JUDGE_PROTOCOL_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "judge-protocol"),
  "judge-service",
);
const { validateCriteria, runAllChecks } = await import(
  `${JS_ROOT}/src/checkers/index.js`
);
const { CRITERIA_CASES, DEEP_TEXT } = await import(
  `${JS_ROOT}/test/helpers/criteria-cases.js`
);

const MAX_CRITERIA = 4096;
const MAX_DELIVERABLE = 16384;

const sha256 = (s) =>
  crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const bytelen = (s) => Buffer.byteLength(s, "utf8");

/** Build the full verdict string exactly as a browser would, then splice eh. */
function buildVerdict(ch, dh, f) {
  const obj = { v: 1, pass: f.pass, score: f.score, th: f.th, ch, dh, checks: f.checks };
  if (f.err) obj.err = f.err;
  const s = JSON.stringify(obj);
  const eh = sha256(s);
  return s.slice(0, -1) + `,"eh":"${eh}"}`;
}

/** True if the criteria are invalid under the interface (overrides + JS rules). */
function interfaceInvalid(parsed) {
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.checks)) {
    if (parsed.checks.some((c) => c && c.kind === "http-endpoint")) return true; // no network kind
    if (parsed.checks.length > 16) return true; // interface cap (JS allowed 64)
  }
  return !validateCriteria(parsed).valid;
}

/** The whole WASM pipeline, computed with the JS engine as the oracle. */
async function computeExpected(criteriaStr, deliverableStr) {
  const ch = sha256(criteriaStr);
  const dh = sha256(deliverableStr);
  const err = (code) => {
    const f = { pass: false, score: 0, th: 100, checks: [], err: code };
    return { expected: f, verdict: buildVerdict(ch, dh, f) };
  };

  if (bytelen(criteriaStr) > MAX_CRITERIA || bytelen(deliverableStr) > MAX_DELIVERABLE) {
    return err("too_large");
  }
  let parsed;
  try {
    parsed = JSON.parse(criteriaStr);
  } catch {
    return err("invalid_criteria");
  }
  if (interfaceInvalid(parsed)) return err("invalid_criteria");

  // Safety: no probe kind may ever reach runAllChecks (it would hit the network).
  if (parsed.checks.some((c) => c && c.kind === "http-endpoint")) {
    throw new Error("probe kind reached the engine");
  }

  const r = await runAllChecks(parsed, { content: Buffer.from(deliverableStr, "utf8") });
  const checks = r.results.map((res, i) => ({
    id: `${parsed.checks[i].kind}#${i}`,
    ok: res.pass,
  }));
  const f = { pass: r.pass, score: r.score, th: r.threshold, checks };
  return { expected: f, verdict: buildVerdict(ch, dh, f) };
}

// ---------------------------------------------------------------------------
// Case list. Each case is { name, criteria, deliverable } where criteria is an
// object (stringified) or { raw } for an exact string.
// ---------------------------------------------------------------------------

const DEFAULT = "Paid in USDC on Arc for ERC-8183 work, settled in USDC.";
const cases = [];
const add = (name, criteria, deliverable = DEFAULT) =>
  cases.push({ name, criteria, deliverable });

// (1) The shared criteria-validation corpus, with a default deliverable. This
// drives validation parity: valid -> scored, invalid -> an err verdict.
for (const [label, criteria] of CRITERIA_CASES) {
  cases.push({ name: `corpus: ${label}`, criteria, deliverable: DEFAULT });
}

// (2) length: words / chars, Unicode, whitespace edges.
add("length words pass", { checks: [{ kind: "length", params: { min: 5, max: 20, unit: "words" } }] });
add("length words fail low", { checks: [{ kind: "length", params: { min: 100, unit: "words" } }] });
add("length chars counts UTF-16 units (emoji=2)", { checks: [{ kind: "length", params: { min: 2, max: 2, unit: "chars" } }] }, "\u{1F600}");
add("length chars emoji too long for 1", { checks: [{ kind: "length", params: { max: 1, unit: "chars" } }] }, "\u{1F600}");
add("length words NBSP + ideographic + BOM split", { checks: [{ kind: "length", params: { min: 4, max: 4, unit: "words" } }] }, "a b　c﻿d");
add("length words NEL does NOT split (one word)", { checks: [{ kind: "length", params: { min: 1, max: 1, unit: "words" } }] }, "a\u0085b");
add("length words fractional bounds", { checks: [{ kind: "length", params: { min: 1.5, max: 3.5, unit: "words" } }] }, "one two three");
add("length chars zero on empty", { checks: [{ kind: "length", params: { min: 0, max: 0, unit: "chars" } }] }, "");

// (3) contains: substring vs whole words, punctuation.
add("contains substring present", { checks: [{ kind: "contains", params: { all: ["Arc", "USDC"] } }] });
add("contains substring missing", { checks: [{ kind: "contains", params: { all: ["Solana"] } }] });
add("contains wholeWords Arc inside Architecture fails", { checks: [{ kind: "contains", params: { all: ["Arc"], wholeWords: true } }] }, "A software Architecture paid in USDC.");
add("contains wholeWords Arc standalone passes", { checks: [{ kind: "contains", params: { all: ["Arc"], wholeWords: true } }] }, "Built on Arc.");
add("contains wholeWords with punctuation terms", { checks: [{ kind: "contains", params: { all: ["ERC-8183", "USDC"], wholeWords: true } }] }, "Pays in USDC, settles on ERC-8183.");
add("contains empty term list passes", { checks: [{ kind: "contains", params: { all: [] } }] }, "anything");

// (4) schema: JS typeof (null/array are object), required, missing.
add("schema required present", { checks: [{ kind: "schema", params: { required: ["invoiceId"], types: { total: "number" } } }] }, '{"invoiceId":"A-1","total":3}');
add("schema missing required", { checks: [{ kind: "schema", params: { required: ["invoiceId"] } }] }, '{"other":1}');
add("schema null and array are object", { checks: [{ kind: "schema", params: { types: { a: "object", b: "object" } } }] }, '{"a":null,"b":[1,2]}');
add("schema type mismatch", { checks: [{ kind: "schema", params: { types: { total: "number" } } }] }, '{"total":"3"}');
add("schema deliverable not an object", { checks: [{ kind: "schema", params: { required: ["a"] } }] }, "[1,2,3]");
add("schema deliverable not JSON", { checks: [{ kind: "schema", params: { required: ["a"] } }] }, "not json");
add("schema inherited field is not own", { checks: [{ kind: "schema", params: { required: ["constructor"] } }] }, "{}");

// (5) json shape: the Poster leads shape and its failure modes.
const lead = {
  type: "object", additionalProperties: false,
  required: ["name", "website", "network", "contact"],
  properties: {
    name: { type: "string", minLength: 1 },
    website: { type: "string", format: "url" },
    network: { enum: ["Arc", "Base"] },
    contact: { anyOf: [{ type: "string", format: "email" }, { type: "string", format: "url" }] },
  },
};
const LEADS = { checks: [{ kind: "json", params: { shape: { type: "array", minItems: 3, maxItems: 3, uniqueBy: { field: "website", key: "domain" }, items: lead } } }] };
const mkLeads = (n) => Array.from({ length: n }, (_, i) => ({ name: `Team ${i}`, website: `https://team${i}.xyz`, network: i % 2 ? "Base" : "Arc", contact: i % 2 ? `hello@team${i}.xyz` : `https://team${i}.xyz/c` }));
add("json leads pass", LEADS, JSON.stringify(mkLeads(3)));
add("json leads wrong count", LEADS, JSON.stringify(mkLeads(2)));
add("json leads duplicate domain", LEADS, JSON.stringify([...mkLeads(2), { ...mkLeads(3)[2], website: "https://WWW.Team0.xyz/x" }]));
add("json leads bad network enum", LEADS, JSON.stringify(mkLeads(3).map((l, i) => (i === 1 ? { ...l, network: "arc" } : l))));
add("json leads subdomain is distinct domain", LEADS, JSON.stringify([...mkLeads(2), { ...mkLeads(3)[2], website: "https://blog.team0.xyz" }]));
add("json leads mailto contact fails", LEADS, JSON.stringify(mkLeads(3).map((l, i) => (i === 0 ? { ...l, contact: "mailto:x@team0.xyz" } : l))));
add("json no shape only needs valid JSON", { checks: [{ kind: "json" }] }, "[1,2,3]");
add("json no shape invalid JSON fails", { checks: [{ kind: "json" }] }, "{nope");
add("json empty shape allows any JSON", { checks: [{ kind: "json", params: { shape: {} } }] }, '{"x":1}');
add("json integer bounds pass", { checks: [{ kind: "json", params: { shape: { type: "integer", minimum: 1, maximum: 20 } } }] }, "20");
add("json integer rejects fractional", { checks: [{ kind: "json", params: { shape: { type: "integer", minimum: 1, maximum: 20 } } }] }, "1.5");
add("json integer rejects 1.0 is actually integer", { checks: [{ kind: "json", params: { shape: { type: "integer" } } }] }, "1.0");
add("json string length counts code points (2 emoji = 2)", { checks: [{ kind: "json", params: { shape: { type: "string", minLength: 2, maxLength: 2 } } }] }, JSON.stringify("\u{1F600}\u{1F600}"));
add("json enum exact type and value", { checks: [{ kind: "json", params: { shape: { enum: [1, "two", null] } } }] }, "1.0");
add("json enum string 1 is not number 1", { checks: [{ kind: "json", params: { shape: { enum: [1] } } }] }, '"1"');
add("json uniqueBy value skips missing field", { checks: [{ kind: "json", params: { shape: { type: "array", uniqueBy: { field: "id", key: "value" } } } }] }, JSON.stringify([{ id: 1 }, { id: 2 }, { id: "1" }, { other: 1 }, 5]));
add("json uniqueBy value duplicate", { checks: [{ kind: "json", params: { shape: { type: "array", uniqueBy: { field: "id", key: "value" } } } }] }, JSON.stringify([{ id: "a" }, { id: "a" }]));
add("json url format accepts punycode", { checks: [{ kind: "json", params: { shape: { type: "string", format: "url" } } }] }, JSON.stringify("https://xn--80ak6aa92e.com"));
add("json email format", { checks: [{ kind: "json", params: { shape: { type: "string", format: "email" } } }] }, JSON.stringify("first.last+tag@sub.example.org"));

// (6) number overflow (1e400): parses under arbitrary_precision, non-finite.
add("json 1e400 is not a number", { checks: [{ kind: "json", params: { shape: { type: "number" } } }] }, "1e400");
add("json 1e400 is not an integer", { checks: [{ kind: "json", params: { shape: { type: "integer" } } }] }, "1e400");
add("json 1e400 not in enum", { checks: [{ kind: "json", params: { shape: { enum: [1] } } }] }, "1e400");
add("json nested 1e400 with empty shape still valid JSON", { checks: [{ kind: "json", params: { shape: {} } }] }, '{"x":1e400}');

// (7) checksum: a matching and a non-matching digest.
const CKSUM_TEXT = "exact bytes for the checksum check";
add("checksum matches", { checks: [{ kind: "checksum", params: { sha256: sha256(CKSUM_TEXT) } }] }, CKSUM_TEXT);
add("checksum matches uppercase hex", { checks: [{ kind: "checksum", params: { sha256: sha256(CKSUM_TEXT).toUpperCase() } }] }, CKSUM_TEXT);
add("checksum mismatch", { checks: [{ kind: "checksum", params: { sha256: sha256("different") } }] }, CKSUM_TEXT);

// (8) scoring: thresholds, weights, the 99 cap.
add("threshold 0 always passes", { passThreshold: 0, checks: [{ kind: "contains", params: { all: ["nope-not-here"] } }] });
add("threshold 100 one fail caps at 99", { passThreshold: 100, checks: [{ kind: "length", params: { min: 1 }, weight: 1000 }, { kind: "contains", params: { all: ["ZZZ"] }, weight: 1 }] });
add("weighted 2 of 3 at threshold 67", { passThreshold: 67, checks: [{ kind: "contains", params: { all: ["USDC"] }, weight: 2 }, { kind: "contains", params: { all: ["ZZZ"] }, weight: 1 }] });
add("fractional weights score", { passThreshold: 50, checks: [{ kind: "contains", params: { all: ["USDC"] }, weight: 2.5 }, { kind: "contains", params: { all: ["ZZZ"] }, weight: 2.5 }] });
add("all pass scores 100", { passThreshold: 100, checks: [{ kind: "length", params: { min: 1 } }, { kind: "contains", params: { all: ["USDC"] } }] });

// (9) deep but legal deliverable (depth 100 <= serde's 127 limit): both parse.
const deepArr = "[".repeat(100) + "1" + "]".repeat(100);
add("json deep deliverable depth 100 empty shape", { checks: [{ kind: "json", params: { shape: {} } }] }, deepArr);

// (10) size limits at the exact boundary.
function criteriaOfBytes(n) {
  const base = { checks: [{ kind: "length" }], pad: "" };
  const need = n - bytelen(JSON.stringify(base));
  base.pad = "a".repeat(need);
  return base; // JSON.stringify(base) is exactly n bytes
}
add("criteria exactly 4096 bytes is valid", criteriaOfBytes(4096), "x");
add("criteria 4097 bytes is too_large", criteriaOfBytes(4097), "x");
add("deliverable exactly 16384 bytes is valid", { checks: [{ kind: "length" }] }, "d".repeat(16384));
add("deliverable 16385 bytes is too_large", { checks: [{ kind: "length" }] }, "d".repeat(16385));

// (11) whole-word fuzz: deterministic strings from a safe (valid-Unicode) set.
// Mirrors the PIECES/TERMS sweep in checkers.test.js, minus lone surrogates
// (which cannot survive a JSON round trip).
const PIECES = ["USDC", "US", "DC", "a", "_", " ", "-", "é", "́", "²", "Ⅻ", "٣", "\u{1F600}", "\u{10940}", "\u{11F04}", "\u{1D7D8}", "͸", "USDCUSDC", "x"];
const TERMS = ["USDC", "US", "a", "_", "", "é", "\u{1F600}", "USDC USDC", "C_U", "\u{10940}"];
let seed = 17;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
for (let i = 0; i < 120; i++) {
  const text = Array.from({ length: Math.floor(rnd() * 9) }, () => pick(PIECES)).join("");
  const term = pick(TERMS);
  add(`wholeWord fuzz ${i}`, { checks: [{ kind: "contains", params: { all: [term], wholeWords: true } }] }, text);
}

// ---------------------------------------------------------------------------

const out = [];
for (const c of cases) {
  const criteriaStr = c.criteria && c.criteria.raw !== undefined ? c.criteria.raw : JSON.stringify(c.criteria);
  const { expected, verdict } = await computeExpected(criteriaStr, c.deliverable);
  out.push({ name: c.name, criteria: criteriaStr, deliverable: c.deliverable, expected, verdict });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "vectors", "parity.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

// Summary for the console.
const errCounts = {};
let scored = 0;
for (const v of out) {
  if (v.expected.err) errCounts[v.expected.err] = (errCounts[v.expected.err] || 0) + 1;
  else scored++;
}
console.log(`wrote ${out.length} vectors to ${outPath}`);
console.log(`  scored: ${scored}`);
for (const [k, n] of Object.entries(errCounts)) console.log(`  ${k}: ${n}`);
// Longest rendered verdict (must stay <= 900 bytes).
const longest = out.reduce((m, v) => Math.max(m, bytelen(v.verdict)), 0);
console.log(`  longest verdict: ${longest} bytes`);

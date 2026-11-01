// Write an adversarial corpus of judge inputs to vectors/fuel/, for the fuel
// regression guard (scripts/fuel-check.sh). Each file is one stdin JSON object
// {criteria, deliverable}, deterministic, within the interface limits (criteria
// <= 4096 bytes, deliverable <= 16384 bytes, <= 16 checks). These are the inputs
// that cost the most instructions; the guard runs the judge over each under the
// recommended max_instructions and fails if any runs out of fuel.
//
// Run from judge-wasm/:  node scripts/make-fuel-corpus.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CRITERIA = 4096;
const MAX_DELIVERABLE = 16384;
const bytes = (s) => Buffer.byteLength(s, "utf8");

/** Pack terms into contains checks (<= 256 terms/check, <= 16 checks) until the
 *  criteria JSON would pass 4096 bytes. Returns {criteria, usedTerms}. */
function packTerms(makeTerm, wholeWords, maxTerms = Infinity) {
  const checks = [];
  let count = 0;
  for (;;) {
    if (count >= maxTerms) break;
    if (checks.length === 0 || checks[checks.length - 1].params.all.length >= 256) {
      if (checks.length >= 16) break;
      checks.push({ kind: "contains", params: { all: [], wholeWords } });
      if (bytes(JSON.stringify({ checks })) > MAX_CRITERIA) { checks.pop(); break; }
    }
    const cur = checks[checks.length - 1];
    cur.params.all.push(makeTerm(count));
    if (bytes(JSON.stringify({ checks })) > MAX_CRITERIA) {
      cur.params.all.pop();
      if (cur.params.all.length === 0) checks.pop();
      break;
    }
    count++;
  }
  return { criteria: { checks }, usedTerms: count };
}

/** A 16384-byte deliverable: `used` terms each appear once, as whole words, at
 *  the very end, padded in front with `fill`. */
function foundLate(used, fill) {
  const tail = used.map((t) => " " + t).join("") + " ";
  const pad = MAX_DELIVERABLE - bytes(tail);
  if (pad < 0) throw new Error("tail too long");
  return fill.repeat(Math.ceil(pad / fill.length)).slice(0, pad) + tail;
}

const distinctLetters = [];
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") distinctLetters.push(ch);
for (let cp = 0x100; distinctLetters.length < 2000 && cp < 0x800; cp++) distinctLetters.push(String.fromCodePoint(cp));

const cases = [];
const add = (slug, criteria, deliverable) => cases.push({ slug, criteria, deliverable });

// 1. The original worst case before linearization: ~1,250 empty wholeWords terms
//    over "a a a ..." (this cost 17.4 billion instructions with the old scan).
{
  const { criteria, usedTerms } = packTerms(() => "", true);
  add(`wholeword-empty-terms-x${usedTerms}`, criteria, "a ".repeat(MAX_DELIVERABLE / 2));
}
// 2. Max empty terms over all-identical text "aaaa...".
{
  const { criteria } = packTerms(() => "", true);
  add("wholeword-empty-terms-solid", criteria, "a".repeat(MAX_DELIVERABLE));
}
// 3. Max 1-char 'a' terms over "aaaa...".
add("wholeword-char-terms-solid", packTerms(() => "a", true).criteria, "a".repeat(MAX_DELIVERABLE));
// 4. Distinct single-letter terms, each found only at the end (defeats memoization).
{
  const { criteria, usedTerms } = packTerms((i) => distinctLetters[i], true, distinctLetters.length);
  add(`wholeword-distinct-letters-x${usedTerms}`, criteria, foundLate(distinctLetters.slice(0, usedTerms), "a"));
}
// 5. Distinct a..ab terms (KMP follows a failure link at every char), found late.
{
  const runs = Array.from({ length: 200 }, (_, k) => "a".repeat(k + 1) + "b");
  const { criteria, usedTerms } = packTerms((i) => runs[i], true, runs.length);
  add(`wholeword-run-terms-x${usedTerms}`, criteria, foundLate(runs.slice(0, usedTerms), "a"));
}
// 6. One 1024-unit late-mismatch term.
add("wholeword-1024-late-mismatch", { checks: [{ kind: "contains", params: { all: ["a".repeat(1023) + "b"], wholeWords: true } }] }, "a".repeat(MAX_DELIVERABLE));
// 7. Plain substring, max 1-char terms (Two-Way search baseline).
add("plain-char-terms-solid", packTerms(() => "a", false).criteria, "a".repeat(MAX_DELIVERABLE));
// 8. 16 length checks (words and chars) over a full deliverable.
add("length-words-x16", { checks: Array.from({ length: 16 }, () => ({ kind: "length", params: { min: 0, unit: "words" } })) }, "a ".repeat(MAX_DELIVERABLE / 2));
add("length-chars-x16-unicode", { checks: Array.from({ length: 16 }, () => ({ kind: "length", params: { min: 0, unit: "chars" } })) }, "\u{1F600}́".repeat(Math.floor(MAX_DELIVERABLE / bytes("\u{1F600}́"))));
// 9. 16 checksum checks.
add("checksum-x16", { checks: Array.from({ length: 16 }, () => ({ kind: "checksum", params: { sha256: "0".repeat(64) } })) }, "a".repeat(MAX_DELIVERABLE));
// 10. 16 json checks over a large array, items + uniqueBy (the memory peak).
{
  let s = "["; const ids = [];
  for (let i = 0; ; i++) { const n = (i ? "," : "") + `{"id":${i}}`; if (bytes(s + n + "]") > MAX_DELIVERABLE) break; s += n; ids.push(i); }
  const shape = { type: "array", uniqueBy: { field: "id", key: "value" }, items: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "integer", minimum: 0 } } } };
  add(`json-items-uniqueby-x16-${ids.length}obj`, { checks: Array.from({ length: 16 }, () => ({ kind: "json", params: { shape } })) }, s + "]");
  add("schema-x16", { checks: Array.from({ length: 16 }, () => ({ kind: "schema", params: { required: ["id"] } })) }, s + "]");
}
// 11. 16 json checks, nested anyOf over nested arrays (the current fuel ceiling).
{
  const leaf = [{ type: "string" }, { type: "boolean" }, { type: "null" }, { type: "integer", maximum: 1e9 }];
  const inner = { anyOf: [{ type: "array", items: { anyOf: leaf } }, { type: "string" }, { type: "boolean" }, { type: "null" }] };
  const shape = { type: "array", items: inner };
  const row = "[" + Array(8).fill("1").join(",") + "]";
  let s = "["; for (let i = 0; ; i++) { const n = (i ? "," : "") + row; if (bytes(s + n + "]") > MAX_DELIVERABLE) break; s += n; }
  add("json-nested-anyof-x16", { checks: Array.from({ length: 16 }, () => ({ kind: "json", params: { shape } })) }, s + "]");
}
// 12. 16 json url objects, anyOf formats + uniqueBy domain.
{
  let s = "["; for (let i = 0; ; i++) { const n = (i ? "," : "") + `{"w":"https://www.site${i}.example.org/p"}`; if (bytes(s + n + "]") > MAX_DELIVERABLE) break; s += n; }
  const shape = { type: "array", uniqueBy: { field: "w", key: "domain" }, items: { type: "object", properties: { w: { anyOf: [{ type: "string", format: "email" }, { type: "string", format: "url" }] } } } };
  add("json-url-anyof-uniqueby-domain-x16", { checks: Array.from({ length: 16 }, () => ({ kind: "json", params: { shape } })) }, s + "]");
}
// 13. A normal, valid, scored case (sanity: the common path must stay cheap).
add("normal-scored", { passThreshold: 100, checks: [{ kind: "length", params: { min: 1, max: 5000, unit: "words" } }, { kind: "contains", params: { all: ["USDC", "Arc"] } }] }, "Paid in USDC on Arc for the agreed work.");

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vectors", "fuel");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
let i = 0;
for (const c of cases) {
  const cStr = JSON.stringify(c.criteria);
  if (bytes(cStr) > MAX_CRITERIA) throw new Error(`${c.slug}: criteria ${bytes(cStr)} > ${MAX_CRITERIA}`);
  if (bytes(c.deliverable) > MAX_DELIVERABLE) throw new Error(`${c.slug}: deliverable ${bytes(c.deliverable)} > ${MAX_DELIVERABLE}`);
  const stdin = JSON.stringify({ criteria: cStr, deliverable: c.deliverable });
  const name = `${String(i).padStart(2, "0")}-${c.slug}.json`;
  fs.writeFileSync(path.join(dir, name), stdin);
  console.log(`${name}  criteria ${bytes(cStr)} B, deliverable ${bytes(c.deliverable)} B, ${c.criteria.checks.length} checks`);
  i++;
}
console.log(`\nwrote ${i} corpus files to ${dir}`);

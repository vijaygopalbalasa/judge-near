// Measure the judge WASM's worst-case cost under the same metering OutLayer
// uses (wasmtime fuel = "instructions"; StoreLimits memory cap). Builds
// adversarial inputs that stay inside the interface limits (criteria <= 4096
// bytes, deliverable <= 16384 bytes, <= 16 checks) AND reach the scoring path
// (a verdict without `err`), then binary-searches, per input:
//   - the minimum fuel (-W fuel=N) that lets the run finish,
//   - the minimum linear memory (-W max-memory-size=N) that lets it finish,
// and times a normal run. No network; runs only the local wasmtime binary.
// It then measures the sealed cases of the fuel corpus (vectors/fuel/*sealed*,
// from make-fuel-corpus.mjs), passing each test JN_KEY as an environment variable.
//
// Run from judge-wasm/:  node scripts/measure-limits.mjs [path/to/judge.wasm]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WASM = process.argv[2] || "target/wasm32-wasip1/release/judge.wasm";
const MAX_CRITERIA = 4096;
const MAX_DELIVERABLE = 16384;
const bytes = (s) => Buffer.byteLength(s, "utf8");

/** Pack `terms` into contains checks (<= 256 terms each, <= 16 checks) until
 *  the criteria JSON would pass 4096 bytes. */
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
  return { checks };
}

/** Pack as many of the given (distinct) terms as fit, in order; return the
 *  criteria and the terms that made it in. */
function packList(terms, wholeWords) {
  let used = 0;
  const crit = packTerms((i) => terms[i], wholeWords, terms.length);
  for (const c of crit.checks) used += c.params.all.length;
  return { crit, used: terms.slice(0, used) };
}

/** A deliverable where every term is found exactly once, as a whole word, at the
 *  very end (so `contains` never short-circuits and each term scans everything),
 *  padded in front with `fill` to exactly 16384 bytes. */
function foundLate(used, fill) {
  const tail = used.map((t) => " " + t).join("") + " ";
  const pad = MAX_DELIVERABLE - bytes(tail);
  if (pad < 0) throw new Error("tail too long");
  return fill.repeat(Math.ceil(pad / fill.length)).slice(0, pad) + tail;
}

// Distinct single-letter terms: printable ASCII letters/digits first (4 bytes as
// a JSON term), then 2-byte letters from U+0100 on (5 bytes each).
const distinctLetters = [];
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") distinctLetters.push(ch);
for (let cp = 0x100; distinctLetters.length < 2000 && cp < 0x800; cp++) distinctLetters.push(String.fromCodePoint(cp));

const allA = "a".repeat(MAX_DELIVERABLE);
const aSpace = "a ".repeat(MAX_DELIVERABLE / 2);

const cases = [];
const add = (name, criteria, deliverable) => cases.push({ name, criteria: JSON.stringify(criteria), deliverable });

// wholeWords families (the expected worst case: each term rescans the text).
add("wholeWords: max empty terms, text 'a a a ...'", packTerms(() => "", true), aSpace);
add("wholeWords: max empty terms, text 'aaaa...'", packTerms(() => "", true), allA);
add("wholeWords: max 1-char terms 'a', text 'aaaa...'", packTerms(() => "a", true), allA);
add("wholeWords: distinct runs a, aa, aaa, ...", packTerms((i) => "a".repeat(i + 1), true), allA);
add("wholeWords: 1024-unit terms a..ab (late mismatch)", packTerms(() => "a".repeat(1023) + "b", true), allA);
// Distinct terms defeat per-term memoization: each one found only at the end.
{
  const { crit, used } = packList(distinctLetters, true);
  add(`wholeWords: ${used.length} distinct letters, each found at the end`, crit, foundLate(used, "a"));
  const p = packList(distinctLetters, false);
  add(`plain contains: ${p.used.length} distinct letters, each found at the end`, p.crit, foundLate(p.used, "a"));
  // a^k b: KMP matches k chars of the filler then follows a failure link at every char.
  const runs = Array.from({ length: 200 }, (_, k) => "a".repeat(k + 1) + "b");
  const r = packList(runs, true);
  add(`wholeWords: ${r.used.length} distinct a..ab terms, found at the end`, r.crit, foundLate(r.used, "a"));
}
// Same terms as plain substrings (Two-Way search, expected cheap).
add("plain contains: max 1-char terms", packTerms(() => "a", false), allA);
add("plain contains: 1024-unit terms a..ab", packTerms(() => "a".repeat(1023) + "b", false), allA);

// length / checksum / schema / json at full size with 16 checks.
add("length words x16", { checks: Array.from({ length: 16 }, () => ({ kind: "length", params: { min: 0, unit: "words" } })) }, aSpace);
add("length chars x16", { checks: Array.from({ length: 16 }, () => ({ kind: "length", params: { min: 0, unit: "chars" } })) }, allA);
add("checksum x16", { checks: Array.from({ length: 16 }, () => ({ kind: "checksum", params: { sha256: "0".repeat(64) } })) }, allA);
{
  const ids = []; let s = "[";
  for (let i = 0; ; i++) { const next = (i ? "," : "") + `{"id":${i}}`; if (bytes(s + next + "]") > MAX_DELIVERABLE) break; s += next; ids.push(i); }
  const deliverable = s + "]";
  const shape = { type: "array", uniqueBy: { field: "id", key: "value" }, items: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "integer", minimum: 0 } } } };
  add(`json x16: ${ids.length} objects, items + uniqueBy`, { checks: Array.from({ length: 16 }, () => ({ kind: "json", params: { shape } })) }, deliverable);
  add("schema x16 over the same array", { checks: Array.from({ length: 16 }, () => ({ kind: "schema", params: { required: ["id"] } })) }, deliverable);
}
{
  // Nested anyOf through items: each anyOf level multiplies the walk by up to 4.
  const leafAlts = [{ type: "string" }, { type: "boolean" }, { type: "null" }, { type: "integer", maximum: 1e9 }];
  const inner = { anyOf: [{ type: "array", items: { anyOf: leafAlts } }, { type: "string" }, { type: "boolean" }, { type: "null" }] };
  const shape = { type: "array", items: inner };
  const row = "[" + Array(8).fill("1").join(",") + "]";
  let s = "[";
  for (let i = 0; ; i++) { const next = (i ? "," : "") + row; if (bytes(s + next + "]") > MAX_DELIVERABLE) break; s += next; }
  add("json x16: nested anyOf over nested arrays", { checks: Array.from({ length: 16 }, () => ({ kind: "json", params: { shape } })) }, s + "]");
}
{
  const urls = []; let s = "[";
  for (let i = 0; ; i++) { const next = (i ? "," : "") + `{"w":"https://www.site${i}.example.org/p"}`; if (bytes(s + next + "]") > MAX_DELIVERABLE) break; s += next; urls.push(i); }
  const shape = { type: "array", uniqueBy: { field: "w", key: "domain" }, items: { type: "object", properties: { w: { anyOf: [{ type: "string", format: "email" }, { type: "string", format: "url" }] } } } };
  add(`json x16: ${urls.length} url objects, anyOf formats + uniqueBy domain`, { checks: Array.from({ length: 16 }, () => ({ kind: "json", params: { shape } })) }, s + "]");
}

function run(stdin, extra = []) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync("wasmtime", ["run", ...extra, WASM], { input: stdin, maxBuffer: 1 << 20 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const out = r.stdout ? r.stdout.toString() : "";
  return { ok: r.status === 0 && out.startsWith('{"v":1'), out, ms };
}

/** Smallest N in [lo, hi] for which ok(N) holds (ok is monotone). */
function bisect(lo, hi, ok, tolerance) {
  while (hi - lo > tolerance) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

const baseline = run(JSON.stringify({ criteria: '{"checks":[{"kind":"length"}]}', deliverable: "x" }));
console.log(`wasm: ${WASM}`);
console.log(`baseline run (compile + start + trivial input): ${baseline.ms.toFixed(0)} ms\n`);

const rows = [];
for (const c of cases) {
  const stdin = JSON.stringify({ criteria: c.criteria, deliverable: c.deliverable });
  const cb = bytes(c.criteria), db = bytes(c.deliverable);
  if (cb > MAX_CRITERIA || db > MAX_DELIVERABLE) throw new Error(`${c.name}: over the limits (${cb}/${db})`);
  const plain = run(stdin);
  if (!plain.ok) throw new Error(`${c.name}: run failed: ${plain.out}`);
  if (plain.out.includes('"err"')) throw new Error(`${c.name}: not a scored verdict: ${plain.out}`);
  const nChecks = JSON.parse(c.criteria).checks.length;

  // Fuel: grow an upper bound, then bisect to 0.1%.
  let hi = 1_000_000;
  while (!run(stdin, ["-W", `fuel=${hi}`]).ok) hi *= 4;
  const fuel = bisect(Math.floor(hi / 4), hi, (n) => run(stdin, ["-W", `fuel=${n}`]).ok, Math.max(1000, Math.floor(hi / 1000)));

  // Memory: bisect in 64 KiB pages between 1 page and 64 MiB.
  const PAGE = 65536;
  const pages = bisect(1, 1024, (p) => run(stdin, ["-W", `max-memory-size=${p * PAGE}`]).ok, 1);

  // Time: best of 3 plain runs.
  const ms = Math.min(plain.ms, run(stdin).ms, run(stdin).ms);
  rows.push({ name: c.name, cb, db, nChecks, fuel, memKiB: (pages * PAGE) / 1024, ms });
  console.log(`${c.name}\n  criteria ${cb} B, deliverable ${db} B, ${nChecks} checks -> fuel ${fuel.toLocaleString("en-US")}, memory ${(pages * PAGE) / 1024} KiB, ${ms.toFixed(0)} ms`);
}

// Sealed corpus cases: decrypt up to 16 KB, run the checks, and on a pass derive k.
const corpus = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vectors", "fuel");
for (const f of fs.readdirSync(corpus).filter((n) => n.includes("sealed") && n.endsWith(".json")).sort()) {
  const stdin = fs.readFileSync(path.join(corpus, f));
  const keyFile = path.join(corpus, f.replace(/\.json$/, ".test-jn-key"));
  const env = fs.existsSync(keyFile) ? ["--env", `JN_KEY=${fs.readFileSync(keyFile, "utf8")}`] : [];
  const plain = run(stdin, env);
  if (!plain.ok) throw new Error(`${f}: run failed: ${plain.out}`);
  let hi = 1_000_000;
  while (!run(stdin, [...env, "-W", `fuel=${hi}`]).ok) hi *= 4;
  const fuel = bisect(Math.floor(hi / 4), hi, (n) => run(stdin, [...env, "-W", `fuel=${n}`]).ok, Math.max(1000, Math.floor(hi / 1000)));
  const PAGE = 65536;
  const pages = bisect(1, 1024, (p) => run(stdin, [...env, "-W", `max-memory-size=${p * PAGE}`]).ok, 1);
  const ms = Math.min(plain.ms, run(stdin, env).ms, run(stdin, env).ms);
  const outcome = JSON.parse(plain.out).err ?? (plain.out.includes('"k":"') ? "pass with k" : "fail");
  rows.push({ name: `sealed ${f} (${outcome})`, fuel, memKiB: (pages * PAGE) / 1024, ms });
  console.log(`sealed ${f} (${outcome})\n  fuel ${fuel.toLocaleString("en-US")}, memory ${(pages * PAGE) / 1024} KiB, ${ms.toFixed(0)} ms`);
}

const worst = rows.reduce((a, b) => (b.fuel > a.fuel ? b : a));
const worstMem = rows.reduce((a, b) => (b.memKiB > a.memKiB ? b : a));
const worstMs = rows.reduce((a, b) => (b.ms > a.ms ? b : a));
console.log(`\nworst fuel:   ${worst.fuel.toLocaleString("en-US")} (${worst.name})`);
console.log(`worst memory: ${worstMem.memKiB} KiB (${worstMem.name})`);
console.log(`worst time:   ${worstMs.ms.toFixed(0)} ms incl. ~${baseline.ms.toFixed(0)} ms compile/start (${worstMs.name})`);

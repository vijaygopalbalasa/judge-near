// Run every parity vector and every sealed vector through the built judge wasm under
// wasmtime, and compare the printed verdict with the expected text byte for byte.
// Sealed vectors pass their test key as the JN_KEY environment variable (absent when
// the vector has none), the way OutLayer injects it.
//
// Run from judge-wasm/:  node scripts/wasm-vectors.mjs [path/to/judge.wasm]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const wasm = process.argv[2] || path.join(HERE, "..", "target", "wasm32-wasip1", "release", "judge.wasm");
const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, "..", "vectors", f), "utf8"));

function judge(stdin, jnKey) {
  const env = typeof jnKey === "string" ? ["--env", `JN_KEY=${jnKey}`] : [];
  const r = spawnSync("wasmtime", ["run", ...env, wasm], { input: stdin, maxBuffer: 1 << 20 });
  return r.status === 0 ? r.stdout.toString() : `exit ${r.status}: ${r.stderr}`;
}

let failed = 0;
let total = 0;
const check = (name, got, want) => {
  total++;
  if (got !== want) {
    failed++;
    console.log(`FAIL ${name}\n  want: ${want}\n  got:  ${got}`);
  }
};

for (const v of read("parity.json")) {
  check(`parity: ${v.name}`, judge(JSON.stringify({ criteria: v.criteria, deliverable: v.deliverable }), null), v.verdict);
}
for (const v of read("sealed.json")) {
  check(`sealed: ${v.name}`, judge(v.stdin, v.test_jn_key), v.expected);
}

console.log(`${total - failed} of ${total} vectors match through ${path.basename(wasm)} under wasmtime.`);
process.exit(failed ? 1 : 0);

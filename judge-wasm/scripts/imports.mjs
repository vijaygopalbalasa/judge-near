// List the judge wasm's imports from its import section and fail unless they are
// exactly the five WASI functions the judge is allowed: no random_get, no clock,
// nothing else. Parsing the module (not grepping strings) catches any new name.
//
// Run from judge-wasm/:  node scripts/imports.mjs [path/to/judge.wasm]

import fs from "node:fs";

const wasm = process.argv[2] || "target/wasm32-wasip1/release/judge.wasm";
const imports = WebAssembly.Module.imports(new WebAssembly.Module(fs.readFileSync(wasm)))
  .map((i) => `${i.module}.${i.name} (${i.kind})`)
  .sort();
const expected = ["environ_get", "environ_sizes_get", "fd_read", "fd_write", "proc_exit"]
  .map((n) => `wasi_snapshot_preview1.${n} (function)`)
  .sort();

console.log(imports.join("\n"));
if (JSON.stringify(imports) !== JSON.stringify(expected)) {
  console.error(`\nFAIL: expected exactly:\n${expected.join("\n")}`);
  process.exit(1);
}
console.log("\nOK: exactly the five expected WASI imports.");

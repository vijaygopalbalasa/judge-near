// The published judge (judge-wasm/release/judge.wasm), run here on a plain delivery: the same checks OutLayer runs on
// the decrypted delivery. A worker's tools run it before sending anything, so neither a failing delivery nor criteria
// the judge calls invalid ever cost the worker its work.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runJudge } from "../../web/verify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let judgeBytes;

/** The judge's verdict on {criteria, deliverable}, run here. */
export async function judgeHere(criteria, deliverable) {
  judgeBytes ??= new Uint8Array(fs.readFileSync(path.join(HERE, "..", "..", "judge-wasm", "release", "judge.wasm")));
  return JSON.parse(await runJudge(judgeBytes, JSON.stringify({ criteria, deliverable })));
}

/** "length#0 failed, contains#1 failed" for a verdict's failing checks. */
export const failedChecks = (verdict) => (verdict.checks ?? []).filter((c) => !c.ok).map((c) => `${c.id} failed`).join(", ");

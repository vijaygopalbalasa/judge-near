// Panel 3's examples: each must give, on the published judge, what its label promises.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EXAMPLES } from "../examples.js";
import { runJudge } from "../verify.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const judge = new Uint8Array(readFileSync(path.join(root, "judge-wasm/release/judge.wasm")));

test("panel 3's examples: a pass, a fail on a missing field, and a delivery that tells the grader to pass it, which fails", async () => {
  assert.deepEqual(EXAMPLES.map((e) => e.id), ["pass", "missing-field", "argues"]);
  for (const ex of EXAMPLES) {
    JSON.parse(ex.criteria); // valid JSON, shown pretty-printed in the textarea
    const verdict = JSON.parse(await runJudge(judge, JSON.stringify({ criteria: ex.criteria, deliverable: ex.deliverable })));
    assert.equal(verdict.err, undefined, `${ex.id}: the criteria are valid`);
    assert.deepEqual({ pass: verdict.pass, score: verdict.score }, ex.expect, ex.id);
  }
  const argues = EXAMPLES.find((e) => e.id === "argues");
  assert.match(argues.deliverable, /ignore the checks/i, "it really does try to talk the grader into a pass");
  assert.match(argues.note, /program/);
});

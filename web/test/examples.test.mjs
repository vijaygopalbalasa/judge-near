// The page's examples: each must give, on the published judge, what its label promises.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EXAMPLES } from "../examples.js";
import { runJudge } from "../verify.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const judge = new Uint8Array(readFileSync(path.join(root, "judge-wasm/release/judge.wasm")));

test("the page's examples: a pass, a missing field, a delivery that argues with the judge, and a file whose hash the buyer knew", async () => {
  assert.deepEqual(EXAMPLES.map((e) => e.id), ["pass", "missing-field", "argues", "known-hash"]);
  for (const ex of EXAMPLES) {
    JSON.parse(ex.criteria); // valid JSON, shown pretty-printed in the textarea
    const verdict = JSON.parse(await runJudge(judge, JSON.stringify({ criteria: ex.criteria, deliverable: ex.deliverable })));
    assert.equal(verdict.err, undefined, `${ex.id}: the criteria are valid`);
    assert.deepEqual({ pass: verdict.pass, score: verdict.score }, ex.expect, ex.id);
  }
  const argues = EXAMPLES.find((e) => e.id === "argues");
  assert.match(argues.deliverable, /ignore the checks/i, "it really does try to talk the grader into a pass");
  assert.match(argues.note, /program/);
  const known = EXAMPLES.find((e) => e.id === "known-hash");
  const sha = JSON.parse(known.criteria).checks[0].params.sha256;
  assert.equal(sha, createHash("sha256").update(known.deliverable, "utf8").digest("hex"), "the hash is the file's own");
  const changed = JSON.parse(await runJudge(judge, JSON.stringify({ criteria: known.criteria, deliverable: known.deliverable.replace("1,204", "1,205") })));
  assert.equal(changed.pass, false, "one character changed, and the hash no longer matches");
});

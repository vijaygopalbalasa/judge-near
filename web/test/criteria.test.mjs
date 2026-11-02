// The criteria language in plain words (web/criteria.js), checked against the published judge: every
// explanation is for criteria the judge really calls invalid_criteria, and criteria it accepts get none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CHECK_KINDS, describeCheck, explainCriteria } from "../criteria.js";
import { EXAMPLES } from "../examples.js";
import { runJudge } from "../verify.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const judge = new Uint8Array(readFileSync(path.join(root, "judge-wasm/release/judge.wasm")));
const verdictOn = async (criteria) => JSON.parse(await runJudge(judge, JSON.stringify({ criteria, deliverable: "x" })));

const INVALID = [
  ["not json", /not JSON/],
  ["[]", /must be a JSON object/],
  ['{"checks":[]}', /checks must be a list of 1 to 16 checks/],
  [`{"checks":[${Array(17).fill('{"kind":"length"}').join(",")}]}`, /1 to 16 checks/],
  ['{"passThreshold":101,"checks":[{"kind":"length"}]}', /passThreshold must be a whole number from 0 to 100/],
  ['{"checks":[{"kind":"length","extra":1}]}', /check 1 takes kind, params and weight, not extra/],
  ['{"checks":[{"kind":"regex"}]}', /check 1: unknown kind "regex"; the kinds are length, contains, schema, checksum and json/],
  ['{"checks":[{"kind":"length","weight":0}]}', /check 1: weight must be a number above 0 and at most 1000/],
  ['{"checks":[{"kind":"length","params":[1]}]}', /check 1: params must be an object/],
  ['{"checks":[{"kind":"contains","params":{"terms":["a"]}}]}', /check 1: contains takes all and wholeWords, not terms/],
  ['{"checks":[{"kind":"contains","params":{"all":"a"}}]}', /check 1: all must be a list of terms/],
  ['{"checks":[{"kind":"length","params":{"min":5,"max":2}}]}', /check 1: min is above max/],
  ['{"checks":[{"kind":"length","params":{"min":-1}}]}', /check 1: min must be a number of 0 or more/],
  ['{"checks":[{"kind":"length","params":{"unit":"lines"}}]}', /check 1: unit must be "chars" or "words"/],
  ['{"checks":[{"kind":"schema","params":{"types":{"a":"int"}}}]}', /check 1: each type in types must be "string", "number", "boolean" or "object"/],
  ['{"checks":[{"kind":"schema","params":{"required":"a"}}]}', /check 1: required must be a list of field names/],
  ['{"checks":[{"kind":"checksum","params":{"sha256":"abc"}}]}', /check 1: sha256 must be 64 hex digits/],
  ['{"checks":[{"kind":"length"},{"kind":"json","params":{"shape":{"type":"list"}}}]}', /check 2: shape is not valid/],
];

test("explainCriteria names the problem in criteria the judge calls invalid_criteria", async () => {
  for (const [text, message] of INVALID) {
    assert.equal((await verdictOn(text)).err, "invalid_criteria", `the judge calls it invalid: ${text}`);
    assert.match(explainCriteria(text) ?? "(nothing)", message, text);
  }
});

test("explainCriteria finds nothing wrong in criteria the judge accepts", async () => {
  const tasks = ["escrow-report.json", "escrow-report-with-tvl.json"].map((f) => readFileSync(path.join(root, "agents/tasks", f), "utf8"));
  const accepted = [
    ...EXAMPLES.map((e) => e.criteria),
    ...tasks,
    '{"checks":[{"kind":"length"}]}',
    '{"passThreshold":50,"checks":[{"kind":"contains","params":{"all":["a"],"wholeWords":true},"weight":2},{"kind":"checksum","params":{"sha256":"' + "a".repeat(64) + '"}}]}',
    '{"checks":[{"kind":"json","params":{"shape":{"type":"array","items":{"type":"object","required":["url"],"properties":{"url":{"type":"string","format":"url"}}},"uniqueBy":{"field":"url","key":"domain"}}}}]}',
  ];
  for (const text of accepted) {
    assert.notEqual((await verdictOn(text)).err, "invalid_criteria", `the judge accepts it: ${text}`);
    assert.equal(explainCriteria(text), null, text);
  }
});

test("describeCheck says what each kind of check asks, in plain words", () => {
  assert.deepEqual(Object.keys(CHECK_KINDS), ["length", "contains", "schema", "checksum", "json"]);
  assert.equal(describeCheck({ kind: "length", params: { max: 600, unit: "chars" } }), "at most 600 characters");
  assert.equal(describeCheck({ kind: "length", params: { min: 40, unit: "words" } }), "at least 40 words");
  assert.equal(describeCheck({ kind: "length", params: { min: 3, max: 40 } }), "3 to 40 words", "the judge counts words when unit is left out");
  assert.equal(describeCheck({ kind: "contains", params: { all: ["refund window", "settlement time"] } }), 'contains "refund window" and "settlement time"');
  assert.equal(describeCheck({ kind: "schema", params: { required: ["title", "sources"], types: { title: "string", sources: "number" } } }), "a JSON object with title (string) and sources (number)");
  assert.equal(describeCheck({ kind: "checksum", params: { sha256: "ab".repeat(32) } }), "SHA-256 is abababab...");
  assert.equal(describeCheck({ kind: "json", params: { shape: { type: "array" } } }), "JSON that matches the given shape");
});

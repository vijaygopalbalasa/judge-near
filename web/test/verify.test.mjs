// Run from the repository root: node --test web/test/*.test.mjs   (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { canonicalPrefix, expectedEh, findRuling, runJudge, sha256Hex, verifyRuling } from "../verify.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const judge = new Uint8Array(readFileSync(path.join(root, "judge-wasm/release/judge.wasm")));
const probe = new Uint8Array(readFileSync(path.join(root, "tools/keystore-probe/release/keystore-probe.wasm")));
const tx = JSON.parse(readFileSync(path.join(root, "web/test/fixtures/tx-direct-pass.json"), "utf8")).result;
const vectors = JSON.parse(readFileSync(path.join(root, "judge-wasm/vectors/parity.json"), "utf8"));

test("the browser WASI host reproduces every parity vector byte for byte", async () => {
  const module = await WebAssembly.compile(judge);
  let checked = 0;
  for (const v of vectors) {
    const input = JSON.stringify({ criteria: v.criteria, deliverable: v.deliverable });
    const out = await runJudge(judge, input);
    assert.equal(out, v.verdict, v.name);
    checked++;
  }
  assert.equal(checked, vectors.length);
  assert.ok(module instanceof WebAssembly.Module);
});

test("expectedEh recomputes eh from the fields of every parity verdict", async () => {
  for (const v of vectors.slice(0, 50)) {
    const verdict = JSON.parse(v.verdict);
    assert.equal(await expectedEh(verdict), verdict.eh, v.name);
    assert.ok(v.verdict.startsWith(canonicalPrefix(verdict)), v.name);
  }
});

test("findRuling reads the request and the verdict from a real OutLayer transaction", () => {
  const r = findRuling(tx);
  assert.equal(r.outlayer, "outlayer.testnet");
  assert.equal(r.signer, "judgeprotocol.testnet");
  assert.equal(r.source.hash, "da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1");
  assert.match(r.source.url, /^https:\/\/raw\.githubusercontent\.com\/vijaygopalbalasa\/judge-near\//);
  assert.equal(JSON.parse(r.input).deliverable, "Hello NEAR, this is a test delivery.");
  assert.equal(r.verdict.pass, true);
  assert.equal(r.completed.success, true);
  // OutLayer re-serializes Json output with sorted keys (docs/interface.md 6.5).
  assert.ok(r.verdictText.startsWith('{"ch":'));
});

test("verifyRuling accepts the real ruling when given the published wasm", async () => {
  const report = await verifyRuling(findRuling(tx), { wasmBytes: judge });
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 1));
  assert.deepEqual(report.steps.map((s) => s.id), ["source", "published", "result", "input", "hash", "rerun", "match", "eh"]);
});

test("verifyRuling checks the signer when one is given", async () => {
  const good = await verifyRuling(findRuling(tx), { wasmBytes: judge, signer: "judgeprotocol.testnet" });
  assert.equal(good.ok, true);
  const bad = await verifyRuling(findRuling(tx), { wasmBytes: judge, signer: "someone-else.testnet" });
  assert.equal(bad.ok, false);
  assert.equal(bad.steps[0].id, "signer");
});

test("look-alike OutLayer events from any other contract are ignored", () => {
  const forgedTx = structuredClone(tx);
  for (const r of forgedTx.receipts_outcome) {
    if (r.outcome.executor_id === "outlayer.testnet") r.outcome.executor_id = "fake-outlayer.testnet";
  }
  assert.equal(findRuling(forgedTx), null);
});

test("a ruling by a wasm that is not a published judge is not verified, even if it re-runs", async () => {
  const r = findRuling(tx);
  const otherHash = await sha256Hex(probe);
  const report = await verifyRuling({ ...r, source: { ...r.source, hash: otherHash } }, { wasmBytes: probe });
  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.id === "published").ok, false);
});

test("the key is passed only for a sealed ruling, and only after the hash checks out", async () => {
  const seen = [];
  const spy = async (bytes, input, env) => {
    seen.push(env);
    return runJudge(bytes, input);
  };
  await verifyRuling(findRuling(tx), { wasmBytes: judge, env: { JN_KEY: "ab".repeat(32) }, runner: spy });
  assert.deepEqual(seen.at(-1), {}, "a public ruling never receives the key");
  await verifyRuling(findRuling(tx), { wasmBytes: probe, env: { JN_KEY: "ab".repeat(32) }, runner: spy });
  assert.equal(seen.length, 1, "a wasm with the wrong hash is never run");
});

test("verifyRuling rejects a verdict that was changed after the fact", async () => {
  const r = findRuling(tx);
  const forged = { ...r, verdict: { ...r.verdict, pass: false, score: 0 } };
  const report = await verifyRuling(forged, { wasmBytes: judge });
  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.id === "match").ok, false);
});

test("verifyRuling rejects a forged evidence hash", async () => {
  const r = findRuling(tx);
  const forged = { ...r, verdict: { ...r.verdict, eh: "0".repeat(64) } };
  const report = await verifyRuling(forged, { wasmBytes: judge });
  assert.equal(report.ok, false);
});

test("verifyRuling refuses a wasm whose hash is not the one OutLayer ran", async () => {
  const report = await verifyRuling(findRuling(tx), { wasmBytes: probe });
  assert.equal(report.ok, false);
  const hash = report.steps.find((s) => s.id === "hash");
  assert.equal(hash.ok, false);
  assert.equal(hash.detail, await sha256Hex(probe));
});

test("a sealed ruling asks for the key instead of guessing", async () => {
  const r = { ...findRuling(tx), secretsRef: { profile: "jn-x-1", account_id: "provider.testnet" } };
  const report = await verifyRuling(r, { wasmBytes: judge });
  assert.equal(report.ok, false);
  assert.equal(report.steps.at(-1).id, "key");
});

test("a transaction without an OutLayer request yields no ruling", () => {
  assert.equal(findRuling({ receipts_outcome: [{ outcome: { logs: [], status: { SuccessValue: "" }, executor_id: "x.testnet" } }] }), null);
});

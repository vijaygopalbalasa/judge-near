// Run from the repository root: node --test web/test/*.test.mjs   (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PUBLISHED_JUDGES, canonicalPrefix, expectedEh, findRuling, rulingJob, runJudge, sha256Hex, verifyRuling } from "../verify.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const judge = new Uint8Array(readFileSync(path.join(root, "judge-wasm/release/judge.wasm")));
// The live testnet ruling in the fixture was made by judge v1 (commit e09c6f9); a copy of that build.
const judgeV1 = new Uint8Array(readFileSync(path.join(root, "web/test/fixtures/judge-v1.wasm")));
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
  const report = await verifyRuling(findRuling(tx), { wasmBytes: judgeV1 });
  assert.equal(report.ok, true, JSON.stringify(report.steps, null, 1));
  assert.deepEqual(report.steps.map((s) => s.id), ["source", "published", "result", "input", "hash", "rerun", "match", "eh"]);
});

test("verifyRuling checks the signer when one is given", async () => {
  const good = await verifyRuling(findRuling(tx), { wasmBytes: judgeV1, signer: "judgeprotocol.testnet" });
  assert.equal(good.ok, true);
  const bad = await verifyRuling(findRuling(tx), { wasmBytes: judgeV1, signer: "someone-else.testnet" });
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
  await verifyRuling(findRuling(tx), { wasmBytes: judgeV1, env: { JN_KEY: "ab".repeat(32) }, runner: spy });
  assert.deepEqual(seen.at(-1), {}, "a public ruling never receives the key");
  await verifyRuling(findRuling(tx), { wasmBytes: probe, env: { JN_KEY: "ab".repeat(32) }, runner: spy });
  assert.equal(seen.length, 1, "a wasm with the wrong hash is never run");
});

test("verifyRuling rejects a verdict that was changed after the fact", async () => {
  const r = findRuling(tx);
  const forged = { ...r, verdict: { ...r.verdict, pass: false, score: 0 } };
  const report = await verifyRuling(forged, { wasmBytes: judgeV1 });
  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.id === "match").ok, false);
});

test("verifyRuling rejects a forged evidence hash", async () => {
  const r = findRuling(tx);
  const forged = { ...r, verdict: { ...r.verdict, eh: "0".repeat(64) } };
  const report = await verifyRuling(forged, { wasmBytes: judgeV1 });
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
  const report = await verifyRuling(r, { wasmBytes: judgeV1 });
  assert.equal(report.ok, false);
  assert.equal(report.steps.at(-1).id, "key");
});

test("a transaction without an OutLayer request yields no ruling", () => {
  assert.equal(findRuling({ receipts_outcome: [{ outcome: { logs: [], status: { SuccessValue: "" }, executor_id: "x.testnet" } }] }), null);
});

const V1 = "da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1";
const V2 = "911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958";
const sealedVectors = JSON.parse(readFileSync(path.join(root, "judge-wasm/vectors/sealed.json"), "utf8"));
const sortedJson = (o) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));

function sealedRuling(v) {
  const verdict = JSON.parse(v.expected);
  return {
    outlayer: "outlayer.testnet",
    signer: "worker.testnet",
    caller: "escrow.testnet",
    input: v.stdin,
    inputInState: false,
    source: { url: "https://example.com/judge.wasm", hash: V2 },
    secretsRef: { profile: "jn-0000000000000000-1", account_id: "worker.testnet" },
    verdict,
    verdictText: sortedJson(verdict), // OutLayer re-serializes Json output with sorted keys
  };
}

test("both judge builds are published, and the release file is v2", async () => {
  assert.equal(await sha256Hex(judge), V2);
  assert.equal(readFileSync(path.join(root, "judge-wasm/release/judge.wasm.sha256"), "utf8").split(/\s+/)[0], V2);
  assert.equal(await sha256Hex(judgeV1), V1);
  assert.ok(PUBLISHED_JUDGES.has(V1) && PUBLISHED_JUDGES.has(V2));
});

test("a sealed ruling by judge v2 re-runs with the deliverable key and matches, k included", async () => {
  const passes = sealedVectors.filter((v) => v.expected.includes('"k":'));
  assert.ok(passes.length >= 3);
  for (const v of passes.slice(0, 3)) {
    const report = await verifyRuling(sealedRuling(v), { wasmBytes: judge, env: { JN_KEY: v.test_jn_key } });
    assert.equal(report.ok, true, `${v.name}: ${JSON.stringify(report.steps.filter((s) => !s.ok))}`);
    assert.equal(report.local.k, JSON.parse(v.expected).k);
  }
});

test("a sealed ruling re-run with the wrong key does not verify", async () => {
  const v = sealedVectors.find((x) => x.expected.includes('"k":'));
  const report = await verifyRuling(sealedRuling(v), { wasmBytes: judge, env: { JN_KEY: "00".repeat(32) } });
  assert.equal(report.ok, false);
  assert.equal(report.steps.find((s) => s.id === "match").ok, false);
});

test("an input OutLayer kept in its own state is rebuilt from the escrow job, and a wrong job cannot pass", async () => {
  const stateTx = structuredClone(tx);
  for (const r of stateTx.receipts_outcome) {
    if (r.outcome.executor_id !== "outlayer.testnet") continue;
    r.outcome.logs = r.outcome.logs.map((line) => {
      if (!line.startsWith("EVENT_JSON:")) return line;
      const ev = JSON.parse(line.slice(11));
      if (ev.event !== "execution_requested") return line;
      const req = JSON.parse(ev.data[0].request_data);
      Object.assign(req, { input_data: "", input_data_in_state: true, predecessor_id: "escrow.testnet" });
      ev.data[0].request_data = JSON.stringify(req);
      return `EVENT_JSON:${JSON.stringify(ev)}`;
    });
  }
  stateTx.transaction = {
    ...(stateTx.transaction ?? {}),
    signer_id: "judgeprotocol.testnet",
    receiver_id: "escrow.testnet",
    actions: [{ FunctionCall: { method_name: "request_ruling", args: btoa('{"job_id":7}'), gas: 300000000000000, deposit: "10000000000000000000000" } }],
  };
  const original = JSON.parse(findRuling(tx).input);
  const rpcAnswering = (job, seen = []) => async (_url, init) => {
    seen.push(JSON.parse(init.body).params);
    return { json: async () => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(job))] } }) };
  };
  const ruling = findRuling(stateTx);
  assert.equal(ruling.inputInState, true);
  assert.equal(ruling.input, null);

  const seen = [];
  const good = await verifyRuling(ruling, { wasmBytes: judgeV1, tx: stateTx, fetchImpl: rpcAnswering({ criteria: original.criteria, deliverable: original.deliverable }, seen) });
  assert.equal(good.ok, true, JSON.stringify(good.steps, null, 1));
  assert.equal(good.steps.find((s) => s.id === "input").detail, "escrow escrow.testnet, job 7");
  assert.equal(seen[0].method_name, "get_job");
  assert.equal(seen[0].account_id, "escrow.testnet");
  assert.deepEqual(JSON.parse(atob(seen[0].args_base64)), { job_id: 7 });

  const lying = await verifyRuling(ruling, { wasmBytes: judgeV1, tx: stateTx, fetchImpl: rpcAnswering({ criteria: original.criteria, deliverable: `${original.deliverable}!` }) });
  assert.equal(lying.ok, false);
  assert.equal(lying.steps.find((s) => s.id === "match").ok, false);

  const elsewhere = structuredClone(stateTx);
  elsewhere.transaction.receiver_id = "other-contract.testnet";
  const wrongContract = await verifyRuling(ruling, { wasmBytes: judgeV1, tx: elsewhere, fetchImpl: rpcAnswering({ criteria: original.criteria, deliverable: original.deliverable }) });
  assert.equal(wrongContract.ok, false);
  assert.match(wrongContract.steps.at(-1).detail, /not a request_ruling call to the contract that asked OutLayer/);

  const noTx = await verifyRuling(ruling, { wasmBytes: judgeV1 });
  assert.equal(noTx.ok, false);
  assert.equal(noTx.steps.at(-1).id, "input");
});

test("a sealed input kept in OutLayer's state is rebuilt with the sealed fields and re-runs with the key", async () => {
  const v = sealedVectors.find((x) => x.expected.includes('"k":'));
  const stdin = JSON.parse(v.stdin);
  const job = { sealed: true, criteria: stdin.criteria, deliverable_ct: stdin.deliverable_ct, dh: stdin.dh, client_pk: stdin.client_pk, deliverable: "" };
  const minimalTx = {
    transaction: {
      receiver_id: "escrow.testnet",
      actions: [{ FunctionCall: { method_name: "request_ruling", args: btoa('{"job_id":3}') } }],
    },
  };
  const rpc = async () => ({ json: async () => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(job))] } }) });
  const ruling = { ...sealedRuling(v), input: null, inputInState: true };
  const report = await verifyRuling(ruling, { wasmBytes: judge, env: { JN_KEY: v.test_jn_key }, tx: minimalTx, fetchImpl: rpc });
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => !s.ok)));
  assert.equal(report.steps.find((s) => s.id === "input").detail, "escrow escrow.testnet, job 3");
});

test("a sealed key_missing ruling re-runs without a key, as OutLayer ran it, even when a key is supplied", async () => {
  const v = sealedVectors.find((x) => JSON.parse(x.expected).err === "key_missing");
  assert.ok(v, "the sealed vectors include a key_missing verdict");
  const pass = sealedVectors.find((x) => x.expected.includes('"k":'));
  for (const env of [{}, { JN_KEY: pass.test_jn_key }]) {
    const seen = [];
    const runner = (bytes, input, e) => {
      seen.push(e);
      return runJudge(bytes, input, e);
    };
    const report = await verifyRuling(sealedRuling(v), { wasmBytes: judge, env, runner });
    assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => !s.ok)));
    assert.deepEqual(seen, [{}], "the judge is re-run with no key at all");
    const key = report.steps.find((s) => s.id === "key");
    assert.equal(key.ok, true);
    assert.match(key.label, /without a key/);
    assert.equal(report.local.err, "key_missing");
  }
});

test("a sealed ruling that is not key_missing still needs the key", async () => {
  const v = sealedVectors.find((x) => x.expected.includes('"k":'));
  const report = await verifyRuling(sealedRuling(v), { wasmBytes: judge });
  assert.equal(report.ok, false);
  assert.equal(report.steps.at(-1).id, "key");
  assert.equal(report.steps.at(-1).ok, false);
});

test("rulingJob reads the escrow and job from the request_ruling call, and only from the contract that asked OutLayer", () => {
  const ruling = { caller: "escrow.testnet" };
  const call = (receiver, args) => ({ transaction: { receiver_id: receiver, actions: [{ FunctionCall: { method_name: "request_ruling", args: btoa(args) } }] } });
  assert.deepEqual(rulingJob(call("escrow.testnet", '{"job_id":4}'), ruling), { escrow: "escrow.testnet", jobId: 4 });
  assert.match(rulingJob(call("other.testnet", '{"job_id":4}'), ruling).error, /not a request_ruling call to the contract that asked OutLayer/);
  assert.match(rulingJob(call("escrow.testnet", '{"job_id":-1}'), ruling).error, /could not read the job id/);
  assert.match(rulingJob(call("escrow.testnet", "not json"), ruling).error, /could not read the job id/);
  assert.match(rulingJob({ transaction: { receiver_id: "escrow.testnet", actions: [] } }, ruling).error, /not a request_ruling call/);
});

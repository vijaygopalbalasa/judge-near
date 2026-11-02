// Run from the repository root: node --test web/test/*.test.mjs   (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PUBLISHED_JUDGES, TESTNET_ARCHIVAL_RPCS, canonicalPrefix, expectedEh, fetchTransaction, findRuling, inputFromEscrow, publishedJudgeName, reportOutcome, rpcCall, rulingJob, runJudge, sha256Hex, summarizeTx, verifyRuling, verifyTransaction, verifyWithDelivery } from "../verify.js";

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

test("a sealed ruling without the key is never reported as verified, and the judge is never run", async () => {
  const r = { ...findRuling(tx), secretsRef: { profile: "jn-x-1", account_id: "provider.testnet" } };
  let ran = 0;
  const runner = async () => {
    ran++;
    return "{}";
  };
  const fetchImpl = async () => {
    throw new Error("nothing is downloaded when the judge cannot be re-run");
  };
  const report = await verifyRuling(r, { wasmBytes: judgeV1, runner, fetchImpl });
  assert.equal(report.ok, false);
  assert.equal(ran, 0);
  assert.equal(report.steps.at(-1).id, "key");
  assert.equal(report.steps.at(-1).ok, null, "not done is neither passed nor failed");
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

test("a sealed ruling without the key runs the checks that need none, and marks the re-run as not done", async () => {
  for (const v of sealedVectors.filter((x) => JSON.parse(x.expected).err !== "key_missing").slice(0, 6)) {
    let ran = 0;
    const runner = async () => {
      ran++;
      return "{}";
    };
    const report = await verifyRuling(sealedRuling(v), { wasmBytes: judge, runner });
    assert.deepEqual(report.steps.map((s) => s.id), ["source", "published", "result", "input", "ch", "dh", "eh", "key"], v.name);
    assert.deepEqual(report.steps.filter((s) => s.ok !== true).map((s) => [s.id, s.ok]), [["key", null]], `${v.name}: ${JSON.stringify(report.steps)}`);
    assert.equal(report.ok, false, `${v.name}: without a re-run it is not verified`);
    assert.equal(report.needsKey, true);
    assert.equal(reportOutcome(report), "needs-key");
    assert.equal(ran, 0);
  }
});

test("without the key, a changed ch, dh or eh is still caught, and so is a criteria the verdict was not computed on", async () => {
  const v = sealedVectors.find((x) => x.expected.includes('"k":'));
  const base = sealedRuling(v);
  const withEh = async (verdict) => ({ ...verdict, eh: await expectedEh(verdict) });
  const cases = {
    ch: { ...base, verdict: await withEh({ ...base.verdict, ch: "1".repeat(64) }) },
    dh: { ...base, verdict: await withEh({ ...base.verdict, dh: "2".repeat(64) }) },
    eh: { ...base, verdict: { ...base.verdict, eh: "3".repeat(64) } },
    criteria: { ...base, input: JSON.stringify({ ...JSON.parse(base.input), criteria: '{"checks":[]}' }) },
  };
  const failing = { ch: "ch", dh: "dh", eh: "eh", criteria: "ch" };
  for (const [name, ruling] of Object.entries(cases)) {
    const report = await verifyRuling(ruling, { wasmBytes: judge });
    assert.equal(reportOutcome(report), "failed", name);
    assert.deepEqual(report.steps.filter((s) => s.ok === false).map((s) => s.id), [failing[name]], `${name}: ${JSON.stringify(report.steps)}`);
    assert.equal(report.ok, false, name);
  }
});

test("reportOutcome: verified only after a matching re-run; needs-key only when nothing failed", async () => {
  assert.equal(reportOutcome(await verifyRuling(findRuling(tx), { wasmBytes: judgeV1 })), "verified");
  const r = findRuling(tx);
  assert.equal(reportOutcome(await verifyRuling({ ...r, verdict: { ...r.verdict, score: 0 } }, { wasmBytes: judgeV1 })), "failed");
  const v = sealedVectors.find((x) => x.expected.includes('"k":'));
  assert.equal(reportOutcome(await verifyRuling(sealedRuling(v), { wasmBytes: judge, env: { JN_KEY: v.test_jn_key } })), "verified");
  assert.equal(reportOutcome({ ok: false, needsKey: true, steps: [{ id: "ch", ok: false }, { id: "key", ok: null }] }), "failed");
  assert.equal(reportOutcome({ ok: false, steps: [{ id: "x", ok: null }] }), "failed", "an unexplained gap is not a pass");
  assert.equal(reportOutcome({ ok: false, needsKey: true, steps: [{ id: "ch", ok: undefined }, { id: "key", ok: null }] }), "failed", "a step without a result is not a pass");
  assert.equal(reportOutcome({ ok: false, needsKey: true, steps: [{ id: "key", ok: null }, { id: "eh", ok: true }] }), "failed", "only a final key step may be left undone");
  assert.equal(reportOutcome({ ok: true, steps: [] }), "failed", "no checks is not verified");
});

test("a ruling checked for a job: it passes only when the request_ruling call names that job of that escrow", async () => {
  const v = sealedVectors.find((x) => x.expected.includes('"k":'));
  const ruling = sealedRuling(v); // caller escrow.testnet
  const callFor = (receiver, jobId) => ({ transaction: { receiver_id: receiver, actions: [{ FunctionCall: { method_name: "request_ruling", args: btoa(JSON.stringify({ job_id: jobId })) } }] } });
  const opts = { wasmBytes: judge, env: { JN_KEY: v.test_jn_key } };

  const right = await verifyRuling(ruling, { ...opts, tx: callFor("escrow.testnet", 3), job: { escrow: "escrow.testnet", jobId: 3 } });
  assert.equal(right.ok, true, JSON.stringify(right.steps.filter((s) => !s.ok)));
  assert.equal(right.steps[0].id, "job");
  assert.match(right.steps[0].label, /job 3 of escrow\.testnet/);

  for (const [name, tx, job] of [
    ["another job", callFor("escrow.testnet", 4), { escrow: "escrow.testnet", jobId: 3 }],
    ["another escrow", callFor("escrow.testnet", 3), { escrow: "other-escrow.testnet", jobId: 3 }],
    ["a call to a contract that did not ask OutLayer", callFor("other-escrow.testnet", 3), { escrow: "other-escrow.testnet", jobId: 3 }],
    ["no transaction", undefined, { escrow: "escrow.testnet", jobId: 3 }],
  ]) {
    let ran = 0;
    const runner = async () => {
      ran++;
      return "{}";
    };
    const report = await verifyRuling(ruling, { ...opts, tx, job, runner });
    assert.equal(report.ok, false, name);
    assert.deepEqual(report.steps.map((s) => [s.id, s.ok]), [["job", false]], name);
    assert.equal(ran, 0, `${name}: nothing else runs`);
  }
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

// ---- reading the chain: NEAR archival nodes, tried in order ----
// Regular testnet nodes drop transactions after about 30 hours, so a ruling from last week is only on
// an archival node. A host that is down, rate limited, or does not have the transaction is skipped.

const ARCHIVAL = ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const RULING_TX = "4VFvzoQZEZf7DUZt1WnviReZVVsYYjFPSvtE6skr25jk";
const answer = (result) => () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "verify", result }) });
const FAILURES = {
  "HTTP 429": () => ({ ok: false, status: 429, json: async () => ({}) }),
  "HTTP 503": () => ({ ok: false, status: 503, json: async () => ({}) }),
  "a network error": () => {
    throw new TypeError("fetch failed");
  },
  "a body that is not JSON": () => ({ ok: true, status: 200, json: async () => {
    throw new SyntaxError("Unexpected token '<'");
  } }),
  UNKNOWN_TRANSACTION: () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "verify", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} }, code: -32000, message: "Server error" } }) }),
};

/** A fake fetch: `answers` maps each host to a response maker (which may throw); records every host asked. */
function hostsAnswering(answers) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url, method: JSON.parse(init.body).method });
    if (!answers[url]) throw new Error(`asked an unexpected host: ${url}`);
    return answers[url]();
  };
  return { fetchImpl, asked };
}

test("the verifier reads the chain from NEAR archival nodes, FastNEAR's first, then NEAR's own", () => {
  assert.deepEqual([...TESTNET_ARCHIVAL_RPCS], ARCHIVAL);
});

test("fetchTransaction asks the first archival host for the transaction and stops when it answers", async () => {
  const { fetchImpl, asked } = hostsAnswering({ [ARCHIVAL[0]]: answer(tx), [ARCHIVAL[1]]: answer({ wrong: true }) });
  assert.deepEqual(await fetchTransaction(RULING_TX, "judgeprotocol.testnet", { fetchImpl }), tx);
  assert.deepEqual(asked, [{ url: ARCHIVAL[0], method: "tx" }]);
});

test("fetchTransaction moves to the next host on a 429, a 5xx, a network error, a body that is not JSON, or a JSON-RPC error", async () => {
  for (const [name, fail] of Object.entries(FAILURES)) {
    const { fetchImpl, asked } = hostsAnswering({ [ARCHIVAL[0]]: fail, [ARCHIVAL[1]]: answer(tx) });
    assert.deepEqual(await fetchTransaction(RULING_TX, "judgeprotocol.testnet", { fetchImpl }), tx, name);
    assert.deepEqual(asked.map((a) => a.url), ARCHIVAL, name);
  }
});

test("when every host fails, the error names each host and what went wrong there", async () => {
  const { fetchImpl } = hostsAnswering({ [ARCHIVAL[0]]: FAILURES["HTTP 429"], [ARCHIVAL[1]]: FAILURES.UNKNOWN_TRANSACTION });
  await assert.rejects(fetchTransaction(RULING_TX, "judgeprotocol.testnet", { fetchImpl }), (e) => {
    assert.match(e.message, /https:\/\/archival-rpc\.testnet\.fastnear\.com: HTTP 429/);
    assert.match(e.message, /https:\/\/archival-rpc\.testnet\.near\.org: UNKNOWN_TRANSACTION/);
    return true;
  });
});

test("an explicit rpc, one URL or a list, replaces the archival default", async () => {
  const one = hostsAnswering({ "https://rpc.example.test": answer(tx) });
  await fetchTransaction(RULING_TX, "judgeprotocol.testnet", { rpc: "https://rpc.example.test", fetchImpl: one.fetchImpl });
  assert.deepEqual(one.asked.map((a) => a.url), ["https://rpc.example.test"]);
  const list = hostsAnswering({ "https://a.example.test": FAILURES["a network error"], "https://b.example.test": answer(tx) });
  await fetchTransaction(RULING_TX, "judgeprotocol.testnet", { rpc: ["https://a.example.test", "https://b.example.test"], fetchImpl: list.fetchImpl });
  assert.deepEqual(list.asked.map((a) => a.url), ["https://a.example.test", "https://b.example.test"]);
});

test("inputFromEscrow reads get_job from the archival hosts too, falls back, and reports a total failure as an error", async () => {
  const job = { criteria: '{"v":1,"checks":[]}', deliverable: "hello" };
  const stateTx = { transaction: { receiver_id: "escrow.testnet", actions: [{ FunctionCall: { method_name: "request_ruling", args: btoa('{"job_id":7}') } }] } };
  const ruling = { caller: "escrow.testnet" };
  const view = { result: [...new TextEncoder().encode(JSON.stringify(job))] };
  const { fetchImpl, asked } = hostsAnswering({ [ARCHIVAL[0]]: FAILURES["HTTP 503"], [ARCHIVAL[1]]: answer(view) });
  const got = await inputFromEscrow(stateTx, ruling, { fetchImpl });
  assert.equal(got.input, JSON.stringify(job));
  assert.deepEqual(asked, [{ url: ARCHIVAL[0], method: "query" }, { url: ARCHIVAL[1], method: "query" }]);
  const down = hostsAnswering({ [ARCHIVAL[0]]: FAILURES["HTTP 429"], [ARCHIVAL[1]]: FAILURES["a network error"] });
  const failed = await inputFromEscrow(stateTx, ruling, { fetchImpl: down.fetchImpl });
  assert.match(failed.error, /^get_job on escrow\.testnet failed: .*archival-rpc\.testnet\.fastnear\.com: HTTP 429.*archival-rpc\.testnet\.near\.org: fetch failed/);
});

test("verifyTransaction, as the page calls it, reads the ruling from the archival hosts", async () => {
  const { fetchImpl, asked } = hostsAnswering({ [ARCHIVAL[0]]: FAILURES.UNKNOWN_TRANSACTION, [ARCHIVAL[1]]: answer(tx) });
  const report = await verifyTransaction(RULING_TX, "judgeprotocol.testnet", { fetchImpl, wasmBytes: judgeV1 });
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => !s.ok)));
  assert.deepEqual(asked.map((a) => a.url), ARCHIVAL);
});

test("publishedJudgeName names a published judge build by its bytes, and nothing else", async () => {
  assert.equal(await publishedJudgeName(judge), "judge v2 (public and sealed jobs), commit fd3dcc6");
  assert.equal(await publishedJudgeName(judgeV1), "judge v1 (public jobs), commit e09c6f9");
  assert.equal(await publishedJudgeName(probe), null);
});

test("summarizeTx reads who signed what, the outcome, and each receipt's executor, status and events", () => {
  const sum = summarizeTx(tx);
  assert.equal(sum.signer, "judgeprotocol.testnet");
  assert.equal(sum.receiver, "outlayer.testnet");
  assert.equal(sum.status, "success");
  assert.deepEqual(sum.actions.map((a) => [a.kind, a.method]), [["FunctionCall", "request_execution"]]);
  assert.match(sum.actions[0].deposit, /^\d+$/);
  assert.equal(JSON.parse(sum.actions[0].args).source.WasmUrl.hash, "da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1", "a call's JSON arguments are decoded");
  const outlayer = sum.receipts.filter((r) => r.executor === "outlayer.testnet");
  assert.ok(outlayer.length >= 1);
  assert.ok(sum.receipts.flatMap((r) => r.events.map((e) => e.event)).includes("execution_requested"));
  const failed = summarizeTx({ ...tx, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: no" } } } } } });
  assert.equal(failed.status, "failure");
  assert.match(failed.failure, /Smart contract panicked: no/);
});

test("a host that does not answer within the timeout is skipped, and the next one asked", async () => {
  const asked = [];
  const fetchImpl = (url, init) => {
    asked.push(url);
    if (url === "https://slow.example.test") {
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "verify", result: { fine: true } }) });
  };
  const t0 = Date.now();
  const got = await rpcCall(["https://slow.example.test", "https://fast.example.test"], "status", [], fetchImpl, { timeoutMs: 60 });
  assert.deepEqual(got, { fine: true });
  assert.deepEqual(asked, ["https://slow.example.test", "https://fast.example.test"]);
  assert.ok(Date.now() - t0 < 2000);
  await assert.rejects(rpcCall(["https://slow.example.test"], "status", [], fetchImpl, { timeoutMs: 30 }), /slow\.example\.test: no answer within 0\.03 s/);
});

test("summarizeTx reads what OutLayer did: refused with its message, or ran with its resources", () => {
  const ev = (data) => `EVENT_JSON:${JSON.stringify({ standard: "near-outlayer", version: "1.0.0", event: "execution_completed", data: [data] })}`;
  const refused = summarizeTx({ transaction: {}, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: "outlayer.testnet", logs: [ev({ success: false, error_message: "Access denied by access condition", resources_used: { instructions: 0, time_ms: 0 } })], status: { SuccessValue: "" } } }] });
  assert.deepEqual(refused.outlayer, [{ success: false, error: "Access denied by access condition", instructions: 0, timeMs: 0 }]);
  const ran = summarizeTx({ transaction: {}, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: "outlayer.testnet", logs: [ev({ success: true, resources_used: { instructions: 121432, time_ms: 9 } })], status: { SuccessValue: "" } } }] });
  assert.deepEqual(ran.outlayer, [{ success: true, error: undefined, instructions: 121432, timeMs: 9 }]);
  assert.deepEqual(summarizeTx({ transaction: {}, status: { SuccessValue: "" }, receipts_outcome: [] }).outlayer, []);
  const forged = summarizeTx({ transaction: {}, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: "fake-outlayer.testnet", logs: [ev({ success: false, error_message: "Access denied by access condition" })], status: { SuccessValue: "" } } }] });
  assert.deepEqual(forged.outlayer, [], "only OutLayer's own receipts count; any contract can log a look-alike event");
});

// ---- a sealed ruling re-run on its disclosed delivery: no key needed once the plain delivery is known ----

test("a sealed ruling re-runs in full on its disclosed delivery: dh binds it, and pass, score and checks match", async () => {
  const pass = sealedVectors.find((x) => x.expected.includes('"k":'));
  const plain = Buffer.from(pass.plaintext_b64, "base64").toString("utf8");
  const report = await verifyWithDelivery(sealedRuling(pass), plain, { wasmBytes: judge });
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => s.ok !== true)));
  assert.equal(reportOutcome(report), "verified");
  assert.deepEqual(report.steps.map((s) => s.id).slice(-4), ["delivery", "hash", "rerun", "match"]);
  assert.match(report.steps.find((s) => s.id === "match").label, /pass, score, threshold, ch, dh and checks/);
});

test("a delivery that does not hash to dh is refused before anything runs, and a changed verdict does not match", async () => {
  const pass = sealedVectors.find((x) => x.expected.includes('"k":'));
  let ran = 0;
  const runner = async (b, i) => {
    ran++;
    return runJudge(b, i);
  };
  const plain = Buffer.from(pass.plaintext_b64, "base64").toString("utf8");
  const wrong = await verifyWithDelivery(sealedRuling(pass), `${plain} `, { wasmBytes: judge, runner });
  assert.equal(reportOutcome(wrong), "failed");
  assert.equal(wrong.steps.at(-1).id, "delivery");
  assert.equal(ran, 0);
  const r = sealedRuling(pass);
  const forged = { ...r, verdict: { ...r.verdict, score: 7 } };
  const changed = await verifyWithDelivery(forged, plain, { wasmBytes: judge });
  assert.equal(reportOutcome(changed), "failed");
  assert.equal(changed.steps.find((s) => s.id === "match").ok, false);
  const pub = await verifyWithDelivery(findRuling(tx), "anything", { wasmBytes: judgeV1 });
  assert.equal(reportOutcome(pub), "failed", "only sealed rulings take a disclosed delivery");
});

test("every sealed vector the judge opened re-checks on its plaintext; rulings that never opened the delivery are refused, not failed", async () => {
  // The escrow caps criteria at 4096 bytes and deliverable_ct at 21884 (contract/src/lib.rs), so a ciphertext the
  // judge refused for its size never reaches it on chain; those two vectors are left out.
  const onChainPossible = sealedVectors.filter((v) => !/deliverable_ct of 21885|oversized C/.test(v.name));
  let opened = 0;
  for (const v of onChainPossible) {
    const plain = Buffer.from(v.plaintext_b64, "base64").toString("utf8");
    const err = JSON.parse(v.expected).err;
    const report = await verifyWithDelivery(sealedRuling(v), plain, { wasmBytes: judge });
    if (["key_missing", "bad_delivery", "invalid_input"].includes(err)) {
      assert.equal(reportOutcome(report), "failed", v.name);
      const last = report.steps.at(-1);
      assert.equal(last.id, "opened", v.name);
      assert.match(last.label, /never opened the delivery/, v.name);
    } else {
      opened++;
      assert.equal(reportOutcome(report), "verified", `${v.name}: ${JSON.stringify(report.steps.filter((s) => s.ok !== true))}`);
    }
  }
  assert.equal(opened, 16, "10 passes, 2 scored fails, 2 invalid_criteria, too_large after decrypt, criteria of 4097 bytes");
});

test("verifyTransaction with a delivery: job 2's real sealed ruling re-checks in full on job 0's public text, and on nothing else", async () => {
  // Job 2 sealed the text job 0 delivered in public (the same dh), so its delivery is already disclosed on chain.
  const sealedTx = JSON.parse(readFileSync(path.join(root, "web/test/fixtures/tx-sealed-job2.json"), "utf8")).result;
  const text = readFileSync(path.join(root, "web/test/fixtures/job0-delivery.txt"), "utf8");
  const SEALED_TX = "5nC2ABEDbFKFzVY8nzVaJooyD3uW2xxpbH2VuvgcYNsh";
  const { fetchImpl } = hostsAnswering({ [ARCHIVAL[0]]: answer(sealedTx) });
  const job = { escrow: "judgenear-escrow.testnet", jobId: 2 };
  const report = await verifyTransaction(SEALED_TX, "judgenear-worker.testnet", { fetchImpl, wasmBytes: judge, delivery: text, job });
  assert.equal(reportOutcome(report), "verified", JSON.stringify(report.steps.filter((s) => s.ok !== true)));
  assert.deepEqual(report.steps.map((s) => s.id).slice(-4), ["delivery", "hash", "rerun", "match"]);
  assert.equal(report.local.pass, true);
  const without = await verifyTransaction(SEALED_TX, "judgenear-worker.testnet", { fetchImpl, wasmBytes: judge, job });
  assert.equal(reportOutcome(without), "needs-key", "without the delivery it is checked as far as the key allows");
  const other = await verifyTransaction(SEALED_TX, "judgenear-worker.testnet", { fetchImpl, wasmBytes: judge, delivery: `${text}.`, job });
  assert.equal(reportOutcome(other), "failed");
  assert.equal(other.steps.at(-1).id, "delivery");
});

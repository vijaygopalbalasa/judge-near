// The vault probe: the request it builds, and how it reads OutLayer's answer. Runs offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProbeArgs, classifyProbe } from "../lib/probe.mjs";

const JOB = {
  client: "judgenear-client.testnet", provider: "judgenear-worker.testnet", criteria: '{"checks":[]}', dh: "d".repeat(64),
  sealed: true, client_pk: "c".repeat(64), deliverable_ct: "QUJD", state: "Completed",
};
const JUDGE = { url: "https://raw.githubusercontent.com/x/y/z/judge.wasm", hash: "9".repeat(64), build_target: "wasm32-wasip1" };
const b64 = (s) => Buffer.from(s).toString("base64");

test("the probe asks for the published judge with the job's sealed input and secrets profile, but sealed to the probe's own key", () => {
  const args = buildProbeArgs({ job: JOB, judge: JUDGE, profile: "jn-abc-7", payer: "judgenear-worker.testnet", clientPk: "a".repeat(64) });
  assert.deepEqual(args.source, { WasmUrl: { url: JUDGE.url, hash: JUDGE.hash, build_target: "wasm32-wasip1" } });
  assert.deepEqual(args.secrets_ref, { profile: "jn-abc-7", account_id: "judgenear-worker.testnet" }, "the secret is the worker's, as in the escrow's request");
  assert.deepEqual(JSON.parse(args.input_data), { criteria: JOB.criteria, deliverable_ct: "QUJD", dh: JOB.dh, client_pk: "a".repeat(64) });
  assert.deepEqual(args.resource_limits, { max_instructions: 50_000_000_000, max_memory_mb: 64, max_execution_seconds: 30 });
  assert.equal(args.response_format, "Json");
  assert.equal(args.payer_account_id, "judgenear-worker.testnet");
  assert.throws(() => buildProbeArgs({ job: { ...JOB, sealed: false }, judge: JUDGE, profile: "p", payer: "a.testnet", clientPk: "a".repeat(64) }), /not sealed/);
  assert.throws(() => buildProbeArgs({ job: { ...JOB, deliverable_ct: "" }, judge: JUDGE, profile: "p", payer: "a.testnet", clientPk: "a".repeat(64) }), /no sealed delivery/);
});

/** A final transaction whose OutLayer receipts carry `logs` and return `returned`. */
const final = (logs, returned) => ({
  status: { SuccessValue: "" },
  receipts_outcome: [
    { outcome: { executor_id: "outlayer.testnet", logs: [], status: { SuccessValue: "" } } },
    { outcome: { executor_id: "outlayer.testnet", logs, status: { SuccessValue: returned === undefined ? "" : b64(returned) } } },
  ],
});

test("classifyProbe: refused, ran without the key, or got the key", () => {
  const refused = classifyProbe(final(['Execution failed: "Access denied by access condition \u2014 signer w.testnet, called from w.testnet. Check the access conditions configured by the secret owner.". Resources: {}'], "null"));
  assert.equal(refused.outcome, "refused");
  assert.match(refused.detail, /Access denied by access condition/);
  const noKey = classifyProbe(final([], '{"v":1,"pass":false,"score":0,"th":100,"ch":"x","dh":"y","checks":[],"err":"key_missing","eh":"z"}'));
  assert.equal(noKey.outcome, "no-key");
  const leaked = classifyProbe(final([], '{"v":1,"pass":true,"score":100,"th":100,"ch":"x","dh":"y","checks":[],"k":"AQ","eh":"z"}'));
  assert.equal(leaked.outcome, "got-the-key");
  assert.equal(classifyProbe(final(["something else"], "")).outcome, "unclear");
  const event = `EVENT_JSON:${JSON.stringify({ standard: "near-outlayer", event: "execution_completed", data: [{ success: false, error_message: "Access denied by access condition \u2014 signer c.testnet, called from c.testnet." }] })}`;
  assert.deepEqual(classifyProbe(final([event], "null")), { outcome: "refused", detail: "Access denied by access condition \u2014 signer c.testnet, called from c.testnet." }, "the event's own message, not the raw event");
});

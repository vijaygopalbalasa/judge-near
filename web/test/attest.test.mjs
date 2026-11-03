// The TEE attestation check (web/attest.js) against the twelve saved bundles in evidence/attestation/: each holds
// OutLayer's record for one ruling, the Intel collateral valid when it ran and the transaction's input and output.
// OutLayer's own verifier (outlayer-verify) proved all twelve; these tests hold the page's check to the same answers.
// No network: the record, the collateral and the chain's approval answer are served by a fake fetch.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ATTESTATION_API, DCAP_WASM_SHA256, REGISTER_CONTRACT, V1_CUTOFF, checkAttestation, decodeQuote, fmspcOf, loadDcap, taskHash } from "../attest.js";
import { RULINGS } from "../escrow.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = path.join(root, "evidence", "attestation");
const bundles = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ f, b: JSON.parse(readFileSync(path.join(dir, f), "utf8")) }));
const wasmBytes = readFileSync(path.join(root, "web", "vendor", "dcap-qvl-web", "dcap-qvl-web_bg.wasm"));
const JUDGE_V2 = "911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958";

/** A fetch that answers like OutLayer's API and a NEAR node would, from one bundle. */
function fakeNet(b, { record = b.attestation, collateral = {}, approved = true, fail = false } = {}) {
  const asked = [];
  const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (fail) throw new TypeError("network down");
    const u = new URL(url);
    if (u.origin === ATTESTATION_API && u.pathname === `/attestations/by-tx/${b.attestation.transaction_hash}`) return json(record);
    if (u.origin === ATTESTATION_API && u.pathname === "/public/collateral") {
      return json({ fmspc: u.searchParams.get("fmspc"), covers_requested_time: true, valid_from: b.collateral_info.valid_from, valid_until: b.collateral_info.valid_until,
        collateral: b.collateral, contract_id: b.register_contract, block_height: b.collateral_info.block_height, ...collateral });
    }
    const body = JSON.parse(init.body ?? "{}");
    if (body.method === "query" && body.params?.method_name === "is_measurements_approved") {
      const bytes = [...new TextEncoder().encode(JSON.stringify(approved))];
      return json({ jsonrpc: "2.0", id: body.id, result: { result: bytes, logs: [] } });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
  return { fetchImpl, asked };
}

const dcap = await loadDcap(wasmBytes);
/** What the ruling transaction itself says about the run (its execution_requested event and that receipt's block). */
const onChainOf = (a) => ({ signer: a.caller_account_id, requestId: a.request_id, wasmHash: a.wasm_hash, buildTarget: a.build_target,
  secretsRef: a.secrets_ref, projectId: null, attachedUsd: a.attached_usd, blockHeight: a.block_height, requestedAt: a.timestamp - 3 });
const run = (b, net, extra = {}) => checkAttestation(
  { tx: b.attestation.transaction_hash, input: b.input_raw, output: b.output_raw, onChain: onChainOf(b.attestation), ...extra },
  { dcap, fetchImpl: net.fetchImpl, rpc: ["https://rpc.example"] },
);
const verdicts = (report) => Object.fromEntries(report.steps.map((s) => [s.id, s.ok]));

test("the twelve bundles are the twelve rulings the page lists", () => {
  assert.equal(bundles.length, 12);
  assert.deepEqual(bundles.map(({ b }) => b.attestation.transaction_hash).sort(), RULINGS.map((r) => r.tx).sort());
});

test("fmspcOf reads the platform id from the PCK certificate inside each quote", () => {
  for (const { f, b } of bundles) assert.equal(fmspcOf(decodeQuote(b.attestation)), b.collateral_info.fmspc, f);
});

test("decodeQuote refuses a development placeholder and anything too short to be a TDX quote", () => {
  assert.throws(() => decodeQuote({ tdx_quote: btoa("no-attestation-dev-mode") }), /development mode/);
  assert.throws(() => decodeQuote({ tdx_quote: btoa("x".repeat(100)) }), /too short/);
});

test("taskHash rebuilds the commitment OutLayer's verifier expected, for all twelve rulings", async () => {
  for (const { f, b } of bundles) assert.equal(await taskHash(b.attestation), b.verification.expected_task_hash, f);
});

test("checkAttestation proves all twelve rulings: Intel signature, approved build, binding, input, output, judge", async () => {
  for (const { f, b } of bundles) {
    const report = await run(b, fakeNet(b));
    assert.deepEqual(verdicts(report), { record: true, judge: true, authenticity: true, identity: true, binding: true, input: true, output: true }, f);
    assert.equal(report.ok, true, f);
    assert.equal(report.tcbStatus, "UpToDate", f);
    assert.deepEqual(report.measurements, b.verification.measurements, f);
  }
});

test("Identity asks the register contract about the measurements in the verified quote", async () => {
  const { b } = bundles.at(-1);
  const net = fakeNet(b);
  await run(b, net);
  const call = net.asked.find((a) => a.body?.params?.method_name === "is_measurements_approved");
  assert.equal(call.body.params.account_id, REGISTER_CONTRACT);
  assert.deepEqual(JSON.parse(atob(call.body.params.args_base64)), { measurements: b.verification.measurements });
});

test("the collateral asked for is the platform's, as of the moment the run happened", async () => {
  const { b } = bundles[0];
  const net = fakeNet(b);
  await run(b, net);
  const u = new URL(net.asked.find((a) => a.url.includes("/public/collateral")).url);
  assert.equal(u.searchParams.get("fmspc"), b.collateral_info.fmspc);
  assert.equal(u.searchParams.get("at"), String(b.attestation.timestamp));
});

test("one flipped byte in the quote fails Authenticity, and Identity and Binding are then unproven", async () => {
  const { b } = bundles[0];
  const q = decodeQuote(b.attestation);
  q[700] ^= 0x01;
  const record = { ...b.attestation, tdx_quote: btoa(String.fromCharCode(...q)) };
  const v = verdicts(await run(b, fakeNet(b, { record })));
  assert.equal(v.authenticity, false);
  assert.equal(v.identity, null);
  assert.equal(v.binding, null);
});

test("a changed field in the record fails: the record check catches what the chain names, Binding the rest", async () => {
  const { b } = bundles.find(({ b }) => b.attestation.secrets_ref);
  // A field the transaction names (here the secrets reference) is caught before the quote is read.
  assert.equal(verdicts(await run(b, fakeNet(b, { record: { ...b.attestation, secrets_ref: "someone-else.testnet/profile" } }))).record, false);
  // The time moved by one second still sits inside the run's window, so only the signed hash can catch it.
  const report = await run(b, fakeNet(b, { record: { ...b.attestation, timestamp: b.attestation.timestamp + 1 } }));
  assert.equal(verdicts(report).record, true);
  assert.equal(verdicts(report).binding, false);
  assert.equal(report.ok, false);
});

test("an output that is not the transaction's fails Output, and a record for another wasm fails the judge check", async () => {
  const { b } = bundles[0];
  assert.equal(verdicts(await run(b, fakeNet(b), { output: `${b.output_raw} ` })).output, false);
  const other = { ...b.attestation, wasm_hash: "00".repeat(32) };
  const v = verdicts(await run(b, fakeNet(b, { record: other })));
  assert.equal(v.record, false, "the transaction names the wasm it asked for");
  // A ruling whose own request named an unpublished wasm passes the record check and fails the judge check.
  const unpublished = { ...onChainOf(b.attestation), wasmHash: "00".repeat(32) };
  const w = verdicts(await run(b, fakeNet(b, { record: other }), { onChain: unpublished }));
  assert.equal(w.record, true);
  assert.equal(w.judge, false);
});

test("measurements that are not approved fail Identity", async () => {
  const { b } = bundles[0];
  assert.equal(verdicts(await run(b, fakeNet(b, { approved: false }))).identity, false);
});

test("collateral that does not cover the run's moment leaves Authenticity unproven, not passed", async () => {
  const { b } = bundles[0];
  assert.equal(verdicts(await run(b, fakeNet(b, { collateral: { covers_requested_time: false } }))).authenticity, null);
});

test("a genuine quote whose platform Intel flags (TCB not UpToDate) leaves Authenticity unproven, not passed", async () => {
  const { b } = bundles[0];
  const flagged = { verify: (q, c, n) => ({ ...dcap.verify(q, c, n), status: "OutOfDate", advisory_ids: ["INTEL-SA-00837"] }) };
  const report = await checkAttestation(
    { tx: b.attestation.transaction_hash, input: b.input_raw, output: b.output_raw, onChain: onChainOf(b.attestation) },
    { dcap: flagged, fetchImpl: fakeNet(b).fetchImpl, rpc: ["https://rpc.example"] },
  );
  const step = report.steps.find((s) => s.id === "authenticity");
  assert.equal(step.ok, null);
  assert.match(step.detail, /OutOfDate.*INTEL-SA-00837/);
  assert.equal(report.ok, false);
});

// The signed hash has no length prefixes (outlayer-verify documents this), so a server could move bytes between
// neighbouring fields and still match it. Every field is therefore tied to the transaction's own request.
test("a record that re-splits its caller and secrets fields fails, although the signed hash would still match", async () => {
  const { b } = bundles.find(({ b }) => b.attestation.secrets_ref);
  const a = b.attestation;
  const [account, profile] = a.secrets_ref.split("/");
  const record = { ...a, caller_account_id: `${a.caller_account_id}${account}/`, secrets_ref: profile };
  assert.equal(await taskHash(record), await taskHash(a), "the re-split hashes the same");
  const report = await run(b, fakeNet(b, { record }));
  assert.equal(verdicts(report).record, false);
  assert.equal(report.ok, false);
});

test("a record that moves bytes between build_target and wasm_hash fails", async () => {
  const { b } = bundles[0];
  const a = b.attestation;
  const record = { ...a, build_target: a.build_target.slice(0, -1), wasm_hash: a.build_target.slice(-1) + a.wasm_hash };
  assert.equal(await taskHash(record), await taskHash(a));
  assert.equal(verdicts(await run(b, fakeNet(b, { record }))).record, false);
});

test("a record in the older format, which binds fewer fields, is refused", async () => {
  const { b } = bundles[0];
  const record = { ...b.attestation, timestamp: V1_CUTOFF - 1 };
  assert.equal(verdicts(await run(b, fakeNet(b, { record }), { onChain: { ...onChainOf(b.attestation), requestedAt: V1_CUTOFF - 4 } })).record, false);
});

test("a record whose time or block is not the on-chain request's is refused", async () => {
  const { b } = bundles[0];
  assert.equal(verdicts(await run(b, fakeNet(b), { onChain: { ...onChainOf(b.attestation), requestedAt: b.attestation.timestamp - 7200 } })).record, false);
  assert.equal(verdicts(await run(b, fakeNet(b), { onChain: { ...onChainOf(b.attestation), blockHeight: b.attestation.block_height + 1 } })).record, false);
});

test("each field the transaction names is checked on its own: caller, build target, hash format", async () => {
  const { b } = bundles[0];
  const chain = onChainOf(b.attestation);
  assert.equal(verdicts(await run(b, fakeNet(b), { onChain: { ...chain, signer: "someone-else.testnet" } })).record, false, "caller");
  assert.equal(verdicts(await run(b, fakeNet(b), { onChain: { ...chain, buildTarget: "wasm32-wasip2" } })).record, false, "build target");
  assert.equal(verdicts(await run(b, fakeNet(b), { onChain: { ...chain, requestId: chain.requestId + 1 } })).record, false, "request id");
  assert.equal(verdicts(await run(b, fakeNet(b), { onChain: { ...chain, attachedUsd: "5" } })).record, false, "attached payment");
  assert.equal(verdicts(await run(b, fakeNet(b), { onChain: { ...chain, projectId: "someone.testnet/project" } })).record, false, "project");
  const upper = { ...b.attestation, input_hash: b.attestation.input_hash.toUpperCase() };
  assert.equal(verdicts(await run(b, fakeNet(b, { record: upper }))).record, false, "hash format");
});

test("without the transaction's own request the record cannot be tied to it: unproven, not passed", async () => {
  const { b } = bundles[0];
  const report = await run(b, fakeNet(b), { onChain: undefined });
  assert.equal(verdicts(report).record, null);
  assert.equal(report.ok, false);
});

test("a network failure leaves every check unproven, never passed", async () => {
  const { b } = bundles[0];
  const report = await run(b, fakeNet(b, { fail: true }));
  assert.equal(report.ok, false);
  assert.ok(report.steps.every((s) => s.ok !== true), JSON.stringify(verdicts(report)));
});

test("the vendored DCAP verifier is pinned by SHA-256, and other bytes are refused", async () => {
  assert.equal(createHash("sha256").update(wasmBytes).digest("hex"), DCAP_WASM_SHA256);
  await assert.rejects(() => loadDcap(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])), /SHA-256/);
});

test("every record names judge v2, the build the escrow pins", () => {
  for (const { f, b } of bundles) assert.equal(b.attestation.wasm_hash, JUDGE_V2, f);
});

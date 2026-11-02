#!/usr/bin/env node
// Ask OutLayer directly, not through the escrow, to run the published judge on a sealed job with that job's
// secrets profile, the result sealed to a fresh key this process holds. The vault rule allows only the escrow as
// caller, so OutLayer should refuse, even when the worker who owns the secret signs. Dry run unless --send.
//
//   cd agents && npm ci && cd ..
//   node tools/vault-probe.mjs --job 7 --as judgenear-worker.testnet [--send]
//
// The signer's NEAR key is read by agents/lib/near.mjs inside this process and never printed. The probe's own
// X25519 secret lives only in memory; if OutLayer ever handed the judge the key, the verdict's k would be sealed
// to it and this tool says so.

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createNear } = await import(path.join(ROOT, "agents/lib/near.mjs"));
const { ACCOUNT_ID, DEFAULT_RPC_URL, OUTLAYER } = await import(path.join(ROOT, "agents/lib/config.mjs"));
const { buildProbeArgs, classifyProbe } = await import(path.join(ROOT, "agents/lib/probe.mjs"));
const { publicFromSecret } = await import(path.join(ROOT, "judge-wasm/scripts/sealed.mjs"));

const { values } = parseArgs({ options: { job: { type: "string" }, as: { type: "string" }, escrow: { type: "string" }, send: { type: "boolean" } }, strict: true });
const escrow = values.escrow ?? process.env.JN_ESCROW ?? "judgenear-escrow.testnet";
const signer = values.as;
if (!/^\d+$/.test(values.job ?? "") || !ACCOUNT_ID.test(signer ?? "") || !ACCOUNT_ID.test(escrow)) {
  console.error("usage: node tools/vault-probe.mjs --job N --as <account> [--escrow <account>] [--send]");
  process.exit(1);
}
const jobId = Number(values.job);
const near = createNear({ rpcUrl: process.env.JN_RPC || DEFAULT_RPC_URL, home: os.homedir() });

const job = await near.view(escrow, "get_job", { job_id: jobId });
if (!job) throw new Error(`no job ${jobId} on ${escrow}`);
const judge = await near.view(escrow, "get_judge", {});
const profile = await near.view(escrow, "get_secrets_profile", { job_id: jobId });
const probeSecret = crypto.randomBytes(32);
const clientPk = publicFromSecret(probeSecret).toString("hex");
const args = buildProbeArgs({ job, judge, profile, payer: signer, clientPk });
const call = { contractId: OUTLAYER, methodName: "request_execution", args, gasTgas: "300", depositYocto: "20000000000000000000000" };

console.log(JSON.stringify({ probe: { signer, receiver: OUTLAYER, method: "request_execution", deposit_near: "0.02", secrets_ref: args.secrets_ref, judge_hash: judge.hash, sealed_to: clientPk, escrow, job: jobId } }, null, 2));
if (!values.send) {
  console.log("dry run: add --send to sign this as " + signer);
  process.exit(0);
}

const sent = await near.call(signer, call, { waitUntil: "INCLUDED_FINAL" });
console.log(`request_execution sent; tx ${sent.txHash}; waiting for OutLayer`);
let final;
for (let i = 0; i < 60 && !final; i++) {
  try {
    const s = await near.txStatus(sent.txHash, signer);
    if (s?.status && ("SuccessValue" in s.status || "Failure" in s.status)) final = s;
  } catch {
    // still pending
  }
  if (!final) await new Promise((r) => setTimeout(r, 5000));
}
if (!final) {
  console.log(`no final result after 5 minutes; tx ${sent.txHash}`);
  process.exit(1);
}
const result = classifyProbe(final);
console.log(`outcome: ${result.outcome}`);
console.log(`OutLayer: ${result.detail}`);
console.log(`tx ${sent.txHash}`);
if (result.outcome === "got-the-key") process.exit(2);

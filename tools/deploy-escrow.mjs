#!/usr/bin/env node
// Deploy the published escrow build to a testnet account and initialise it, in ONE transaction
// (deploy + new), so the code is never live without its settings. Dry run unless --send.
//
//   cd agents && npm ci && cd ..
//   node tools/deploy-escrow.mjs --account <escrow account id> [--send]
//   node tools/deploy-escrow.mjs --account <escrow account id> --upgrade-from <code hash> [--send]
//
// --upgrade-from replaces the code of an escrow that runs exactly that earlier build (base58 code
// hash) with the published build, code only: no init call, so its settings and jobs stay as they
// are, and the tool checks afterwards that get_judge and every job read back unchanged. The new
// code must read the old state as it is (contract/BUILD.md says when a build changes the layout).
//
// Before anything is signed it checks: the wasm file is the build contract/BUILD.md publishes,
// the judge URL serves exactly the published judge (judge-wasm/release/judge.wasm.sha256), and the
// account runs no code yet. All five settings are permanent: the contract has no owner and no
// setter. The account's key is read by agents/lib/near.mjs inside this process and never printed.
// This is how judgenear-escrow.testnet was deployed (README, "The escrow on testnet").

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Account, JsonRpcProvider, actions, teraToGas } = await import(path.join(ROOT, "agents/node_modules/near-api-js/lib/index.js"));
const { loadAccountKey } = await import(path.join(ROOT, "agents/lib/near.mjs"));
const { ACCOUNT_ID, DEFAULT_RPC_URL, OUTLAYER, PUBLISHED_ESCROW_CODE_HASH } = await import(path.join(ROOT, "agents/lib/config.mjs"));

// The judge OutLayer downloads: judge v2, pinned to the commit that published it.
const JUDGE_URL = "https://raw.githubusercontent.com/vijaygopalbalasa/judge-near/fd3dcc65a9f616a6c7e9dc411a65de50560e2ed6/judge-wasm/release/judge.wasm";
const MIN_RULING_DEPOSIT = "10000000000000000000000"; // 0.01 NEAR; OutLayer refunds what a run does not use
const EMPTY_CODE_HASH = "11111111111111111111111111111111";

const { values } = parseArgs({ options: { account: { type: "string" }, send: { type: "boolean" }, "upgrade-from": { type: "string" } }, strict: true });
const account = values.account;
if (typeof account !== "string" || !ACCOUNT_ID.test(account) || !account.endsWith(".testnet")) {
  console.error("usage: node tools/deploy-escrow.mjs --account <escrow account>.testnet [--send]");
  process.exit(1);
}
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// 1. The wasm is the published build.
const wasmPath = path.join(ROOT, "contract/target/near/judge_escrow.wasm");
const code = fs.readFileSync(wasmPath);
const build = fs.readFileSync(path.join(ROOT, "contract/BUILD.md"), "utf8");
const publishedHex = /### Escrow: judge_escrow\.wasm[\s\S]*?SHA-256 hex: `([0-9a-f]{64})`/.exec(build)?.[1];
console.log(`escrow wasm: ${code.length} bytes, sha256 ${sha256(code)}`);
if (!publishedHex || sha256(code) !== publishedHex) {
  throw new Error(`the wasm is not the build contract/BUILD.md publishes (${publishedHex}); build it with the command in contract/BUILD.md`);
}

// 2. The judge URL serves the published judge.
const judgeHash = fs.readFileSync(path.join(ROOT, "judge-wasm/release/judge.wasm.sha256"), "utf8").trim().split(/\s+/)[0];
const res = await fetch(JUDGE_URL);
if (!res.ok) throw new Error(`could not download the judge: HTTP ${res.status}`);
const served = sha256(new Uint8Array(await res.arrayBuffer()));
console.log(`judge at the pinned URL: sha256 ${served}`);
if (served !== judgeHash) throw new Error(`the judge URL serves ${served}, not the published judge ${judgeHash}`);

const args = { outlayer: OUTLAYER, judge_url: JUDGE_URL, judge_hash: judgeHash, build_target: "wasm32-wasip1", min_ruling_deposit: MIN_RULING_DEPOSIT };
const provider = new JsonRpcProvider({ url: process.env.JN_RPC || DEFAULT_RPC_URL });
const before = await provider.viewAccount({ accountId: account });

if (values["upgrade-from"] !== undefined) {
  // 3u. An upgrade: the account runs exactly the named earlier build; deploy code only.
  const from = values["upgrade-from"];
  if (before.code_hash !== from) throw new Error(`${account} runs ${before.code_hash}, not ${from}; not upgrading`);
  if (from === PUBLISHED_ESCROW_CODE_HASH) throw new Error("the account already runs the published build");
  const readState = async () => {
    const judge = await provider.callFunction({ contractId: account, method: "get_judge", args: {} });
    const jobs = [];
    for (let from_index = 0; ; from_index += 10) {
      const page = await provider.callFunction({ contractId: account, method: "list_jobs", args: { from_index, limit: 10 } });
      jobs.push(...page);
      if (page.length < 10) break;
    }
    return { judge, jobs };
  };
  const was = await readState();
  console.log(`upgrade ${account}: ${from} -> the published build ${PUBLISHED_ESCROW_CODE_HASH}, code only; ${was.jobs.length} jobs, get_judge ${JSON.stringify(was.judge)}`);
  if (!values.send) {
    console.log(`dry run: all checks passed; add --send to deploy the new code to ${account}`);
    process.exit(0);
  }
  const signer = new Account(account, provider, loadAccountKey(os.homedir(), account));
  const out = await signer.signAndSendTransaction({ receiverId: account, actions: [actions.deployContract(new Uint8Array(code))], waitUntil: "FINAL" });
  console.log(`deployed: tx ${out?.transaction?.hash ?? out?.transaction_outcome?.id}`);
  const after = await provider.viewAccount({ accountId: account });
  const now = await readState();
  const same = JSON.stringify(now) === JSON.stringify(was);
  console.log(`code_hash ${after.code_hash} (${after.code_hash === PUBLISHED_ESCROW_CODE_HASH ? "the published build" : "NOT the published build"}); get_judge and all ${now.jobs.length} jobs ${same ? "read back unchanged" : "CHANGED"}`);
  process.exit(after.code_hash === PUBLISHED_ESCROW_CODE_HASH && same ? 0 : 1);
}

console.log(`init args (permanent): ${JSON.stringify(args)}`);
// 3. The account exists and runs no code yet.
if (before.code_hash !== EMPTY_CODE_HASH) throw new Error(`${account} already runs code ${before.code_hash}; this tool deploys only to an empty account`);
if (!values.send) {
  console.log(`dry run: all checks passed; add --send to deploy to ${account}`);
  process.exit(0);
}

const signer = new Account(account, provider, loadAccountKey(os.homedir(), account));
const out = await signer.signAndSendTransaction({
  receiverId: account,
  actions: [actions.deployContract(new Uint8Array(code)), actions.functionCall("new", args, teraToGas("30"), 0n)],
  waitUntil: "FINAL",
});
console.log(`deployed and initialised: tx ${out?.transaction?.hash ?? out?.transaction_outcome?.id}`);

const after = await provider.viewAccount({ accountId: account });
const judge = await provider.callFunction({ contractId: account, method: "get_judge", args: {} });
console.log(`code_hash ${after.code_hash} (${after.code_hash === PUBLISHED_ESCROW_CODE_HASH ? "the published build" : "NOT the published build"})`);
console.log(`get_judge ${JSON.stringify(judge)}`);
if (after.code_hash !== PUBLISHED_ESCROW_CODE_HASH || judge?.hash !== judgeHash || judge?.url !== JUDGE_URL) process.exit(1);

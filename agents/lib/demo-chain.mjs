// An in-memory stand-in for the testnet escrow and OutLayer, for the offline demo (demo.mjs) and the agents' tests.
// Jobs move as the agents call them, and request_ruling runs the real published judge with the key the stand-in
// keystore received, so the agents, the encryption and the judge are the real ones. Nothing here opens a network
// connection or a key file.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicFromSecret } from "../../judge-wasm/scripts/sealed.mjs";
import { runJudge } from "../../web/verify.js";
import { PUBLISHED_ESCROW_CODE_HASH } from "./config.mjs";
import { eciesDecrypt, secretsProfile } from "./keystore.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const judge = new Uint8Array(fs.readFileSync(path.join(ROOT, "judge-wasm", "release", "judge.wasm")));
const JUDGE_HASH = fs.readFileSync(path.join(ROOT, "judge-wasm", "release", "judge.wasm.sha256"), "utf8").split(/\s+/)[0];
const b64 = (s) => Buffer.from(s).toString("base64");
const sha256hex = (x) => crypto.createHash("sha256").update(x).digest("hex");

function check(ok, message) {
  if (!ok) throw new Error(`demo chain: ${message}`);
}

/** One clock for both roles: sleeping moves it forward and lets the other role run. */
export function fakeClock(start = 1_762_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      // One real millisecond per fake wait, so the fake clock cannot race far ahead of real work.
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
}

/**
 * A stateful escrow and OutLayer: {near, fetch, jobs, calls, secrets}. `near` and `fetch` take the place of the
 * agents' NEAR connection and HTTP client. `existing` are jobs already on the escrow; with `dropSecrets` the keystore
 * forgets every key it is given, as a broken keystore would.
 */
export function fakeChain(existing = [], { escrow, dropSecrets = false } = {}) {
  check(typeof escrow === "string", "name the escrow account");
  const keystoreSecret = crypto.randomBytes(32);
  const jobs = existing.map((j) => ({ ...j }));
  const secrets = new Map();
  const finals = new Map();
  const calls = [];
  let n = 0;
  const near = {
    codeHash: async () => PUBLISHED_ESCROW_CODE_HASH,
    view: async (contract, method, args) => {
      check(contract === escrow, `a view on ${contract}, not the escrow`);
      if (method === "get_judge") return { outlayer: "outlayer.testnet", url: "https://example.test/judge.wasm", hash: JUDGE_HASH, build_target: "wasm32-wasip1", min_ruling_deposit: "10000000000000000000000" };
      if (method === "get_secrets_profile") return jobs[args.job_id]?.sealed ? secretsProfile(escrow, args.job_id) : null;
      if (method === "get_job") return jobs[args.job_id] ? { ...jobs[args.job_id] } : null;
      if (method === "list_jobs") return jobs.slice(args.from_index, args.from_index + args.limit).map((j) => ({ ...j }));
      throw new Error(`demo chain: unexpected view ${method}`);
    },
    call: async (signer, c) => {
      const txHash = `tx${++n}`;
      const a = c.args;
      calls.push({ signer, contract: c.contractId, method: c.methodName, job: a.job_id });
      const ok = (value) => ({ txHash, outcome: { status: { SuccessValue: value === undefined ? "" : b64(JSON.stringify(value)) } } });
      if (c.contractId === "outlayer.testnet" && c.methodName === "store_secrets") {
        if (!dropSecrets) secrets.set(a.profile, JSON.parse(eciesDecrypt(keystoreSecret, a.encrypted_secrets_base64)).JN_KEY);
        return ok();
      }
      if (c.contractId === "outlayer.testnet" && c.methodName === "delete_secrets") {
        check(c.depositYocto === "0", "delete_secrets takes no deposit");
        secrets.delete(a.profile);
        return ok();
      }
      check(c.contractId === escrow, `a call to ${c.contractId}, not the escrow`);
      const j = jobs[a.job_id];
      switch (c.methodName) {
        case "create_job":
          jobs.push({
            client: signer, provider: a.provider, criteria: a.criteria, ch: sha256hex(a.criteria), deliverable: "", dh: "",
            sealed: Boolean(a.client_pk), client_pk: a.client_pk ?? null, deliverable_ct: "", k: null, amount: "0", state: "Open",
            expires_at_ns: a.expires_at_ns, attempt: "0", created_at_ns: "1",
          });
          return ok(jobs.length - 1);
        case "fund":
          check(j.client === signer && j.state === "Open", "only the client funds an Open job");
          Object.assign(j, { amount: c.depositYocto, state: "Funded" });
          return ok();
        case "submit_sealed":
          check(j.provider === signer && j.state === "Funded", "only the provider submits to a Funded job");
          Object.assign(j, { deliverable_ct: a.deliverable_ct, dh: a.dh, state: "Submitted" });
          return ok();
        case "request_ruling": {
          check([j.client, j.provider].includes(signer) && j.state === "Submitted", "only a party asks, on a Submitted job");
          const key = secrets.get(secretsProfile(escrow, a.job_id));
          const text = await runJudge(judge, JSON.stringify({ criteria: j.criteria, deliverable_ct: j.deliverable_ct, dh: j.dh, client_pk: j.client_pk }), key ? { JN_KEY: key } : {});
          const verdict = JSON.parse(text);
          j.attempt = String(Number(j.attempt) + 1);
          if (verdict.err === "key_missing") j.state = "Submitted";
          else if (verdict.pass) Object.assign(j, { state: "Completed", k: verdict.k });
          else j.state = "Refunded";
          finals.set(txHash, { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: "outlayer.testnet", logs: [], status: { SuccessValue: b64(text) } } }] });
          return { txHash, outcome: {} };
        }
        default:
          throw new Error(`demo chain: unexpected call ${c.methodName}`);
      }
    },
    txStatus: async (txHash) => {
      if (!finals.has(txHash)) throw new Error("pending");
      return finals.get(txHash);
    },
  };
  const fetch = async () => ({ ok: true, json: async () => ({ pubkey: publicFromSecret(keystoreSecret).toString("hex") }) });
  return { near, fetch, jobs, calls, secrets };
}

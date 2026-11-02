// Read the testnet escrow's jobs for the page: its code hash, its judge and every job, through
// read-only RPC calls. Nothing here signs or sends anything.

import { TESTNET_ARCHIVAL_RPCS, rpcCall } from "./verify.js";

/** The escrow deployed on testnet (README, "The escrow on testnet"). */
export const ESCROW = "judgenear-escrow.testnet";

/** NEAR's code hash (base58 SHA-256) of the escrow build in contract/BUILD.md. */
export const PUBLISHED_ESCROW_CODE_HASH = "Cvs46Mpm96grgs3GdU4Cpyx3PTRiJZifHDXrWRm2qpga";

/** Current state (jobs, judge, code hash, keys) comes from regular testnet nodes, FastNEAR's first (0.2 to 0.5 s a
 *  call against 3 to 4 s for NEAR's, measured Nov 2 2026); the archival nodes are the fallback. */
export const TESTNET_STATE_RPCS = Object.freeze(["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org", ...TESTNET_ARCHIVAL_RPCS]);

/**
 * The rulings of the escrow's jobs, as listed in the README's table. The chain has no index from a
 * job to its ruling transactions, so they are listed here; each Verify also checks that the
 * transaction's request_ruling call names this job of this escrow.
 */
export const RULINGS = Object.freeze([
  { job: 0, tx: "G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1", signer: "judgenear-worker.testnet" },
  { job: 1, tx: "GgZvjQg35vQfMsdRovKP6ze3faQyutKFkBDDzLm7JfCT", signer: "judgenear-client.testnet" },
  { job: 2, tx: "5nC2ABEDbFKFzVY8nzVaJooyD3uW2xxpbH2VuvgcYNsh", signer: "judgenear-worker.testnet" },
  { job: 3, tx: "3sCPetXoYFwuoyStnKmjZHiLnh1rBQW9nKNyGvyfCAib", signer: "judgenear-client.testnet" },
  { job: 4, tx: "J5hX6nup9AjXM4hsGXcRf29u279RAgseK3qZ9A8HPNt3", signer: "judgenear-worker.testnet", keyMissing: true },
  { job: 4, tx: "5G6jQja3xjvw6tnzkmpE3P86Sracs5PFStJJP38o4a2J", signer: "judgenear-worker.testnet" },
  { job: 5, tx: "5E4FiCfc1CQ7ywUeEDZ9jVMpkronjaCH4oNWWqM8hN71", signer: "judgenear-worker.testnet" },
  { job: 6, tx: "7rjHmFL8w9keTZVf1ybXVawxGTQibVdpkJxEWa2xCn7r", signer: "judgenear-worker.testnet" },
  { job: 7, tx: "HbByxt3x5HdNwwx8PxNWjAu5FpLATbUpr719K8uTexwB", signer: "judgenear-worker.testnet" },
  { job: 8, tx: "42xXF6fnYPHWEuqc1HUHK7fPDJ9MmwWXXdFYB2SuCq72", signer: "judgenear-worker.testnet" },
].map((r) => Object.freeze(r)));

/** How secret each sealed demo job's delivery is (README, "The escrow on testnet"). */
export const JOB_NOTES = Object.freeze({
  2: "Demo: seals job 0's public text (same dh), so its content is not secret.",
  3: "Demo: seals job 1's public text (same dh), so its content is not secret.",
  4: "Demo: seals job 0's public text (same dh), so its content is not secret.",
  5: "Demo: a report built only from public facts, with no nonce, so its dh can be matched by guessing: not secret.",
  6: "Demo: a report built only from public facts, with no nonce, so its dh can be matched by guessing: not secret.",
  7: "The report ends with a random nonce, so its dh gives nothing away.",
  8: "The report ends with a random nonce, so its dh gives nothing away.",
});

/**
 * The disclosed delivery of a sealed job, if a public job on the escrow delivered text with the same dh:
 * {text, fromJob}, else null. The verifier still checks that the text hashes to dh before using it.
 */
export function disclosedDelivery(job, jobs) {
  if (!job?.sealed || typeof job.dh !== "string" || !/^[0-9a-f]{64}$/.test(job.dh)) return null;
  const open = jobs.find((p) => !p.sealed && p.dh === job.dh && typeof p.deliverable === "string");
  return open ? { text: open.deliverable, fromJob: open.id } : null;
}

const PAGE_SIZE = 10;
const MAX_PAGES = 100;

/** Call a view method and parse its JSON result. */
async function viewFunction(account, method, args, { rpc, fetchImpl }) {
  const result = await rpcCall(rpc, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  }, fetchImpl);
  if (!Array.isArray(result?.result)) throw new Error(`${method} on ${account} failed: ${result?.error ?? "no result"}`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
}

/**
 * The escrow's code hash, its full-access keys, its judge and every job; the first four reads go out at
 * once. A full-access key can deploy new code to the account, so none means nobody can replace the
 * escrow's code. The contract never removes a job (create_job takes next_id and increments it), so the
 * n-th entry of list_jobs(from_index) is job from_index + n.
 */
export async function readEscrow(escrow = ESCROW, { rpc = TESTNET_STATE_RPCS, fetchImpl = globalThis.fetch } = {}) {
  const [account, keys, judge, first] = await Promise.all([
    rpcCall(rpc, "query", { request_type: "view_account", finality: "final", account_id: escrow }, fetchImpl),
    rpcCall(rpc, "query", { request_type: "view_access_key_list", finality: "final", account_id: escrow }, fetchImpl),
    viewFunction(escrow, "get_judge", {}, { rpc, fetchImpl }),
    viewFunction(escrow, "list_jobs", { from_index: 0, limit: PAGE_SIZE }, { rpc, fetchImpl }),
  ]);
  const jobs = [];
  let list = first;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (!Array.isArray(list)) throw new Error(`list_jobs on ${escrow} did not return a list`);
    const from = page * PAGE_SIZE;
    list.forEach((job, n) => jobs.push({ id: from + n, ...job }));
    if (list.length < PAGE_SIZE) break;
    list = await viewFunction(escrow, "list_jobs", { from_index: from + PAGE_SIZE, limit: PAGE_SIZE }, { rpc, fetchImpl });
  }
  const fullAccessKeys = (Array.isArray(keys?.keys) ? keys.keys : []).filter((k) => k?.access_key?.permission === "FullAccess").length;
  return { escrow, blockHeight: account.block_height, codeHash: account.code_hash, publishedBuild: account.code_hash === PUBLISHED_ESCROW_CODE_HASH, fullAccessKeys, judge, jobs };
}

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

/** A link to one transaction, ?tx=<hash>&signer=<account>: {tx, signer}, or null when either is missing or malformed. */
export function parseDeepLink(search) {
  const q = new URLSearchParams(search ?? "");
  const tx = q.get("tx");
  const signer = q.get("signer");
  if (!tx || !signer || !TX_HASH.test(tx) || !ACCOUNT_ID.test(signer)) return null;
  return { tx, signer };
}

/** A yoctoNEAR amount (decimal string) as NEAR, exactly. */
export function formatNear(yocto) {
  if (typeof yocto !== "string" || !/^\d+$/.test(yocto)) throw new Error(`not a yoctoNEAR amount: ${yocto}`);
  const digits = yocto.replace(/^0+(?=\d)/, "").padStart(25, "0");
  const whole = digits.slice(0, -24).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-24).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} NEAR`;
}

/** A nanosecond timestamp (a job's created_at_ns) as "YYYY-MM-DD HH:MM UTC"; "" when it is not one. */
export function formatTime(ns) {
  if (typeof ns !== "string" || !/^\d+$/.test(ns)) return "";
  const d = new Date(Number(BigInt(ns) / 1_000_000n));
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** What happened to a job, in one line. */
export function jobOutcome(job) {
  switch (job.state) {
    case "Completed":
      return job.sealed && job.k ? "Passed: the escrow paid the worker and released the key to the client in the same step." : "Passed: the escrow paid the worker.";
    case "Refunded":
      return job.sealed && !job.k ? "Refunded to the client; the key was never released, so the delivery stays sealed." : "Refunded to the client.";
    case "Open":
      return "Created; waiting for the client to fund it.";
    case "Funded":
      return "Funded; waiting for the delivery.";
    case "Submitted":
      return "Delivered; waiting for a ruling.";
    case "Ruling":
      return "OutLayer is running the judge.";
    default:
      return `Unknown state: ${job.state}`;
  }
}




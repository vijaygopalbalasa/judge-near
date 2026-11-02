// Read the testnet escrow's jobs for the page: its code hash, its judge and every job, through
// read-only RPC calls. Nothing here signs or sends anything.

import { TESTNET_ARCHIVAL_RPCS, rpcCall } from "./verify.js";

/** The escrow deployed on testnet (README, "The escrow on testnet"). */
export const ESCROW = "judgenear-escrow.testnet";

/** NEAR's code hash (base58 SHA-256) of the escrow build in contract/BUILD.md. */
export const PUBLISHED_ESCROW_CODE_HASH = "Cvs46Mpm96grgs3GdU4Cpyx3PTRiJZifHDXrWRm2qpga";

/** Current state (jobs, judge, code hash) comes from regular testnet nodes; the archival nodes are the fallback. */
export const TESTNET_STATE_RPCS = Object.freeze(["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com", ...TESTNET_ARCHIVAL_RPCS]);

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
  { job: 4, tx: "J5hX6nup9AjXM4hsGXcRf29u279RAgseK3qZ9A8HPNt3", signer: "judgenear-worker.testnet" },
  { job: 4, tx: "5G6jQja3xjvw6tnzkmpE3P86Sracs5PFStJJP38o4a2J", signer: "judgenear-worker.testnet" },
].map((r) => Object.freeze(r)));

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
 * The escrow's code hash, its judge and every job. The contract never removes a job (create_job
 * takes next_id and increments it), so the n-th entry of list_jobs(from_index) is job from_index + n.
 */
export async function readEscrow(escrow = ESCROW, { rpc = TESTNET_STATE_RPCS, fetchImpl = globalThis.fetch } = {}) {
  const account = await rpcCall(rpc, "query", { request_type: "view_account", finality: "final", account_id: escrow }, fetchImpl);
  const judge = await viewFunction(escrow, "get_judge", {}, { rpc, fetchImpl });
  const jobs = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const list = await viewFunction(escrow, "list_jobs", { from_index: from, limit: PAGE_SIZE }, { rpc, fetchImpl });
    if (!Array.isArray(list)) throw new Error(`list_jobs on ${escrow} did not return a list`);
    list.forEach((job, n) => jobs.push({ id: from + n, ...job }));
    if (list.length < PAGE_SIZE) break;
  }
  return { escrow, blockHeight: account.block_height, codeHash: account.code_hash, publishedBuild: account.code_hash === PUBLISHED_ESCROW_CODE_HASH, judge, jobs };
}

/** A yoctoNEAR amount (decimal string) as NEAR, exactly. */
export function formatNear(yocto) {
  if (typeof yocto !== "string" || !/^\d+$/.test(yocto)) throw new Error(`not a yoctoNEAR amount: ${yocto}`);
  const digits = yocto.replace(/^0+(?=\d)/, "").padStart(25, "0");
  const whole = digits.slice(0, -24).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-24).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} NEAR`;
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

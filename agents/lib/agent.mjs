// The two agents. The client posts a sealed job and funds it, then waits for the escrow to settle;
// the worker watches the escrow for funded sealed jobs that name it, delivers its report sealed and
// asks for the ruling. They share nothing but the chain: each reads the escrow and acts through the
// same commands as jn.mjs, with the same deps. Neither prints a secret; the worker never prints its
// report (only the client, after the key is released to it, opens and shows it).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nearToYocto } from "near-api-js";
import { formatNear } from "../../web/escrow.js";
import { runJudge } from "../../web/verify.js";
import { COMMANDS } from "./commands.mjs";
import { ACCOUNT_ID } from "./config.mjs";
import { deliverableFor, escrowFacts } from "./skill.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 10;
const POLL_MS = 5_000;
const SETTLED = new Set(["Completed", "Refunded"]);
const MIN_AMOUNT_NEAR = "0.1";

/** Text from the chain or from another party, made safe for a terminal: control characters other than newline and tab are shown as \xNN. */
export function printable(text) {
  return String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
const say = (deps, text) => deps.out(printable(text));

let judgeBytes;
/** The published judge (judge-wasm/release/judge.wasm), run here on a plain report: the same checks OutLayer runs on the decrypted delivery. */
async function judgeHere(criteria, deliverable) {
  judgeBytes ??= new Uint8Array(fs.readFileSync(path.join(HERE, "..", "..", "judge-wasm", "release", "judge.wasm")));
  return JSON.parse(await runJudge(judgeBytes, JSON.stringify({ criteria, deliverable })));
}
const failedChecks = (verdict) => (verdict.checks ?? []).filter((c) => !c.ok).map((c) => `${c.id} failed`).join(", ");

const minutes = (ms) => (Math.round(ms / 60_000) === 1 ? "1 minute" : `${Math.round(ms / 60_000)} minutes`);

function account(id, flag) {
  if (typeof id !== "string" || !ACCOUNT_ID.test(id)) throw new Error(`${flag} needs a NEAR account id`);
  return id;
}
function escrowOf(deps) {
  return account(deps.env.JN_ESCROW, "JN_ESCROW");
}

/** Every job on the escrow, numbered by place (the contract never removes a job). */
async function listJobs(escrow, deps) {
  const jobs = [];
  for (let from = 0; from < 100_000; from += PAGE) {
    const page = await deps.near.view(escrow, "list_jobs", { from_index: from, limit: PAGE });
    if (!Array.isArray(page)) throw new Error(`list_jobs on ${escrow} did not return a list`);
    page.forEach((job, n) => jobs.push({ id: from + n, ...job }));
    if (page.length < PAGE) break;
  }
  return jobs;
}

function readTask(file) {
  if (typeof file !== "string" || !file) throw new Error("--task needs a criteria file");
  return fs.readFileSync(file, "utf8");
}

/** Price, skill, then the judge run here: only then deliver sealed and ask for the ruling. Returns what happened. */
async function workOn(job, jobs, { escrow, me, minYocto, deliverAnyway }, deps) {
  if (BigInt(job.amount) < minYocto) {
    say(deps, `job ${job.id}: pays ${formatNear(job.amount)}, below this worker's minimum of ${formatNear(minYocto.toString())}; not delivering, nothing signed`);
    return { jobId: job.id, declined: "below the minimum price" };
  }
  let report;
  try {
    // A fresh 128-bit nonce in every report: the sealed delivery's dh is public, so it must not be guessable.
    report = deliverableFor(job.criteria, escrowFacts({ escrow, jobId: job.id, jobs, now: deps.now() }), { nonce: deps.rng(16).toString("hex") });
  } catch (e) {
    say(deps, `job ${job.id}: skipped (${e.message}); nothing signed`);
    return { jobId: job.id, skipped: e.message };
  }
  const fields = Object.keys(JSON.parse(report.text)).filter((k) => k !== "nonce").length;
  const total = fields + report.missing.length;
  say(deps, `job ${job.id}: funded by ${job.client} with ${formatNear(job.amount)}; ${fields} of the ${total} fields its criteria require are ready`
    + (report.missing.length ? `; no fact for ${report.missing.join(", ")}, so it is left out` : ""));
  // Delivering costs the worker a vault deposit, storage and gas: check the report with the judge first.
  const local = await judgeHere(job.criteria, report.text);
  if (!local.pass) {
    const why = `the judge, run here, would fail this report (score ${local.score}${failedChecks(local) ? `: ${failedChecks(local)}` : ""})`;
    if (!deliverAnyway) {
      say(deps, `job ${job.id}: ${why}; not delivering, nothing signed`);
      return { jobId: job.id, declined: "the judge would fail it", verdict: local, missing: report.missing };
    }
    say(deps, `job ${job.id}: ${why}; delivering it anyway (--deliver-anyway)`);
  }
  say(deps, `job ${job.id}: delivering the report sealed`);

  // submit-sealed reads the delivery from a file: a private directory, removed right after.
  const dir = fs.mkdtempSync(path.join(deps.tmpdir ?? os.tmpdir(), "jn-worker-"));
  try {
    const file = path.join(dir, `job-${job.id}.json`);
    fs.writeFileSync(file, report.text, { mode: 0o600, flag: "wx" });
    await COMMANDS["submit-sealed"]({ as: me, job: String(job.id), file }, deps);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ruling = await COMMANDS.ruling({ as: me, job: String(job.id) }, deps);
  const v = ruling.verdict;
  if (ruling.pending || !v) {
    say(deps, `job ${job.id}: no verdict yet; ruling tx ${ruling.txHash}`);
  } else if (v.err === "key_missing") {
    say(deps, `job ${job.id}: no key reached the judge (key_missing); no money moved and the job is back at Submitted; ruling tx ${ruling.txHash}`);
  } else {
    say(deps, `job ${job.id}: the judge ${v.pass ? "passed" : "failed"} it (score ${v.score}); ${v.pass ? "the escrow pays the worker and releases the key to the client" : "the client is refunded and the delivery stays sealed"}; ruling tx ${ruling.txHash}`);
  }
  return { jobId: job.id, rulingTx: ruling.txHash, verdict: v, missing: report.missing };
}

/** worker --as WORKER [--once] [--min-amount 0.1] [--deliver-anyway]: deliver every funded sealed job that names WORKER, pays at least the minimum, and passes the judge run here. */
export async function runWorker(opts, deps) {
  const escrow = escrowOf(deps);
  const me = account(opts.as, "--as");
  const minAmount = String(opts.minAmount ?? MIN_AMOUNT_NEAR);
  if (!/^\d+(\.\d+)?$/.test(minAmount)) throw new Error("--min-amount needs a NEAR amount");
  const minYocto = BigInt(nearToYocto(minAmount).toString());
  const deliverAnyway = Boolean(opts.deliverAnyway);
  const pollMs = opts.pollMs ?? POLL_MS;
  const waitMs = opts.waitMs ?? 30 * 60_000;
  const handled = new Set();
  const results = [];
  let idleSince = deps.now();
  say(deps, `worker ${me}: watching ${escrow} for funded sealed jobs that name ${me} and pay at least ${formatNear(minYocto.toString())}`);
  for (;;) {
    let jobs;
    try {
      jobs = await listJobs(escrow, deps);
    } catch (e) {
      say(deps, `reading the escrow failed (${e.message}); trying again in ${pollMs / 1000} s`);
      await deps.sleep(pollMs);
      continue;
    }
    const job = jobs.find((j) => j.provider === me && j.sealed && j.state === "Funded" && !handled.has(j.id));
    if (job) {
      handled.add(job.id);
      const result = await workOn(job, jobs, { escrow, me, minYocto, deliverAnyway }, deps);
      if (opts.once) return result;
      results.push(result);
      idleSince = deps.now();
      continue;
    }
    if (deps.now() - idleSince >= waitMs) {
      if (opts.once || results.length === 0) throw new Error(`no funded sealed job for ${me} appeared within ${minutes(waitMs)}`);
      return { results };
    }
    await deps.sleep(pollMs);
  }
}

/** client --as CLIENT --provider WORKER --task criteria.json: post, fund, wait, open. */
export async function runClient(opts, deps) {
  const escrow = escrowOf(deps);
  const me = account(opts.as, "--as");
  const provider = account(opts.provider, "--provider");
  const pollMs = opts.pollMs ?? POLL_MS;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  readTask(opts.task);
  say(deps, `client ${me}: posting a sealed job for ${provider} with the criteria in ${path.basename(opts.task)}`);
  const { jobId } = await COMMANDS.create({ as: me, provider, criteria: opts.task, "expires-in": opts.expiresIn ?? "2h", sealed: true }, deps);
  if (!Number.isSafeInteger(jobId)) throw new Error("create_job returned no job id");
  await COMMANDS.fund({ as: me, job: String(jobId), amount: opts.amount ?? "0.5" }, deps);
  say(deps, `job ${jobId}: waiting for ${provider} to deliver and for the judge`);
  const started = deps.now();
  let state;
  for (;;) {
    let job;
    try {
      job = await deps.near.view(escrow, "get_job", { job_id: jobId });
    } catch (e) {
      say(deps, `reading job ${jobId} failed (${e.message}); trying again in ${pollMs / 1000} s`);
      await deps.sleep(pollMs);
      continue;
    }
    if (job?.state !== state) {
      state = job?.state;
      say(deps, `job ${jobId}: ${state}`);
    }
    if (SETTLED.has(state)) break;
    if (deps.now() - started >= timeoutMs) throw new Error(`job ${jobId} is still ${state} after ${minutes(timeoutMs)}; check later with: node jn.mjs status --job ${jobId}`);
    await deps.sleep(pollMs);
  }
  if (state === "Refunded") {
    say(deps, `job ${jobId}: refunded; the key was never released, so the delivery stays sealed`);
    return { jobId, state };
  }
  const out = path.join(opts.outDir ?? ".", `job-${jobId}-deliverable.txt`);
  await COMMANDS.open({ as: me, job: String(jobId), out }, deps);
  say(deps, `job ${jobId}: the judge passed it and the key was released; the delivery, opened:`);
  say(deps, fs.readFileSync(out, "utf8"));
  return { jobId, state, out };
}

/** preview --task criteria.json: the report the worker would deliver for the next job, and the judge's verdict on it, run here. Reads the chain; signs nothing. */
export async function preview(opts, deps) {
  const escrow = escrowOf(deps);
  const criteria = readTask(opts.task);
  const jobs = await listJobs(escrow, deps);
  const { text, missing } = deliverableFor(criteria, escrowFacts({ escrow, jobId: jobs.length, jobs, now: deps.now() }), { nonce: deps.rng(16).toString("hex") });
  say(deps, `preview: ${jobs.length} jobs on ${escrow}; the report for job ${jobs.length}, with a random nonce as the worker adds (reads only, signs nothing):`);
  if (missing.length) say(deps, `no fact for ${missing.join(", ")}, so it is left out`);
  say(deps, text);
  const verdict = await judgeHere(criteria, text);
  const checks = (verdict.checks ?? []).map((c) => `${c.id} ${c.ok ? "ok" : "failed"}`).join(", ");
  say(deps, `the judge, run here: ${verdict.pass ? "pass" : "fail"}, score ${verdict.score}${checks ? ` (${checks})` : ""}`);
  return { text, missing, verdict };
}

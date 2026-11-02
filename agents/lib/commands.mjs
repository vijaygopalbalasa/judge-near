// The agent commands. Each takes (opts, deps), deps = { env, home, out, rng, now, sleep,
// fetch, near }. Every command prints the exact contract call(s) first. With --dry-run it
// stops there: no key is loaded, no secret is written, nothing touches the network (jn.mjs
// also hands it a near and fetch that refuse to run). Live, secrets are saved under
// ~/.judge-near/<account>/ before any transaction depends on them, and are never printed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nearToYocto } from "near-api-js";
import { decryptDeliverable, encryptDeliverable, openK, publicFromSecret } from "../../judge-wasm/scripts/sealed.mjs";
import * as cfg from "./config.mjs";
import { describeCall, describeDeposit, shortenDeep } from "./format.mjs";
import { accessRule, eciesEncrypt, fetchKeystorePubkey, secretsProfile } from "./keystore.mjs";
import { failedChecks, judgeHere } from "./local-judge.mjs";
import { loadClientKey, loadK, loadOrCreateK, saveClientKey } from "./secrets-store.mjs";
import * as webVerify from "../../web/verify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");
const yocto = (nearAmount) => nearToYocto(nearAmount).toString();

// ---- argument checks ----
function accountArg(id, flag) {
  if (typeof id !== "string" || !cfg.ACCOUNT_ID.test(id)) throw new Error(`${flag} needs a NEAR account id`);
  return id;
}
function escrowOf(deps) {
  const e = deps.env.JN_ESCROW;
  if (typeof e !== "string" || !cfg.ACCOUNT_ID.test(e)) throw new Error("set JN_ESCROW to the escrow account id");
  return e;
}
function jobOf(opts) {
  if (!/^\d+$/.test(String(opts.job ?? ""))) throw new Error("--job needs a job number");
  return Number(opts.job);
}
/** "90s", "30m", "2h" or "1d" in milliseconds. */
export function parseDuration(s) {
  const m = /^(\d+)(s|m|h|d)$/.exec(String(s ?? ""));
  if (!m) throw new Error("--expires-in takes a number and a unit: 90s, 30m, 2h or 1d");
  return BigInt(m[1]) * { s: 1000n, m: 60_000n, h: 3_600_000n, d: 86_400_000n }[m[2]];
}
function readFileArg(file, flag) {
  if (typeof file !== "string" || !file) throw new Error(`${flag} needs a file`);
  return fs.readFileSync(file);
}
function utf8Text(bytes, what, max) {
  if (bytes.length > max) throw new Error(`${what} is ${bytes.length} bytes; the limit is ${max}`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${what} is not valid UTF-8`);
  }
}
/** The judge build this repo publishes (judge-wasm/release), for dry runs. */
function committedJudgeHash() {
  return fs.readFileSync(path.join(HERE, "..", "..", "judge-wasm", "release", "judge.wasm.sha256"), "utf8").trim().split(/\s+/)[0];
}

/** Live only, before any secret is saved or any call is signed: the escrow must run the
 *  published escrow build (the code hash NEAR reports) and the published judge (get_judge),
 *  unless the user names another build on purpose with --escrow-code-hash or --judge-hash.
 *  The keystore rule names the escrow account, so a fake escrow could run the real judge on
 *  inputs it chose and take a sealed delivery without paying, or keep a deposit. Returns
 *  get_judge's view. */
async function checkEscrow(opts, deps, escrow) {
  const byFlag = Boolean(opts["escrow-code-hash"] || opts["judge-hash"]);
  const code = await deps.near.codeHash(escrow);
  const wantCode = opts["escrow-code-hash"] ?? cfg.PUBLISHED_ESCROW_CODE_HASH;
  if (code !== wantCode) {
    throw new Error(`${escrow} runs code ${code}, not ${wantCode}${opts["escrow-code-hash"] ? "" : " (the published escrow build)"}; add --escrow-code-hash ${code} only if you have checked that build`);
  }
  const judge = await deps.near.view(escrow, "get_judge", {});
  const wantJudge = opts["judge-hash"] ?? committedJudgeHash();
  if (judge?.hash !== wantJudge) {
    throw new Error(`${escrow} runs judge ${judge?.hash}, not ${wantJudge}${opts["judge-hash"] ? "" : " (the published judge)"}; add --judge-hash ${judge?.hash} only if you have checked that build`);
  }
  deps.out(`escrow ${escrow}: code ${code}, judge ${judge.hash} (${byFlag ? "accepted by flag" : "the published builds"})`);
  return judge;
}

/** Live, before a delivery is sent: run the judge here on the job's criteria and this delivery. A delivery it would
 *  fail, or criteria it calls invalid (any delivery would refund the client), is not sent: a public delivery is on
 *  chain the moment it is submitted, so sending either would give the work away for nothing. --deliver-anyway sends
 *  it all the same, after saying so. */
async function judgeFirst(criteria, deliverable, opts, deps) {
  const v = await judgeHere(criteria, deliverable);
  let why;
  if (v.err === "invalid_criteria") why = "the judge, run here, answers invalid_criteria for this job's criteria: any delivery would refund the client";
  else if (v.err) why = `the judge, run here, answers ${v.err} for this delivery`;
  else if (!v.pass) why = `the judge, run here, would fail this delivery (score ${v.score}${failedChecks(v) ? `: ${failedChecks(v)}` : ""})`;
  else return v;
  if (!opts["deliver-anyway"]) throw new Error(`${why}; nothing sent (add --deliver-anyway to send it)`);
  deps.out(`${why}; sending it anyway (--deliver-anyway)`);
  return v;
}

// ---- calls ----
const fnCall = (contractId, methodName, args, gasTgas, depositYocto) => ({ contractId, methodName, args, gasTgas, depositYocto });
const printCall = (deps, signer, c) => deps.out(JSON.stringify(describeCall(signer, c), null, 2));
const printView = (deps, receiver, method, args) => deps.out(JSON.stringify({ view: { receiver, method, args } }, null, 2));

function returnValue(outcome) {
  const v = outcome?.status?.SuccessValue;
  if (typeof v !== "string" || v === "") return undefined;
  try {
    return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The judge's verdict and the escrow's events from a final ruling transaction. */
export function rulingResult(final, escrow) {
  const events = [];
  let verdict;
  for (const r of final?.receipts_outcome ?? []) {
    const o = r?.outcome ?? {};
    if (o.executor_id === escrow) {
      for (const log of o.logs ?? []) {
        if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
        try {
          const e = JSON.parse(log.slice("EVENT_JSON:".length));
          if (e.standard === "judge_near") events.push({ event: e.event, data: Array.isArray(e.data) ? e.data[0] : e.data });
        } catch {
          // not an event of ours
        }
      }
    }
    const sv = o.status?.SuccessValue;
    if (verdict === undefined && typeof sv === "string" && sv) {
      try {
        const v = JSON.parse(Buffer.from(sv, "base64").toString("utf8"));
        if (v && v.v === 1 && typeof v.eh === "string") verdict = v;
      } catch {
        // not the verdict
      }
    }
  }
  return { verdict, events };
}

const isFinal = (s) => Boolean(s?.status && typeof s.status === "object" && ("SuccessValue" in s.status || "Failure" in s.status));

// ---- commands ----

/** create --provider P --criteria file.json --expires-in 2h [--sealed] */
export async function create(opts, deps) {
  const escrow = escrowOf(deps);
  const signer = accountArg(opts.as, "--as");
  const provider = accountArg(opts.provider, "--provider");
  const criteria = utf8Text(readFileArg(opts.criteria, "--criteria"), "the criteria file", cfg.MAX_CRITERIA_BYTES);
  try {
    JSON.parse(criteria);
  } catch {
    throw new Error("the criteria file is not JSON");
  }
  const expiresAtNs = ((BigInt(deps.now()) + parseDuration(opts["expires-in"])) * 1_000_000n).toString();
  const args = { provider, criteria, expires_at_ns: expiresAtNs };
  let clientSecret;
  if (opts.sealed) {
    clientSecret = deps.rng(32);
    args.client_pk = publicFromSecret(clientSecret).toString("hex");
  }
  const c = fnCall(escrow, "create_job", args, cfg.GAS_TGAS.create_job, yocto(cfg.DEPOSIT_NEAR.create_job));
  printCall(deps, signer, c);
  if (opts["dry-run"]) return { dryRun: true };
  await checkEscrow(opts, deps, escrow);
  if (clientSecret) {
    deps.out(`client X25519 secret saved to ${saveClientKey(deps.home, signer, args.client_pk, clientSecret)} (mode 0600)`);
  }
  const r = await deps.near.call(signer, c);
  const jobId = returnValue(r.outcome);
  deps.out(`job ${jobId} created; tx ${r.txHash}`);
  return { jobId, txHash: r.txHash };
}

/** fund --job N --amount 1 */
export async function fund(opts, deps) {
  const escrow = escrowOf(deps);
  const signer = accountArg(opts.as, "--as");
  const jobId = jobOf(opts);
  const amount = String(opts.amount ?? "");
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error("--amount needs a NEAR amount above 0");
  const c = fnCall(escrow, "fund", { job_id: jobId }, cfg.GAS_TGAS.fund, yocto(amount));
  printCall(deps, signer, c);
  if (opts["dry-run"]) return { dryRun: true };
  await checkEscrow(opts, deps, escrow);
  const r = await deps.near.call(signer, c);
  deps.out(`job ${jobId} funded with ${amount} NEAR; tx ${r.txHash}`);
  return { txHash: r.txHash };
}

/** submit --job N --file f (public job) */
export async function submit(opts, deps) {
  const escrow = escrowOf(deps);
  const signer = accountArg(opts.as, "--as");
  const jobId = jobOf(opts);
  const deliverable = utf8Text(readFileArg(opts.file, "--file"), "the deliverable", cfg.MAX_DELIVERABLE_BYTES);
  const c = fnCall(escrow, "submit", { job_id: jobId, deliverable }, cfg.GAS_TGAS.submit, yocto(cfg.DEPOSIT_NEAR.submit));
  printCall(deps, signer, c);
  if (opts["dry-run"]) return { dryRun: true };
  await checkEscrow(opts, deps, escrow);
  const job = await deps.near.view(escrow, "get_job", { job_id: jobId });
  if (!job) throw new Error(`no job ${jobId} on ${escrow}`);
  if (job.sealed) throw new Error(`job ${jobId} is sealed: use submit-sealed`);
  await judgeFirst(job.criteria, deliverable, opts, deps);
  const r = await deps.near.call(signer, c);
  deps.out(`job ${jobId} submitted (dh ${sha256hex(Buffer.from(deliverable, "utf8"))}); tx ${r.txHash}`);
  return { txHash: r.txHash };
}

/** Live submit-sealed reads the job first: "submit" for a Funded job; "restore" for a job already
 *  submitted with this deliverable, which is where key_missing leaves it (the judge found no key,
 *  no money moved): the provider stores the same K again and asks for another ruling. Anything
 *  else is refused before a K is saved or a transaction is sent. */
function sealedSubmitMode(job, { escrow, jobId, signer, dh }) {
  if (!job) throw new Error(`no job ${jobId} on ${escrow}`);
  if (!job.sealed) throw new Error(`job ${jobId} is not sealed: use submit`);
  if (job.provider !== signer) throw new Error(`job ${jobId} belongs to provider ${job.provider}, not ${signer}`);
  if (job.state === "Funded") return "submit";
  if (job.state === "Submitted") {
    if (job.dh !== dh) throw new Error(`job ${jobId} was submitted with another deliverable (dh ${job.dh}); name the same file`);
    return "restore";
  }
  throw new Error(`job ${jobId} is ${job.state}; submit-sealed needs a Funded job (or a Submitted one, to store its key again after key_missing)`);
}

/** submit-sealed --job N --file f: K, C and dh (section 6.1), K stored for the judge only
 *  (section 6.2), then submit_sealed. On a job already submitted with this deliverable (after
 *  key_missing) it stores the saved K again and sends nothing else. */
export async function submitSealed(opts, deps) {
  const escrow = escrowOf(deps);
  const signer = accountArg(opts.as, "--as");
  const jobId = jobOf(opts);
  const dry = Boolean(opts["dry-run"]);
  const plaintext = readFileArg(opts.file, "--file");
  const text = utf8Text(plaintext, "the deliverable", cfg.MAX_DELIVERABLE_BYTES); // the judge would call anything else bad_delivery
  const dh = sha256hex(plaintext);

  const localProfile = secretsProfile(escrow, jobId);
  let judgeHash;
  let profile;
  let restore = false;
  if (dry) {
    judgeHash = opts["judge-hash"] ?? committedJudgeHash();
    profile = localProfile;
  } else {
    judgeHash = (await checkEscrow(opts, deps, escrow)).hash;
    profile = await deps.near.view(escrow, "get_secrets_profile", { job_id: jobId });
    if (profile !== localProfile) throw new Error(`the escrow names secrets profile ${profile}, expected ${localProfile}`);
    const job = await deps.near.view(escrow, "get_job", { job_id: jobId });
    restore = sealedSubmitMode(job, { escrow, jobId, signer, dh }) === "restore";
    await judgeFirst(job.criteria, text, opts, deps);
  }
  if (!HEX64.test(String(judgeHash))) throw new Error("the judge hash must be 64 lowercase hex");

  // K: in a dry run a throwaway key that lives only in memory; live, saved before any
  // transaction uses it, and reused if a previous attempt already saved one.
  let K;
  if (dry) {
    K = deps.rng(32);
  } else if (restore) {
    // Only the K that sealed the delivery on chain can open it; a new one would be useless.
    const saved = loadK(deps.home, signer, escrow, jobId);
    if (!saved) throw new Error(`job ${jobId} is already submitted, but no K for job ${jobId} is saved under ~/.judge-near/${signer}/; only the K that sealed the delivery on chain can open it`);
    K = saved.K;
    deps.out(`job ${jobId} is already submitted with this deliverable (key_missing leaves it so): storing the K saved at ${saved.where} for the judge again`);
  } else {
    const saved = loadOrCreateK(deps.home, signer, escrow, jobId, deps.rng);
    K = saved.K;
    deps.out(saved.created ? `new K for job ${jobId} saved to ${saved.where} (mode 0600)` : `reusing the K saved at ${saved.where}`);
  }

  let encrypted;
  if (dry) {
    encrypted = '<ECIES v1 of {"JN_KEY": K}, encrypted at run time to the key from POST /secrets/pubkey>';
    deps.out(JSON.stringify({
      keystore_pubkey_request: {
        url: cfg.KEYSTORE_PUBKEY_URL,
        body: { accessor: { type: "WasmHash", hash: judgeHash }, owner: signer, profile, secrets_json: "{}" },
      },
    }, null, 2));
  } else {
    const pubkey = await fetchKeystorePubkey(deps.fetch, { judgeHash, owner: signer, profile });
    encrypted = eciesEncrypt(pubkey, JSON.stringify({ JN_KEY: K.toString("hex") }), deps.rng);
  }

  const store = fnCall(cfg.OUTLAYER, "store_secrets", {
    accessor: { WasmHash: { hash: judgeHash } },
    profile,
    encrypted_secrets_base64: encrypted,
    access: accessRule(judgeHash, escrow),
    vault_id: null,
  }, cfg.GAS_TGAS.store_secrets, yocto(cfg.DEPOSIT_NEAR.store_secrets));
  if (restore) {
    printCall(deps, signer, store);
    const r = await deps.near.call(signer, store);
    deps.out(`store_secrets: tx ${r.txHash}`);
    deps.out(`key stored again; ask for a ruling: node jn.mjs ruling --as ${signer} --job ${jobId}`);
    return { dh, txHashes: [r.txHash], restored: true };
  }
  const deliverableCt = encryptDeliverable(K, plaintext, deps.rng(12));
  const submitCall = fnCall(escrow, "submit_sealed", { job_id: jobId, deliverable_ct: deliverableCt, dh },
    cfg.GAS_TGAS.submit_sealed, yocto(cfg.DEPOSIT_NEAR.submit_sealed));
  printCall(deps, signer, store);
  printCall(deps, signer, submitCall);
  if (dry) return { dryRun: true };

  const r1 = await deps.near.call(signer, store);
  deps.out(`store_secrets: tx ${r1.txHash}`);
  const r2 = await deps.near.call(signer, submitCall);
  deps.out(`job ${jobId} submitted sealed (dh ${dh}); tx ${r2.txHash}`);
  return { dh, txHashes: [r1.txHash, r2.txHash] };
}

/** ruling --job N: request_ruling with get_judge's min_ruling_deposit, then wait for the verdict. */
export async function ruling(opts, deps) {
  const escrow = escrowOf(deps);
  const signer = accountArg(opts.as, "--as");
  const jobId = jobOf(opts);
  const dry = Boolean(opts["dry-run"]);
  let depositYocto;
  let depositNote;
  if (!dry) {
    depositYocto = String((await checkEscrow(opts, deps, escrow))?.min_ruling_deposit);
    if (!/^[1-9]\d*$/.test(depositYocto)) throw new Error("get_judge returned no min_ruling_deposit");
    if (BigInt(depositYocto) > BigInt(yocto(cfg.MAX_RULING_DEPOSIT_NEAR))) {
      throw new Error(`the escrow asks ${describeDeposit(depositYocto)} per ruling, above the ${cfg.MAX_RULING_DEPOSIT_NEAR} NEAR cap; nothing was signed`);
    }
  } else if (opts["min-deposit"] !== undefined) {
    depositYocto = yocto(String(opts["min-deposit"]));
  } else {
    depositNote = "get_judge.min_ruling_deposit (read at run time)";
  }
  const c = { ...fnCall(escrow, "request_ruling", { job_id: jobId }, cfg.GAS_TGAS.request_ruling, depositYocto), depositNote };
  printCall(deps, signer, c);
  if (dry) return { dryRun: true };

  const r = await deps.near.call(signer, c, { waitUntil: "INCLUDED_FINAL" });
  deps.out(`request_ruling sent; tx ${r.txHash}; waiting for the judge (up to ${cfg.RULING_TIMEOUT_MS / 60_000} minutes)`);
  const started = deps.now();
  let final;
  while (deps.now() - started < cfg.RULING_TIMEOUT_MS) {
    try {
      const s = await deps.near.txStatus(r.txHash, signer);
      if (isFinal(s)) {
        final = s;
        break;
      }
    } catch {
      // still pending
    }
    await deps.sleep(cfg.RULING_POLL_MS);
  }
  if (!final) {
    deps.out(`no final result yet; check later with: status --job ${jobId}`);
    deps.out(`tx ${r.txHash}`);
    return { txHash: r.txHash, pending: true };
  }
  const { verdict, events } = rulingResult(final, escrow);
  deps.out(`verdict: ${verdict ? JSON.stringify(shortenDeep(verdict)) : "(not found in the receipts; see the events)"}`);
  for (const e of events) deps.out(`event ${e.event}: ${JSON.stringify(shortenDeep(e.data))}`);
  deps.out(`tx ${r.txHash}`);
  return { txHash: r.txHash, verdict, events };
}

/** open --job N [--out file]: the client recovers K from k, decrypts C, checks dh. */
export async function open(opts, deps) {
  const escrow = escrowOf(deps);
  const signer = accountArg(opts.as, "--as");
  const jobId = jobOf(opts);
  const outFile = typeof opts.out === "string" && opts.out ? opts.out : `job-${jobId}-deliverable.txt`;
  printView(deps, escrow, "get_job", { job_id: jobId });
  if (opts["dry-run"]) {
    deps.out(`then: open k with the client key for the job's client_pk (from ~/.judge-near/${signer}/), decrypt deliverable_ct, check sha256 against dh, write ${outFile} (mode 0600)`);
    return { dryRun: true };
  }
  const job = await deps.near.view(escrow, "get_job", { job_id: jobId });
  if (!job) throw new Error(`no job ${jobId}`);
  if (!job.sealed) throw new Error(`job ${jobId} is not sealed`);
  if (job.client !== signer) throw new Error(`job ${jobId} belongs to client ${job.client}, not ${signer}`);
  if (typeof job.k !== "string" || job.k.length !== 124) throw new Error(`no key released for job ${jobId} yet (state ${job.state})`);
  const secret = loadClientKey(deps.home, signer, job.client_pk);
  let plaintext;
  try {
    plaintext = decryptDeliverable(openK(job.k, secret.toString("hex")), job.deliverable_ct);
  } catch {
    throw new Error(`k or deliverable_ct of job ${jobId} does not open with this client key`);
  }
  if (sha256hex(plaintext) !== job.dh) throw new Error("the decrypted deliverable does not match dh");
  fs.writeFileSync(outFile, plaintext, { mode: 0o600, flag: "wx" });
  deps.out(`wrote ${plaintext.length} bytes to ${outFile} (mode 0600); its sha256 matches dh ${job.dh}`);
  return { outFile, bytes: plaintext.length };
}

/** A check's detail for the terminal: a verdict with its long values (k) shortened, else the text. */
function showDetail(detail) {
  const text = String(detail);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return JSON.stringify(shortenDeep(parsed));
  } catch {
    // plain text, such as the judge's URL: shown whole
  }
  return text;
}

/** verify --tx HASH --signer ACCOUNT [--as CLIENT_OR_PROVIDER]: the browser verifier's checks
 *  (web/verify.js) from the command line. A sealed ruling is re-run with the deliverable key,
 *  loaded here and kept in memory: --as the job's client (once k is released) or its provider.
 *  The verifier hands the key only to a published judge build whose bytes it has just checked.
 *  The ruling is read from archival nodes (JN_ARCHIVAL_RPC, else ARCHIVAL_RPC_URLS in order),
 *  never JN_RPC: regular testnet nodes drop transactions after about 30 hours. */
export async function verify(opts, deps) {
  const txHash = String(opts.tx ?? "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) throw new Error("--tx needs a transaction hash");
  const signer = accountArg(opts.signer, "--signer");
  const as = opts.as === undefined ? undefined : accountArg(opts.as, "--as");
  const rpc = deps.env.JN_ARCHIVAL_RPC || cfg.ARCHIVAL_RPC_URLS;
  if (opts["dry-run"]) {
    deps.out(JSON.stringify({
      verify: {
        tx: txHash,
        signer,
        archival_rpc: Array.isArray(rpc) ? [...rpc] : [rpc],
        then: "read the transaction from the first archival node above that has it (JN_ARCHIVAL_RPC names another), find the OutLayer run in it, download the wasm it ran, check its SHA-256 against the run and the published judge builds, re-run it here on the same input, compare the verdicts field by field"
          + (as ? `; a sealed ruling is re-run with the deliverable key, loaded as ${as} and kept in memory` : ""),
      },
    }, null, 2));
    return { dryRun: true };
  }
  const v = deps.verifier ?? webVerify;
  const tx = await v.fetchTransaction(txHash, signer, { rpc, fetchImpl: deps.fetch });
  const ruling = v.findRuling(tx);
  if (!ruling) throw new Error(`transaction ${txHash} did not ask OutLayer to run anything`);
  const sealed = Boolean(ruling.secretsRef);
  const keyMissing = sealed && ruling.verdict?.err === "key_missing"; // the judge ran without a key
  const env = {};
  if (sealed && !keyMissing && as !== undefined) {
    const where = v.rulingJob(tx, ruling);
    if (where.error) throw new Error(where.error);
    const { escrow, jobId } = where;
    const job = await deps.near.view(escrow, "get_job", { job_id: jobId });
    if (!job?.sealed) throw new Error(`job ${jobId} on ${escrow} is not sealed`);
    if (as === job.client) {
      if (typeof job.k !== "string" || job.k.length !== 124) throw new Error(`no key released for job ${jobId} yet (state ${job.state})`);
      const secret = loadClientKey(deps.home, as, job.client_pk);
      env.JN_KEY = Buffer.from(openK(job.k, secret.toString("hex"))).toString("hex");
    } else if (as === job.provider) {
      const saved = loadK(deps.home, as, escrow, jobId);
      if (!saved) throw new Error(`no K for job ${jobId} of ${escrow} is saved under ~/.judge-near/${as}/`);
      env.JN_KEY = saved.K.toString("hex");
    } else {
      throw new Error(`--as must be the job's client ${job.client} or provider ${job.provider}`);
    }
    deps.out(`sealed ruling of job ${jobId}: re-running it with the deliverable key, loaded as ${as} and kept in memory`);
  }
  const report = await v.verifyRuling(ruling, { signer, tx, rpc, fetchImpl: deps.fetch, env });
  const mark = (ok) => (ok === true ? "ok  " : ok === null ? "skip" : "FAIL");
  for (const s of report.steps) deps.out(`${mark(s.ok)} ${s.label}${s.detail ? ` | ${showDetail(s.detail)}` : ""}`);
  const outcome = webVerify.reportOutcome(report);
  if (outcome === "verified") {
    const published = report.steps.find((s) => s.id === "published")?.detail;
    deps.out(`Verified: ${published} computes exactly this ruling (pass: ${report.local.pass}, score: ${report.local.score}).`);
    return { ok: true };
  }
  if (sealed && !keyMissing && as === undefined) {
    deps.out("This ruling is sealed: add --as <client> (after the key is released) or --as <provider> to re-run it with the deliverable key.");
  }
  if (outcome === "needs-key") throw new Error("not re-run: the deliverable key is needed; the checks above need none");
  throw new Error("not verified: see the check marked FAIL above");
}

/** status --job N */
export async function status(opts, deps) {
  const escrow = escrowOf(deps);
  const jobId = jobOf(opts);
  if (opts["dry-run"]) {
    printView(deps, escrow, "get_job", { job_id: jobId });
    return { dryRun: true };
  }
  const job = await deps.near.view(escrow, "get_job", { job_id: jobId });
  if (!job) throw new Error(`no job ${jobId}`);
  const expiresMs = Number(BigInt(job.expires_at_ns ?? 0) / 1_000_000n);
  deps.out(JSON.stringify(shortenDeep({
    job_id: jobId,
    state: job.state,
    client: job.client,
    provider: job.provider,
    amount: describeDeposit(job.amount ?? "0"),
    sealed: Boolean(job.sealed),
    ch: job.ch,
    dh: job.dh,
    client_pk: job.client_pk ?? null,
    k: job.k ?? null,
    deliverable: job.deliverable || null,
    deliverable_ct: job.deliverable_ct ?? null,
    attempt: job.attempt,
    expires_at: new Date(expiresMs).toISOString(),
  }), null, 2));
  return { job };
}

/** forget --job N: once a sealed job has settled, its provider deletes the delivery key from OutLayer's vault, so no
 *  later request can read it (delete_secrets takes no deposit and refunds the storage one). */
export async function forget(opts, deps) {
  const escrow = escrowOf(deps);
  const signer = accountArg(opts.as, "--as");
  const jobId = jobOf(opts);
  const dry = Boolean(opts["dry-run"]);
  const localProfile = secretsProfile(escrow, jobId);
  let judgeHash = opts["judge-hash"] ?? committedJudgeHash();
  let profile = localProfile;
  if (!dry) {
    const job = await deps.near.view(escrow, "get_job", { job_id: jobId });
    if (!job) throw new Error(`no job ${jobId} on ${escrow}`);
    if (!job.sealed) throw new Error(`job ${jobId} is not sealed: there is no key to delete`);
    if (job.provider !== signer) throw new Error(`job ${jobId} belongs to provider ${job.provider}, not ${signer}`);
    if (job.state !== "Completed" && job.state !== "Refunded") throw new Error(`job ${jobId} is ${job.state}; its key is deleted only once the job has settled`);
    judgeHash = (await checkEscrow(opts, deps, escrow)).hash;
    profile = await deps.near.view(escrow, "get_secrets_profile", { job_id: jobId });
    if (profile !== localProfile) throw new Error(`the escrow names secrets profile ${profile}, expected ${localProfile}`);
  }
  const c = fnCall(cfg.OUTLAYER, "delete_secrets", { accessor: { WasmHash: { hash: judgeHash } }, profile }, cfg.GAS_TGAS.delete_secrets, "0");
  printCall(deps, signer, c);
  if (dry) return { dryRun: true };
  const r = await deps.near.call(signer, c);
  deps.out(`job ${jobId}: the worker's key is deleted from OutLayer's vault; tx ${r.txHash}`);
  return { txHash: r.txHash };
}

export const COMMANDS = { create, fund, submit, "submit-sealed": submitSealed, ruling, open, status, verify, forget };

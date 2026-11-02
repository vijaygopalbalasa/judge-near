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
import { loadClientKey, loadOrCreateK, saveClientKey } from "./secrets-store.mjs";

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
  const r = await deps.near.call(signer, c);
  deps.out(`job ${jobId} submitted (dh ${sha256hex(Buffer.from(deliverable, "utf8"))}); tx ${r.txHash}`);
  return { txHash: r.txHash };
}

/** submit-sealed --job N --file f: K, C and dh (section 6.1), K stored for the judge only
 *  (section 6.2), then submit_sealed. */
export async function submitSealed(opts, deps) {
  const escrow = escrowOf(deps);
  const signer = accountArg(opts.as, "--as");
  const jobId = jobOf(opts);
  const dry = Boolean(opts["dry-run"]);
  const plaintext = readFileArg(opts.file, "--file");
  utf8Text(plaintext, "the deliverable", cfg.MAX_DELIVERABLE_BYTES); // the judge would call anything else bad_delivery
  const dh = sha256hex(plaintext);

  const localProfile = secretsProfile(escrow, jobId);
  let judgeHash;
  let profile;
  if (dry) {
    judgeHash = opts["judge-hash"] ?? committedJudgeHash();
    profile = localProfile;
  } else {
    judgeHash = (await deps.near.view(escrow, "get_judge", {}))?.hash;
    profile = await deps.near.view(escrow, "get_secrets_profile", { job_id: jobId });
    if (profile !== localProfile) throw new Error(`the escrow names secrets profile ${profile}, expected ${localProfile}`);
  }
  if (!HEX64.test(String(judgeHash))) throw new Error("the judge hash must be 64 lowercase hex");

  // K: in a dry run a throwaway key that lives only in memory; live, saved before any
  // transaction uses it, and reused if a previous attempt already saved one.
  let K;
  if (dry) {
    K = deps.rng(32);
  } else {
    const saved = loadOrCreateK(deps.home, signer, escrow, jobId, deps.rng);
    K = saved.K;
    deps.out(saved.created ? `new K for job ${jobId} saved to ${saved.where} (mode 0600)` : `reusing the K saved at ${saved.where}`);
  }
  const deliverableCt = encryptDeliverable(K, plaintext, deps.rng(12));

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
    depositYocto = String((await deps.near.view(escrow, "get_judge", {}))?.min_ruling_deposit);
    if (!/^[1-9]\d*$/.test(depositYocto)) throw new Error("get_judge returned no min_ruling_deposit");
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

export const COMMANDS = { create, fund, submit, "submit-sealed": submitSealed, ruling, open, status };

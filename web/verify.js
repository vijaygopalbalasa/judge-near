// Re-run an OutLayer ruling and check it, in a browser or in Node.
//
// Given a NEAR transaction that asked OutLayer to run the judge, this module reads the request
// OutLayer logged (the input and the wasm URL and hash), downloads the wasm, checks its SHA-256
// against the hash OutLayer was told to run, runs it locally through the WASI host in wasi.js,
// and compares the local verdict with the one OutLayer returned on chain, field by field. It also
// recomputes the evidence hash `eh` (docs/interface.md, section 3).
//
// It reads the chain from NEAR archival nodes: regular testnet nodes drop transactions after about
// 30 hours, so a ruling from last week can only be read from an archival node.

import { runWasi } from "./wasi.js";

/** How long one RPC host may take to answer before the next one is asked. */
export const RPC_TIMEOUT_MS = 10_000;

/** NEAR testnet archival RPC nodes, tried in order: FastNEAR's, then NEAR's own. */
export const TESTNET_ARCHIVAL_RPCS = Object.freeze(["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"]);

/** Only receipts executed by OutLayer's own contracts count; any contract can write a log that looks like theirs. */
export const OUTLAYER_ACCOUNTS = new Set(["outlayer.testnet", "outlayer.near"]);

/** Judge builds published in this repository (judge-wasm/release). A ruling by any other wasm is not a Judge on NEAR ruling. */
export const PUBLISHED_JUDGES = new Map([
  ["da3b581d84561c4cf1e4fe4a21e190f12b24f9c8bd0e96ad4c8e40e929f956f1", "judge v1 (public jobs), commit e09c6f9"],
  ["911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958", "judge v2 (public and sealed jobs), commit fd3dcc6"],
]);

const KEY_ORDER = ["v", "pass", "score", "th", "ch", "dh", "checks", "err", "k"];

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The verdict text in canonical key order, without `eh` (the bytes `eh` is taken over, minus the closing brace). */
export function canonicalPrefix(verdict) {
  const parts = [];
  for (const key of KEY_ORDER) {
    if (!(key in verdict)) continue;
    if (key === "checks") {
      const checks = verdict.checks.map((c) => `{"id":${JSON.stringify(c.id)},"ok":${JSON.stringify(c.ok)}}`);
      parts.push(`"checks":[${checks.join(",")}]`);
    } else {
      parts.push(`${JSON.stringify(key)}:${JSON.stringify(verdict[key])}`);
    }
  }
  return `{${parts.join(",")}`;
}

/** The evidence hash a verdict should carry: sha256 of the canonical text before `eh`, plus `}`. */
export async function expectedEh(verdict) {
  return sha256Hex(new TextEncoder().encode(`${canonicalPrefix(verdict)}}`));
}

/**
 * One JSON-RPC call, asked of each host in `rpc` (one URL or a list) in order until one answers with
 * a result. A host is skipped on a network error, an HTTP error status (a 429 or a 5xx included), a
 * body that is not JSON, or a JSON-RPC error (a node may not have the transaction). When every host
 * fails, the error names each host and what went wrong there.
 */
export async function rpcCall(rpc, method, params, fetchImpl = globalThis.fetch, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const hosts = Array.isArray(rpc) ? rpc : [rpc];
  if (hosts.length === 0) throw new Error("RPC: no host to ask");
  const failures = [];
  for (const host of hosts) {
    let why;
    // A host that hangs is skipped like one that fails: abort it after timeoutMs and ask the next.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetchImpl(host, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
        signal: abort.signal,
      });
      if (res.ok === false) {
        why = `HTTP ${res.status}`;
      } else {
        let body;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        if (body === undefined || body === null || typeof body !== "object") why = "the answer is not JSON";
        else if (body.error) why = body.error.cause?.name ?? body.error.message ?? "JSON-RPC error";
        else if (!("result" in body)) why = "no result in the answer";
        else return body.result;
      }
    } catch (e) {
      why = abort.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : e?.message ?? String(e);
    } finally {
      clearTimeout(timer);
    }
    failures.push(`${host}: ${why}`);
  }
  throw new Error(`RPC: no host answered (${failures.join("; ")})`);
}

export async function fetchTransaction(txHash, signer, { rpc = TESTNET_ARCHIVAL_RPCS, fetchImpl = globalThis.fetch } = {}) {
  return rpcCall(rpc, "tx", { tx_hash: txHash, sender_account_id: signer, wait_until: "FINAL" }, fetchImpl);
}

function events(logs, standard) {
  const out = [];
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    try {
      const ev = JSON.parse(line.slice("EVENT_JSON:".length));
      if (!standard || ev.standard === standard) out.push(ev);
    } catch {
      // not an event we can read
    }
  }
  return out;
}

function decodeBase64(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Find the OutLayer request and its result in a transaction.
 * Returns null when the transaction never asked OutLayer for a run.
 */
export function findRuling(tx) {
  let request = null;
  let completed = null;
  let verdictText = null;
  for (const receipt of tx.receipts_outcome ?? []) {
    const { logs, status, executor_id: executor } = receipt.outcome;
    if (!OUTLAYER_ACCOUNTS.has(executor)) continue;
    for (const ev of events(logs, "near-outlayer")) {
      if (ev.event === "execution_requested" && !request) {
        request = { ...JSON.parse(ev.data[0].request_data), outlayer: executor };
      }
      if (ev.event === "execution_completed" && !completed) {
        completed = ev.data[0];
        if (status && "SuccessValue" in status) verdictText = new TextDecoder().decode(decodeBase64(status.SuccessValue));
      }
    }
  }
  if (!request) return null;
  let verdict = null;
  try {
    const parsed = verdictText ? JSON.parse(verdictText) : null;
    if (parsed && typeof parsed === "object" && parsed.v === 1) verdict = parsed;
  } catch {
    // OutLayer returned something that is not a verdict
  }
  return {
    requestId: request.request_id,
    outlayer: request.outlayer,
    signer: request.sender_id,
    caller: request.predecessor_id,
    input: request.input_data_in_state ? null : request.input_data,
    inputInState: Boolean(request.input_data_in_state),
    source: request.code_source?.WasmUrl ?? null,
    secretsRef: request.secrets_ref ?? null,
    limits: request.resource_limits,
    completed,
    verdictText,
    verdict,
  };
}

/**
 * The escrow and job a ruling was asked for, from the transaction's request_ruling call to the
 * contract that asked OutLayer. Returns {escrow, jobId} or {error}.
 */
export function rulingJob(tx, ruling) {
  const call = (tx?.transaction?.actions ?? []).map((a) => a?.FunctionCall).find((f) => f?.method_name === "request_ruling");
  if (!call || tx.transaction.receiver_id !== ruling.caller) {
    return { error: "the transaction is not a request_ruling call to the contract that asked OutLayer" };
  }
  let jobId;
  try {
    jobId = JSON.parse(new TextDecoder().decode(decodeBase64(call.args))).job_id;
  } catch {
    jobId = undefined;
  }
  if (!Number.isSafeInteger(jobId) || jobId < 0) return { error: "could not read the job id from the request_ruling call" };
  return { escrow: ruling.caller, jobId };
}

/**
 * OutLayer keeps an input of 10,000 bytes or more in its own state instead of its request log, and
 * removes it once the run settles. Rebuild that input from the escrow job the ruling was asked for:
 * the transaction's request_ruling call names the job, and the escrow's get_job view holds the exact
 * strings it sent. A wrong rebuild cannot pass: the re-run's ch and dh would not match the verdict.
 */
export async function inputFromEscrow(tx, ruling, { rpc = TESTNET_ARCHIVAL_RPCS, fetchImpl = globalThis.fetch } = {}) {
  const where = rulingJob(tx, ruling);
  if (where.error) return where;
  const { jobId } = where;
  let result;
  try {
    result = await rpcCall(rpc, "query", {
      request_type: "call_function",
      finality: "final",
      account_id: ruling.caller,
      method_name: "get_job",
      args_base64: btoa(JSON.stringify({ job_id: jobId })),
    }, fetchImpl);
  } catch (e) {
    return { error: `get_job on ${ruling.caller} failed: ${e.message}` };
  }
  if (!Array.isArray(result?.result)) {
    return { error: `get_job on ${ruling.caller} failed: ${result?.error ?? "no result"}` };
  }
  let job;
  try {
    job = JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
  } catch {
    job = null;
  }
  if (!job || typeof job.criteria !== "string") return { error: `job ${jobId} not found on ${ruling.caller}` };
  const input = job.sealed
    ? JSON.stringify({ criteria: job.criteria, deliverable_ct: job.deliverable_ct, dh: job.dh, client_pk: job.client_pk })
    : JSON.stringify({ criteria: job.criteria, deliverable: job.deliverable });
  return { input, jobId, escrow: ruling.caller };
}

/** The published build these bytes are (PUBLISHED_JUDGES), by SHA-256, or null. */
export async function publishedJudgeName(bytes) {
  return PUBLISHED_JUDGES.get(await sha256Hex(bytes)) ?? null;
}

/**
 * A transaction in plain terms, for the transaction page: who signed it, what it called, how it ended,
 * and each receipt's executor, status, plain logs, events and returned value.
 */
export function summarizeTx(tx) {
  const t = tx?.transaction ?? {};
  const actions = (t.actions ?? []).map((a) => {
    if (typeof a === "string") return { kind: a };
    const [kind, body = {}] = Object.entries(a ?? {})[0] ?? ["Unknown"];
    if (kind === "FunctionCall") {
      let args;
      try {
        args = new TextDecoder().decode(decodeBase64(body.args ?? ""));
      } catch {
        args = undefined;
      }
      return { kind, method: body.method_name, deposit: String(body.deposit ?? "0"), args };
    }
    if (kind === "Transfer") return { kind, deposit: String(body.deposit ?? "0") };
    return { kind };
  });
  const status = tx?.status ?? {};
  const failed = typeof status === "object" && status !== null && "Failure" in status;
  const receipts = (tx?.receipts_outcome ?? []).map((r) => {
    const o = r?.outcome ?? {};
    const s = o.status ?? {};
    const logs = Array.isArray(o.logs) ? o.logs : [];
    let returned;
    if (typeof s.SuccessValue === "string" && s.SuccessValue) {
      try {
        returned = new TextDecoder().decode(decodeBase64(s.SuccessValue));
      } catch {
        returned = undefined;
      }
    }
    return {
      id: r?.id,
      executor: o.executor_id,
      status: "Failure" in s ? "failure" : "SuccessValue" in s || "SuccessReceiptId" in s ? "success" : "unknown",
      failure: "Failure" in s ? JSON.stringify(s.Failure) : undefined,
      logs: logs.filter((l) => typeof l === "string" && !l.startsWith("EVENT_JSON:")),
      events: events(logs).map((e) => ({ standard: e.standard, event: e.event, data: e.data })),
      returned,
    };
  });
  // What OutLayer did, from the execution_completed events of OutLayer's own receipts (any contract can log a
  // look-alike): refused (with its message) or ran (with its resources).
  const outlayer = receipts.filter((r) => OUTLAYER_ACCOUNTS.has(r.executor)).flatMap((r) => r.events.filter((e) => e.standard === "near-outlayer" && e.event === "execution_completed")).map((e) => {
    const d = Array.isArray(e.data) ? e.data[0] ?? {} : e.data ?? {};
    return { success: d.success === true, error: d.error_message ?? undefined, instructions: d.resources_used?.instructions, timeMs: d.resources_used?.time_ms };
  });
  return { hash: t.hash, signer: t.signer_id, receiver: t.receiver_id, actions, status: failed ? "failure" : "success", failure: failed ? JSON.stringify(status.Failure) : undefined, receipts, outlayer };
}

/** Run the judge bytes on one input; returns the verdict text it prints. */
export async function runJudge(wasmBytes, input, env = {}) {
  const module = await WebAssembly.compile(wasmBytes);
  const { code, stdout } = runWasi(module, { stdin: new TextEncoder().encode(input), env });
  if (code !== 0) throw new Error(`judge exited with code ${code}`);
  return new TextDecoder().decode(stdout);
}

/**
 * The checks a sealed ruling allows without its key: the verdict's ch is the SHA-256 of the criteria
 * in the judge's input, its dh is the worker's commitment in that input, and its eh recomputes from
 * its own fields (docs/interface.md, sections 3 and 6: every sealed verdict, error rows included,
 * carries these ch and dh). The score itself can only be recomputed with the key.
 */
async function checkWithoutKey(input, verdict, step) {
  let parsed = null;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = null;
  }
  const criteria = typeof parsed?.criteria === "string" ? parsed.criteria : "";
  const ch = await sha256Hex(new TextEncoder().encode(criteria));
  step("ch", verdict.ch === ch, "The verdict's ch is the SHA-256 of the job's criteria", ch);
  const dh = typeof parsed?.dh === "string" && /^[0-9a-f]{64}$/.test(parsed.dh) ? parsed.dh : await sha256Hex(new Uint8Array(0));
  step("dh", verdict.dh === dh, "The verdict's dh is the worker's commitment in the judge's input", dh);
  let eh;
  try {
    eh = await expectedEh(verdict);
  } catch {
    eh = "the verdict's fields cannot be read";
  }
  step("eh", eh === verdict.eh, "The evidence hash eh recomputes from the on-chain verdict", eh);
}

/** Who asked OutLayer for a ruling: {account, jobId} for an escrow's request_ruling call, {account} for a direct call. */
export function askerOf(tx, ruling) {
  const where = rulingJob(tx, ruling);
  return where.error ? { account: ruling.caller } : { account: where.escrow, jobId: where.jobId };
}

/** A report builder: step(id, ok, label, detail) records one check and returns ok; done() closes the report. */
function reporter() {
  const steps = [];
  const step = (id, ok, label, detail = "") => {
    steps.push({ id, ok, label, detail });
    return ok;
  };
  const done = (extra = {}) => ({ ok: steps.every((s) => s.ok === true), steps, ...extra });
  return { step, done };
}

/**
 * The checks every ruling starts with: who asked, which job, which judge, that a verdict came back, and the
 * judge's input (from OutLayer's log, or rebuilt from the escrow job). Returns the input, or undefined after
 * a check failed.
 */
async function rulingInput(ruling, { signer, job, tx, rpc, fetchImpl }, step) {
  if (signer !== undefined && !step("signer", ruling.signer === signer, "OutLayer recorded the request for the account you entered", `recorded signer: ${ruling.signer}`)) return undefined;
  if (job !== undefined) {
    const where = tx ? rulingJob(tx, ruling) : { error: "no transaction to read the job from" };
    const same = !where.error && where.escrow === job.escrow && where.jobId === job.jobId;
    const detail = where.error ?? `the transaction asks for job ${where.jobId} of ${where.escrow}`;
    if (!step("job", same, `The ruling was asked for job ${job.jobId} of ${job.escrow}`, detail)) return undefined;
  } else if (tx) {
    // No job named: say who asked, so a ruling another contract asked for cannot pass for one of the escrow's.
    const asker = askerOf(tx, ruling);
    step("asker", true, asker.jobId === undefined ? `Asked for directly by ${asker.account}, not through an escrow` : `Asked for by ${asker.account}, job ${asker.jobId}`);
  }
  if (!step("source", Boolean(ruling.source), "The request names a wasm by URL and SHA-256", ruling.source ? ruling.source.url : "no WasmUrl source in the request")) return undefined;
  const published = PUBLISHED_JUDGES.get(ruling.source.hash);
  if (!step("published", Boolean(published), "That hash is a published Judge on NEAR build", published ?? `unknown hash ${ruling.source.hash}: not a Judge on NEAR ruling`)) return undefined;
  if (!step("result", Boolean(ruling.verdict), "OutLayer returned a verdict on chain", ruling.verdict ? "" : `returned: ${ruling.verdictText ?? "nothing"}`)) return undefined;
  if (ruling.inputInState) {
    const rebuilt = tx ? await inputFromEscrow(tx, ruling, { rpc, fetchImpl }) : { error: "no transaction to read the escrow job from" };
    const label = "The judge's input, rebuilt from the escrow job (OutLayer kept it in its own state)";
    if (!step("input", Boolean(rebuilt.input), label, rebuilt.input ? `escrow ${rebuilt.escrow}, job ${rebuilt.jobId}` : rebuilt.error)) return undefined;
    return rebuilt.input;
  }
  if (!step("input", ruling.input !== null && ruling.input !== undefined, "The judge's input is in OutLayer's request log")) return undefined;
  return ruling.input;
}

/** The judge build OutLayer ran: the bytes given, or downloaded from its URL, checked against its hash. */
async function judgeBytes(ruling, wasmBytes, fetchImpl, step) {
  let bytes = wasmBytes;
  if (!bytes) {
    const res = await fetchImpl(ruling.source.url);
    if (!step("download", res.ok, "Downloaded the judge from the URL OutLayer ran", `HTTP ${res.status}`)) return undefined;
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  const hash = await sha256Hex(bytes);
  if (!step("hash", hash === ruling.source.hash, "Its SHA-256 equals the hash OutLayer was told to run", hash)) return undefined;
  return bytes;
}

/**
 * Check one ruling. `wasmBytes` is optional: when absent it is downloaded from the URL OutLayer ran.
 * `job` ({escrow, jobId}, optional) also checks that the transaction's request_ruling call names
 * that job. Returns {ok, steps:[{id, ok, label, detail}], local, onchain}; `ok` is true only when
 * the judge was re-run here and matched. A sealed ruling without its key gets the checks that need
 * none, a last step with ok null (not done), and needsKey: true.
 */
export async function verifyRuling(ruling, { wasmBytes, env = {}, signer, job, runner = runJudge, fetchImpl = globalThis.fetch, tx, rpc = TESTNET_ARCHIVAL_RPCS } = {}) {
  const { step, done } = reporter();
  const input = await rulingInput(ruling, { signer, job, tx, rpc, fetchImpl }, step);
  if (input === undefined) return done();
  // key_missing means OutLayer ran the judge with no key; re-run it the same way, ignoring any key given.
  const keyMissing = Boolean(ruling.secretsRef) && ruling.verdict.err === "key_missing";
  if (keyMissing) {
    step("key", true, "Sealed job ruled key_missing: OutLayer ran the judge without a key, so it is re-run without one");
  } else if (ruling.secretsRef && !env.JN_KEY) {
    await checkWithoutKey(input, ruling.verdict, step);
    step("key", null, "Not re-run: the score needs the delivery key, which only the worker and, after a pass, the client hold");
    return done({ needsKey: true });
  }

  const bytes = await judgeBytes(ruling, wasmBytes, fetchImpl, step);
  if (!bytes) return done();

  // The key only ever goes to a published judge build whose bytes were just checked.
  const localText = await runner(bytes, input, ruling.secretsRef && !keyMissing ? env : {});
  const local = JSON.parse(localText);
  step("rerun", true, "Re-ran the judge here on the same input", localText);

  const same = canonicalPrefix(local) === canonicalPrefix(ruling.verdict) && local.eh === ruling.verdict.eh;
  step("match", same, "The local verdict equals the on-chain verdict, field by field", same ? `pass: ${local.pass}, score: ${local.score}` : `on chain: ${ruling.verdictText}`);

  const eh = await expectedEh(local);
  step("eh", eh === local.eh && eh === ruling.verdict.eh, "The evidence hash eh recomputes from the verdict fields", eh);
  return done({ local, onchain: ruling.verdict });
}

/**
 * What a report amounts to: "verified" (re-run here and matched), "needs-key" (a sealed ruling
 * checked without its key, nothing failed) or "failed" (a check failed, or anything unexplained).
 */
export function reportOutcome(report) {
  const steps = report?.steps ?? [];
  if (steps.length === 0) return "failed";
  if (report.ok === true && steps.every((s) => s.ok === true)) return "verified";
  const last = steps.at(-1);
  const checked = steps.slice(0, -1).every((s) => s.ok === true);
  return report.needsKey === true && last.id === "key" && last.ok === null && checked ? "needs-key" : "failed";
}

/** Errors a sealed judge returns before it opens the delivery: a disclosed delivery cannot re-check those. */
const UNOPENED = new Set(["key_missing", "bad_delivery", "invalid_input"]);

/** A verdict without k and eh: k seals the key to the client, so a re-run on the plain delivery has neither. */
const withoutKey = ({ k, eh, ...rest }) => canonicalPrefix(rest);

/**
 * Check a sealed ruling on its disclosed delivery, with no key: once the worker or the client publishes the
 * plain delivery, anyone can confirm it is the one the worker committed to (its SHA-256 is the on-chain dh) and
 * re-run the published judge on it and the job's criteria. The sealed judge scores the opened delivery with the
 * same code as a public job (judge-wasm/src/sealed.rs), so every verdict field but k and eh must match. A ruling
 * the judge returned before opening the delivery (key_missing, bad_delivery, invalid_input) cannot be checked
 * this way and is refused. Takes the options of verifyRuling, less env.
 */
export async function verifyWithDelivery(ruling, delivery, { wasmBytes, signer, job, runner = runJudge, fetchImpl = globalThis.fetch, tx, rpc = TESTNET_ARCHIVAL_RPCS } = {}) {
  const { step, done } = reporter();
  const input = await rulingInput(ruling, { signer, job, tx, rpc, fetchImpl }, step);
  if (input === undefined) return done();
  if (!step("sealed", Boolean(ruling.secretsRef), "The ruling is for a sealed job", ruling.secretsRef ? "" : "a public job's delivery is already in the judge's input: check it without one")) return done();
  await checkWithoutKey(input, ruling.verdict, step);
  const err = ruling.verdict.err;
  const opened = !UNOPENED.has(err);
  const why = `The judge never opened the delivery (${err}), so a disclosed delivery cannot re-check this ruling`;
  if (!step("opened", opened, opened ? "The judge opened the delivery and ruled on it" : why, opened ? "" : "check it without a delivery")) return done();

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    parsed = null;
  }
  const text = typeof delivery === "string" ? delivery : null;
  const dh = text === null ? "" : await sha256Hex(new TextEncoder().encode(text));
  const committed = typeof parsed?.dh === "string" ? parsed.dh : "";
  const detail = text === null ? "the delivery must be text" : `its SHA-256 is ${dh}; the commitment is ${committed || "missing"}`;
  if (!step("delivery", text !== null && dh === committed, "The delivery is the one the worker committed to: its SHA-256 is the on-chain dh", detail)) return done();

  const bytes = await judgeBytes(ruling, wasmBytes, fetchImpl, step);
  if (!bytes) return done();

  // A plain judge input: no key and no ciphertext, so nothing secret reaches the judge.
  const localText = await runner(bytes, JSON.stringify({ criteria: parsed.criteria, deliverable: text }), {});
  const local = JSON.parse(localText);
  step("rerun", true, "Re-ran the judge here on the delivery and the job's criteria", localText);
  const same = withoutKey(local) === withoutKey(ruling.verdict);
  const label = "The judge's verdict on the delivery equals the on-chain verdict: pass, score, threshold, ch, dh and checks";
  step("match", same, label, same ? `pass: ${local.pass}, score: ${local.score}` : `here: ${localText.trim()}; on chain: ${ruling.verdictText}`);
  return done({ local, onchain: ruling.verdict });
}

/** Fetch a transaction and verify the ruling in it; with options.delivery (text), on that disclosed delivery. */
export async function verifyTransaction(txHash, signer, options = {}) {
  const tx = await fetchTransaction(txHash, signer, options);
  const ruling = findRuling(tx);
  if (!ruling) return { ok: false, steps: [{ id: "find", ok: false, label: "This transaction did not ask OutLayer to run anything", detail: "" }] };
  const { delivery, ...rest } = options;
  const report = delivery === undefined ? await verifyRuling(ruling, { ...rest, signer, tx }) : await verifyWithDelivery(ruling, delivery, { ...rest, signer, tx });
  return { ...report, ruling, asker: askerOf(tx, ruling) };
}


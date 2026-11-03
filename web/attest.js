// The TEE attestation of a ruling, checked in the browser or in Node.
//
// OutLayer records an Intel TDX attestation for every run: a quote whose report_data commits to the run's fields
// (the wasm's SHA-256, the input and output hashes, the caller, the time). This module checks one the way OutLayer's
// open-source verifier, outlayer-verify, does: Authenticity (the quote's signature chain ends at Intel's root),
// Identity (its measurements are an approved worker build on chain), Binding (its report_data is the hash of the
// record's fields), plus the input and output bytes in the transaction. The signature chain is checked by Phala's
// dcap-qvl compiled to wasm (vendor/dcap-qvl-web, MIT, pinned by SHA-256), against the Intel collateral that was
// valid when the run happened, which OutLayer archives and serves. Measurements and report_data are read only from
// the quote that verification returns, never from the record.

import { PUBLISHED_JUDGES, TESTNET_ARCHIVAL_RPCS, fetchTransaction, findRuling, inputFromEscrow, rpcCall, sha256Hex } from "./verify.js";
import { TESTNET_STATE_RPCS } from "./escrow.js";

export const ATTESTATION_API = "https://testnet-api.outlayer.ai";
export const REGISTER_CONTRACT = "worker.outlayer.testnet";
/** Records from this moment on commit to the caller, project, secrets, time and payment as well (outlayer-verify). */
export const V1_CUTOFF = 1_769_784_939;
/** @phala/dcap-qvl-web 0.3.3, unmodified, in vendor/dcap-qvl-web/. */
export const DCAP_WASM_SHA256 = "0583364c30741259992dd12055e2439e006ca234f7d13be4c77b436f242a9dc1";
const DCAP_DIR = new URL("./vendor/dcap-qvl-web/", import.meta.url);
const API_TIMEOUT_MS = 15_000;

const utf8 = new TextEncoder();
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const when = (seconds) => new Date(seconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

function le64(n, signed) {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  if (signed) view.setBigInt64(0, BigInt(n), true);
  else view.setBigUint64(0, BigInt(n), true);
  return bytes;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The commitment a worker puts in report_data[..32] before Intel signs the quote: SHA-256 over the record's fields,
 * strings as UTF-8, task_id and timestamp as little-endian i64, block_height as little-endian u64, absent fields
 * adding nothing (outlayer-verify, preimage.rs).
 */
export async function taskHash(record) {
  const parts = [utf8.encode(record.task_type), le64(record.task_id, true)];
  for (const field of [record.repo_url, record.commit_hash, record.build_target, record.wasm_hash, record.input_hash]) {
    if (field != null) parts.push(utf8.encode(String(field)));
  }
  parts.push(utf8.encode(record.output_hash));
  if (record.block_height != null) parts.push(le64(record.block_height, false));
  if (record.timestamp >= V1_CUTOFF) {
    for (const field of [record.caller_account_id, record.project_id, record.secrets_ref]) {
      if (field != null) parts.push(utf8.encode(String(field)));
    }
    parts.push(le64(record.timestamp, true));
    if (record.attached_usd != null) parts.push(utf8.encode(String(record.attached_usd)));
  }
  return sha256Hex(concat(parts));
}

/** The quote's bytes, refusing a development placeholder or anything too short to be a TDX quote. */
export function decodeQuote(record) {
  let bytes;
  try {
    bytes = fromBase64(String(record?.tdx_quote ?? ""));
  } catch {
    throw new Error("the quote is not valid base64");
  }
  if (new TextDecoder().decode(bytes) === "no-attestation-dev-mode") {
    throw new Error("this record carries no attestation: it was produced in development mode, which stores a placeholder instead of a TEE quote");
  }
  if (bytes.length < 600) throw new Error(`the quote is ${bytes.length} bytes, too short to be a TDX quote`);
  return bytes;
}

const FMSPC_OID = [0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf8, 0x4d, 0x01, 0x0d, 0x01, 0x04];

function indexOf(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * The platform id (FMSPC), read from the PCK certificate the quote carries. Read before verification, and used for
 * one thing only: asking for the right platform's collateral. A wrong one cannot pass, because the collateral's TCB
 * data must match the signed certificate.
 */
export function fmspcOf(quote) {
  let text = "";
  for (let i = 0; i < quote.length; i += 8192) text += String.fromCharCode(...quote.subarray(i, i + 8192));
  for (const m of text.matchAll(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/g)) {
    let der;
    try {
      der = fromBase64(m[1].replace(/\s+/g, ""));
    } catch {
      continue;
    }
    const at = indexOf(der, FMSPC_OID);
    const value = at + FMSPC_OID.length;
    if (at >= 0 && der[value] === 0x04 && der[value + 1] === 0x06) return toHex(der.subarray(value + 2, value + 8));
  }
  return null;
}

/** The DCAP verifier, from wasm bytes (or fetched next to this file), after checking their SHA-256 against the pin. */
export async function loadDcap(wasmBytes, { fetchImpl = globalThis.fetch } = {}) {
  let bytes = wasmBytes;
  if (!bytes) {
    const res = await fetchImpl(new URL("dcap-qvl-web_bg.wasm", DCAP_DIR));
    if (!res.ok) throw new Error(`could not load the DCAP verifier: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  const got = await sha256Hex(bytes);
  if (got !== DCAP_WASM_SHA256) throw new Error(`the DCAP verifier's wasm has SHA-256 ${got}, not the pinned ${DCAP_WASM_SHA256}`);
  const mod = await import(new URL("dcap-qvl-web.js", DCAP_DIR).href);
  await mod.default({ module_or_path: bytes });
  return { verify: (quote, collateral, nowSeconds) => mod.js_verify(quote, collateral, BigInt(nowSeconds)) };
}

async function getJson(fetchImpl, url) {
  const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(API_TIMEOUT_MS) : undefined;
  const res = await fetchImpl(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const LAYERS = [
  ["record", "OutLayer's attestation record for this transaction"],
  ["judge", "It names a published judge build"],
  ["authenticity", "Authenticity: a genuine Intel TDX quote"],
  ["identity", "Identity: an approved OutLayer worker build"],
  ["binding", "Binding: the quote commits to this run's fields"],
  ["input", "Input: the transaction's request is what was attested"],
  ["output", "Output: the transaction's result is what was attested"],
];

/**
 * Check the attestation OutLayer recorded for one ruling transaction. `input` and `output` are the exact strings
 * the transaction carries (the execution_requested event's input_data and the value OutLayer returned). Each step
 * is true (proven), false (fails) or null (unproven: the question could not be answered, which is not a pass).
 */
export async function checkAttestation({ tx, input, output }, { dcap, fetchImpl = globalThis.fetch, api = ATTESTATION_API, rpc = TESTNET_STATE_RPCS } = {}) {
  const found = new Map();
  const set = (id, ok, detail) => found.set(id, { ok, detail });
  const report = { ok: false, steps: [] };
  const finish = (reason) => {
    report.steps = LAYERS.map(([id, label]) => ({ id, label, ...(found.get(id) ?? { ok: null, detail: reason }) }));
    report.ok = report.steps.every((s) => s.ok === true);
    return report;
  };

  let record;
  try {
    record = await getJson(fetchImpl, `${api}/attestations/by-tx/${encodeURIComponent(tx)}`);
  } catch (e) {
    set("record", null, `could not be fetched from ${api}: ${e.message}`);
    return finish("not checked: there is no record to check");
  }
  if (record?.transaction_hash !== tx) {
    set("record", false, `the record served is for ${record?.transaction_hash ?? "no transaction"}, not ${tx}`);
    return finish("not checked: the record is for another transaction");
  }
  report.record = record;
  report.executedAt = when(record.timestamp);
  set("record", true, `task ${record.task_id}, run at ${report.executedAt}, asked by ${record.caller_account_id ?? "?"}`);
  set("judge", PUBLISHED_JUDGES.has(record.wasm_hash),
    PUBLISHED_JUDGES.has(record.wasm_hash) ? `wasm sha256 ${record.wasm_hash.slice(0, 8)}..., ${PUBLISHED_JUDGES.get(record.wasm_hash)}` : `wasm sha256 ${record.wasm_hash}, not a published Judge on NEAR build`);

  const hashOf = async (text) => sha256Hex(utf8.encode(text));
  for (const [id, text, attested] of [["input", input, record.input_hash], ["output", output, record.output_hash]]) {
    if (typeof text !== "string") set(id, null, "the transaction's bytes could not be read");
    else if (typeof attested !== "string") set(id, null, `this record carries no ${id}_hash`);
    else {
      const got = await hashOf(text);
      set(id, got === attested, got === attested ? `sha256 ${got.slice(0, 8)}..., read from the transaction` : `the transaction's ${id} hashes to ${got}, the attested value is ${attested}`);
    }
  }

  const unprovenQuote = (why) => {
    if (!found.has("identity")) set("identity", null, `measurements are only trustworthy from a verified quote (${why})`);
    if (!found.has("binding")) set("binding", null, `report_data is only trustworthy from a verified quote (${why})`);
  };
  let quote;
  try {
    quote = decodeQuote(record);
  } catch (e) {
    set("authenticity", false, e.message);
    unprovenQuote("no quote");
    return finish();
  }
  const fmspc = fmspcOf(quote);
  if (!fmspc) {
    set("authenticity", null, "the quote's platform id could not be read, so its Intel collateral could not be chosen");
    unprovenQuote("no collateral");
    return finish();
  }
  let collateral;
  try {
    collateral = await getJson(fetchImpl, `${api}/public/collateral?fmspc=${encodeURIComponent(fmspc)}&at=${encodeURIComponent(record.timestamp)}`);
  } catch (e) {
    set("authenticity", null, `Intel collateral for platform ${fmspc} could not be fetched: ${e.message}`);
    unprovenQuote("no collateral");
    return finish();
  }
  let verified;
  try {
    if (!dcap) throw new Error("no DCAP verifier was loaded");
    verified = dcap.verify(quote, JSON.parse(collateral.collateral), record.timestamp);
  } catch (e) {
    set("authenticity", false, `the quote did not verify: ${String(e?.message ?? e)}`);
    unprovenQuote("verification failed");
    return finish();
  }
  const td = verified?.report?.TD10 ?? verified?.report?.TD15;
  if (!td) {
    set("authenticity", false, "the verified quote is not a TDX quote");
    unprovenQuote("not TDX");
    return finish();
  }
  report.tcbStatus = verified.status;
  const advisories = Array.isArray(verified.advisory_ids) && verified.advisory_ids.length ? ` (advisories: ${verified.advisory_ids.join(", ")})` : "";
  const against = `checked against Intel's TCB data valid when the run happened (${collateral.valid_from} to ${collateral.valid_until})`;
  if (verified.status !== "UpToDate") set("authenticity", null, `the signature chain is valid, but Intel reports TCB status ${verified.status}${advisories}`);
  else if (collateral.covers_requested_time === false) set("authenticity", null, `no Intel collateral covers ${report.executedAt}; the nearest window does not show a revocation inside the gap`);
  else set("authenticity", true, `Intel signature chain valid, TCB UpToDate, ${against}`);

  const lower = (v) => String(v).toLowerCase();
  const measurements = { mrtd: lower(td.mr_td), rtmr0: lower(td.rt_mr0), rtmr1: lower(td.rt_mr1), rtmr2: lower(td.rt_mr2), rtmr3: lower(td.rt_mr3) };
  report.measurements = measurements;
  try {
    const result = await rpcCall(rpc, "query", {
      request_type: "call_function",
      finality: "final",
      account_id: REGISTER_CONTRACT,
      method_name: "is_measurements_approved",
      args_base64: btoa(JSON.stringify({ measurements })),
    }, fetchImpl);
    if (!Array.isArray(result?.result)) throw new Error(result?.error ?? "no result");
    const approved = JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
    set("identity", approved === true, approved === true ? `measurements approved on ${REGISTER_CONTRACT}` : `measurements are not in the approved list on ${REGISTER_CONTRACT}`);
  } catch (e) {
    set("identity", null, `the approved list on ${REGISTER_CONTRACT} could not be read: ${e.message}`);
  }

  const reportData = lower(td.report_data);
  const expected = await taskHash(record);
  const prefix = reportData.slice(0, 64);
  const suffix = reportData.slice(64);
  if (prefix !== expected) set("binding", false, `report_data commits to ${prefix}, but the record's fields hash to ${expected}`);
  else if (!/^0*$/.test(suffix)) set("binding", false, `the task hash matches, but report_data[32..] is ${suffix} rather than zero`);
  else set("binding", true, `report_data commits to exactly these fields (${expected.slice(0, 8)}...)`);
  return finish();
}

/**
 * Read a ruling transaction from NEAR archival nodes and check its attestation: the input is the execution_requested
 * event's input_data (rebuilt from the escrow when OutLayer kept it in state), the output is the value the OutLayer
 * contract returned.
 */
export async function checkTransactionAttestation(txHash, signer, { dcap, fetchImpl = globalThis.fetch, archival = TESTNET_ARCHIVAL_RPCS, rpc = TESTNET_STATE_RPCS, api = ATTESTATION_API } = {}) {
  let input = null;
  let output = null;
  let readError = null;
  try {
    const tx = await fetchTransaction(txHash, signer, { rpc: archival, fetchImpl });
    const ruling = findRuling(tx);
    if (!ruling) readError = "the transaction never asked OutLayer for a run";
    else {
      output = ruling.verdictText;
      input = ruling.input;
      if (input === null && ruling.inputInState) input = (await inputFromEscrow(tx, ruling, { rpc: archival, fetchImpl })).input ?? null;
    }
  } catch (e) {
    readError = e.message;
  }
  const report = await checkAttestation({ tx: txHash, input, output }, { dcap, fetchImpl, api, rpc });
  if (readError) {
    report.readError = readError;
    for (const s of report.steps) if ((s.id === "input" || s.id === "output") && s.ok === null) s.detail = `the transaction could not be read: ${readError}`;
  }
  return report;
}

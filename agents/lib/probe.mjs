// The vault probe: ask OutLayer directly, not through the escrow, to run the published judge on a sealed job with
// that job's secrets profile, with the result sealed to a key the probe holds. The vault rule on the worker's
// secret allows only this judge build when the escrow is the caller (docs/interface.md 6.2), so OutLayer must
// refuse whoever signs, the worker who owns the secret included. tools/vault-probe.mjs sends it.

import { OUTLAYER_ACCOUNTS, findRuling } from "../../web/verify.js";

/** request_execution arguments, shaped like the escrow's own request (contract/src/lib.rs, request_ruling). */
export function buildProbeArgs({ job, judge, profile, payer, clientPk }) {
  if (!job?.sealed) throw new Error("the job is not sealed: there is no secret to ask for");
  if (!job.deliverable_ct) throw new Error("the job has no sealed delivery yet");
  return {
    source: { WasmUrl: { url: judge.url, hash: judge.hash, build_target: judge.build_target } },
    resource_limits: { max_instructions: 50_000_000_000, max_memory_mb: 64, max_execution_seconds: 30 },
    input_data: JSON.stringify({ criteria: job.criteria, deliverable_ct: job.deliverable_ct, dh: job.dh, client_pk: clientPk }),
    secrets_ref: { profile, account_id: job.provider },
    response_format: "Json",
    payer_account_id: payer,
    params: null,
  };
}

/** What OutLayer did with the probe: refused (and its message), ran the judge without the key, or gave it the key. */
export function classifyProbe(final) {
  // Only OutLayer's own receipts count: any contract can log text that looks like a refusal.
  const outlayer = (final?.receipts_outcome ?? []).filter((r) => OUTLAYER_ACCOUNTS.has(r?.outcome?.executor_id));
  for (const r of outlayer) {
    for (const log of r?.outcome?.logs ?? []) {
      if (typeof log !== "string" || !log.includes("Access denied")) continue;
      let detail = log;
      if (log.startsWith("EVENT_JSON:")) {
        try {
          detail = JSON.parse(log.slice("EVENT_JSON:".length))?.data?.[0]?.error_message ?? log;
        } catch {
          detail = log;
        }
      }
      return { outcome: "refused", detail };
    }
  }
  let verdict = null;
  for (const r of outlayer) {
    const sv = r?.outcome?.status?.SuccessValue;
    if (typeof sv !== "string" || !sv) continue;
    try {
      const v = JSON.parse(Buffer.from(sv, "base64").toString("utf8"));
      if (v && v.v === 1) verdict = v;
    } catch {
      // not a verdict
    }
  }
  if (!verdict) verdict = findRuling(final)?.verdict ?? null;
  if (verdict?.err === "key_missing") return { outcome: "no-key", detail: "the judge ran without the key and answered key_missing" };
  if (verdict && typeof verdict.k === "string") return { outcome: "got-the-key", detail: "the judge read the key and sealed it to the probe's key" };
  const logs = outlayer.flatMap((r) => r?.outcome?.logs ?? []).join(" | ");
  return { outcome: "unclear", detail: logs || "no OutLayer log and no verdict" };
}

// Output helpers. Nothing here ever receives a secret: callers pass public call data only.

import crypto from "node:crypto";
import { yoctoToNear } from "near-api-js";

const LONG = 120;

/** A long string as `<first 48>...<last 16> (N chars, sha256 <hex>)`: checkable, readable. */
export function shorten(s) {
  if (typeof s !== "string" || s.length <= LONG) return s;
  const digest = crypto.createHash("sha256").update(s, "utf8").digest("hex");
  return `${s.slice(0, 48)}...${s.slice(-16)} (${s.length} chars, sha256 ${digest})`;
}

/** Shorten every long string inside a JSON value. */
export function shortenDeep(v) {
  if (typeof v === "string") return shorten(v);
  if (Array.isArray(v)) return v.map(shortenDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shortenDeep(x)]));
  return v;
}

/** "1.5 NEAR (1500000000000000000000000 yocto)" from a yocto string or bigint. */
export function describeDeposit(yocto) {
  return `${yoctoToNear(BigInt(yocto), 6)} NEAR (${BigInt(yocto)} yocto)`;
}

/** The exact contract call, as printed by --dry-run (and before a live call). */
export function describeCall(signer, call) {
  return {
    signer,
    receiver: call.contractId,
    method: call.methodName,
    args: shortenDeep(call.args),
    deposit: call.depositNote ?? describeDeposit(call.depositYocto),
    gas: `${call.gasTgas} Tgas`,
  };
}

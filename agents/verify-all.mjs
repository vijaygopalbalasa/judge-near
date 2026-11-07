#!/usr/bin/env node
// Re-run every ruling of judgenear-escrow.testnet from its transaction, one line per ruling.
//
//   cd agents && npm ci && npm run verify-all
//
// Each line calls `node jn.mjs verify` (see jn.mjs). Rulings on public deliveries, and sealed rulings whose delivery
// is published in ../evidence/, are re-run in full: VERIFIED means the published judge computes exactly the on-chain
// verdict. The sealed rulings of jobs 5 to 8 keep their delivery secret, so they get every check that needs no key
// (criteria, commitment and verdict hashes, the exact judge build) and print CONSISTENT, not re-run.
// Exit status 0 when every line is VERIFIED or CONSISTENT.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ev = (file) => path.join(HERE, "..", "evidence", file);
const W = "judgenear-worker.testnet";
const C = "judgenear-client.testnet";

const RULINGS = [
  { job: "0", tx: "G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1", signer: W },
  { job: "1", tx: "GgZvjQg35vQfMsdRovKP6ze3faQyutKFkBDDzLm7JfCT", signer: C },
  { job: "2", tx: "5nC2ABEDbFKFzVY8nzVaJooyD3uW2xxpbH2VuvgcYNsh", signer: W, delivery: ev("job-0-delivery.txt") },
  { job: "3", tx: "3sCPetXoYFwuoyStnKmjZHiLnh1rBQW9nKNyGvyfCAib", signer: C, delivery: ev("job-1-delivery.txt") },
  { job: "4 (key_missing)", tx: "J5hX6nup9AjXM4hsGXcRf29u279RAgseK3qZ9A8HPNt3", signer: W },
  { job: "4", tx: "5G6jQja3xjvw6tnzkmpE3P86Sracs5PFStJJP38o4a2J", signer: W, delivery: ev("job-0-delivery.txt") },
  { job: "5", tx: "5E4FiCfc1CQ7ywUeEDZ9jVMpkronjaCH4oNWWqM8hN71", signer: W, sealed: true },
  { job: "6", tx: "7rjHmFL8w9keTZVf1ybXVawxGTQibVdpkJxEWa2xCn7r", signer: W, sealed: true },
  { job: "7", tx: "HbByxt3x5HdNwwx8PxNWjAu5FpLATbUpr719K8uTexwB", signer: W, sealed: true },
  { job: "8", tx: "42xXF6fnYPHWEuqc1HUHK7fPDJ9MmwWXXdFYB2SuCq72", signer: W, sealed: true },
  { job: "9", tx: "7NfdY4rqEBpPHuri44XaVgJevxQtTFWv1UhUfsuKUQub", signer: W, delivery: ev("job-9-delivery.txt") },
  { job: "10", tx: "Cs7MsJRd2vcnrJCj7ZyUsfrioRSweF5GNrcUbSwWbNo5", signer: W, delivery: ev("job-10-delivery.csv") },
];

let bad = 0;
for (const r of RULINGS) {
  const args = [path.join(HERE, "jn.mjs"), "verify", "--tx", r.tx, "--signer", r.signer];
  if (r.delivery) args.push("--delivery", r.delivery);
  const run = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, JN_ESCROW: "judgenear-escrow.testnet" } });
  const out = `${run.stdout}\n${run.stderr}`;
  const verdict = /\(pass: (true|false), score: (\d+)\)/.exec(out);
  const failed = out.split("\n").filter((l) => l.startsWith("FAIL")).length;
  let status;
  if (run.status === 0 && /^Verified:/m.test(out)) status = "VERIFIED  ";
  else if (r.sealed && failed === 0 && /not re-run/.test(out)) status = "CONSISTENT";
  else {
    status = "FAILED    ";
    bad += 1;
  }
  const what = verdict ? `pass: ${verdict[1]}, score: ${verdict[2]}` : r.sealed ? "sealed, delivery not published" : "";
  console.log(`${status} job ${r.job.padEnd(16)} ${r.tx.slice(0, 6)}...  ${what}`);
  if (status.startsWith("FAILED")) console.log(out.trim().split("\n").slice(-5).map((l) => `    ${l}`).join("\n"));
}
console.log(bad === 0 ? `\nAll ${RULINGS.length} rulings check out.` : `\n${bad} of ${RULINGS.length} rulings did not check out.`);
process.exit(bad === 0 ? 0 : 1);

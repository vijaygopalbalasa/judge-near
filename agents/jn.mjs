#!/usr/bin/env node
// jn: run a Judge on NEAR job end to end on testnet. See README.md.
// Network: testnet. Escrow: the JN_ESCROW environment variable. Signer: --as <account>.

import crypto from "node:crypto";
import os from "node:os";
import { parseArgs } from "node:util";
import { COMMANDS } from "./lib/commands.mjs";
import { DEFAULT_RPC_URL } from "./lib/config.mjs";
import { createNear } from "./lib/near.mjs";

const USAGE = `usage: node jn.mjs <command> [options]   (escrow from JN_ESCROW; every command takes --dry-run)

  create        --as CLIENT --provider P --criteria file.json --expires-in 2h [--sealed]
  fund          --as CLIENT --job N --amount 1
  submit        --as PROVIDER --job N --file deliverable.txt
  submit-sealed --as PROVIDER --job N --file deliverable.txt
  ruling        --as CLIENT_OR_PROVIDER --job N
  open          --as CLIENT --job N [--out file]
  status        --job N
  verify        --tx HASH --signer ACCOUNT [--as CLIENT_OR_PROVIDER]

  --dry-run      print the exact call(s) and stop: no key is read, nothing is sent
  --min-deposit  (ruling --dry-run) NEAR amount to show instead of get_judge's

  verify re-runs a ruling here with the browser verifier's code and prints each check. A sealed
  ruling needs the deliverable key: --as the job's client (after the key is released) or its
  provider loads it from ~/.judge-near, in memory only. submit-sealed on a job that key_missing
  sent back to Submitted stores the saved key again; then ask for a ruling again.

  Live, every command except open, status and verify first checks that the escrow runs the
  published escrow build and the published judge, and ruling refuses a deposit above
  0.1 NEAR. To accept another build on purpose, name its exact hash:
  --escrow-code-hash  the escrow's base58 code hash
  --judge-hash        the judge's sha256 (also the hash submit-sealed --dry-run shows)
`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      as: { type: "string" },
      provider: { type: "string" },
      criteria: { type: "string" },
      "expires-in": { type: "string" },
      sealed: { type: "boolean" },
      job: { type: "string" },
      amount: { type: "string" },
      file: { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean" },
      "judge-hash": { type: "string" },
      "escrow-code-hash": { type: "string" },
      "min-deposit": { type: "string" },
      tx: { type: "string" },
      signer: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  process.stderr.write(`${e.message}\n\n${USAGE}`);
  process.exit(1);
}
const { values, positionals } = parsed;
const name = positionals[0];
if (values.help || !name) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!COMMANDS[name] || positionals.length > 1) {
  process.stderr.write(`unknown command: ${positionals.join(" ")}\n\n${USAGE}`);
  process.exit(1);
}

const dryRun = Boolean(values["dry-run"]);
const refuse = () => {
  throw new Error("--dry-run never uses the network");
};
const deps = {
  env: process.env,
  home: os.homedir(),
  out: (line) => process.stdout.write(`${line}\n`),
  rng: (n) => crypto.randomBytes(n),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetch: dryRun ? refuse : globalThis.fetch,
  near: dryRun
    ? { codeHash: refuse, view: refuse, call: refuse, txStatus: refuse }
    : createNear({ rpcUrl: process.env.JN_RPC || DEFAULT_RPC_URL, home: os.homedir() }),
};

try {
  await COMMANDS[name](values, deps);
} catch (e) {
  process.stderr.write(`jn ${name}: ${e?.message ?? e}\n`);
  process.exit(1);
}

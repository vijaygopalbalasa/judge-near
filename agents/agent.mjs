#!/usr/bin/env node
// Two agents on a Judge on NEAR escrow (testnet), sharing nothing but the chain: a client that
// posts and funds a sealed job, and a worker that delivers it sealed and asks for the ruling.
// See README.md, "Two agents, no human".

import crypto from "node:crypto";
import os from "node:os";
import { parseArgs } from "node:util";
import { preview, runClient, runWorker } from "./lib/agent.mjs";
import { DEFAULT_RPC_URL } from "./lib/config.mjs";
import { createNear } from "./lib/near.mjs";

const USAGE = `usage: node agent.mjs <role> [options]   (escrow from JN_ESCROW; testnet)

  worker   --as WORKER [--once] [--min-amount 0.1] [--deliver-anyway]
           watches the escrow for funded sealed jobs that name WORKER and pay at least
           --min-amount NEAR, fills the fields their criteria require from facts it reads on
           chain, runs the judge on the report here, and only if it passes delivers it sealed
           and asks for the ruling (--deliver-anyway: deliver a failing report too, to show a
           failing delivery; --once: one job, then exit)
  client   --as CLIENT --provider WORKER --task tasks/escrow-report.json [--amount 0.5] [--expires-in 2h] [--out-dir .]
           posts a sealed job with these criteria, funds it, waits for the ruling, and opens
           the delivery if it passed
  preview  --task tasks/escrow-report.json
           reads the escrow and prints the report the worker would deliver for the next job and
           the judge's verdict on it, run here; no NEAR account or key needed, signs nothing

  worker and client sign with the keys in ~/.near-credentials/testnet and keep their secrets
  under ~/.judge-near, like jn.mjs. RPC: JN_RPC (default ${DEFAULT_RPC_URL}).
`;

const ROLES = { worker: runWorker, client: runClient, preview };

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      as: { type: "string" },
      provider: { type: "string" },
      task: { type: "string" },
      amount: { type: "string" },
      "expires-in": { type: "string" },
      "out-dir": { type: "string" },
      once: { type: "boolean" },
      "min-amount": { type: "string" },
      "deliver-anyway": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (e) {
  process.stderr.write(`${e.message}\n\n${USAGE}`);
  process.exit(1);
}
const { values, positionals } = parsed;
const role = positionals[0];
if (values.help || !role) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (!ROLES[role] || positionals.length > 1) {
  process.stderr.write(`unknown role: ${positionals.join(" ")}\n\n${USAGE}`);
  process.exit(1);
}

const deps = {
  env: process.env,
  home: os.homedir(),
  out: (line) => process.stdout.write(`${line}\n`),
  rng: (n) => crypto.randomBytes(n),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetch: globalThis.fetch,
  near: createNear({ rpcUrl: process.env.JN_RPC || DEFAULT_RPC_URL, home: os.homedir() }),
  tmpdir: os.tmpdir(),
};
const opts = {
  as: values.as,
  provider: values.provider,
  task: values.task,
  amount: values.amount,
  expiresIn: values["expires-in"],
  outDir: values["out-dir"],
  once: Boolean(values.once),
  minAmount: values["min-amount"],
  deliverAnyway: Boolean(values["deliver-anyway"]),
};

try {
  await ROLES[role](opts, deps);
} catch (e) {
  process.stderr.write(`agent ${role}: ${e?.message ?? e}\n`);
  process.exit(1);
}

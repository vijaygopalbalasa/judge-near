#!/usr/bin/env node
// The whole flow, offline, in a few seconds:
//
//   cd agents && npm ci && npm run demo
//
// A client agent posts and funds a sealed job; a worker agent fills the report, checks it with the judge, delivers it
// sealed and asks for the ruling; the real published judge rules on it; the worker is paid and the client opens the
// exact report. Then a job the worker cannot fully do, sent anyway: the judge fails it and the client is refunded.
// The escrow and OutLayer are stand-ins in memory (lib/demo-chain.mjs); the agents, the encryption and the judge are
// the real ones. No NEAR account, no network, no key file: everything goes to a temporary folder that is removed.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runClient, runWorker } from "./lib/agent.mjs";
import { fakeChain, fakeClock } from "./lib/demo-chain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ESCROW = "escrow.demo.testnet";
const CLIENT = "client.demo.testnet";
const WORKER = "worker.demo.testnet";
const DAY = 24 * 60 * 60 * 1000;
// The agents look for a NEAR key file; this one is a placeholder that signs nothing (the stand-in chain needs none).
const PLACEHOLDER_KEY = "ed25519:DemoPlaceholderKeyNotReal7Qm2Wx9Zk4Lp8Rv3Ty6Ub1Nc5Hd0Gj";
const sha256hex = (x) => crypto.createHash("sha256").update(x).digest("hex");

/** One job, both agents at once on a fresh stand-in chain, in a temporary folder removed afterwards. */
async function oneJob(task, workerOpts, out) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jn-demo-"));
  try {
    const home = path.join(root, "home");
    const creds = path.join(home, ".near-credentials", "testnet");
    fs.mkdirSync(creds, { recursive: true });
    for (const account of [CLIENT, WORKER]) fs.writeFileSync(path.join(creds, `${account}.json`), JSON.stringify({ account_id: account, private_key: PLACEHOLDER_KEY }));
    const tmpdir = path.join(root, "work");
    const outDir = path.join(root, "opened");
    fs.mkdirSync(tmpdir);
    fs.mkdirSync(outDir);
    const chain = fakeChain([], { escrow: ESCROW });
    const clock = fakeClock(Date.now());
    const deps = (label) => ({
      env: { JN_ESCROW: ESCROW }, home, tmpdir, rng: crypto.randomBytes, now: clock.now, sleep: clock.sleep, fetch: chain.fetch, near: chain.near,
      // The agents print each call they would sign as JSON, and the escrow's code check before each step; the demo
      // keeps their sentences.
      out: (s) => {
        const line = String(s);
        if (!/^\s*[[\]{}"]/.test(line) && !/^escrow \S+: code /.test(line)) out(`[${label}] ${line}`);
      },
    });
    const [, client] = await Promise.all([
      runWorker({ as: WORKER, once: true, waitMs: DAY, ...workerOpts }, deps("worker")),
      runClient({ as: CLIENT, provider: WORKER, task: path.join(HERE, "tasks", task), amount: "0.5", expiresIn: "2h", outDir, timeoutMs: DAY }, deps("client")),
    ]);
    const job = chain.jobs[client.jobId];
    const opened = client.out ? fs.readFileSync(client.out, "utf8") : null;
    if (opened !== null) out(opened.split("\n").map((l) => `         ${l}`).join("\n"));
    return { state: job.state, keyReleased: typeof job.k === "string", opened: opened !== null && sha256hex(opened) === job.dh, vaultEmpty: chain.secrets.size === 0 };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function runDemo({ out = console.log } = {}) {
  out("Judge on NEAR, offline: two agents, the real judge and real encryption, on an escrow and OutLayer kept in memory.");
  out("No NEAR account, no network, no key file: paths shown under ~ are in the demo's own temporary home, removed at");
  out("the end.");
  out("");
  out("1. The client requires a report with seven fields; the worker has a fact for each.");
  const pass = await oneJob("escrow-report.json", {}, out);
  out(pass.state === "Completed" && pass.opened
    ? "=> Completed: the worker was paid and the client opened the exact report (its SHA-256 is the dh on chain)."
    : `=> unexpected: ${JSON.stringify(pass)}`);
  out("");
  out("2. The client also requires mainnet_tvl_usd, which the worker has no fact for. Its own check says the report");
  out("   would fail; --deliver-anyway sends it to show a failing ruling.");
  const fail = await oneJob("escrow-report-with-tvl.json", { deliverAnyway: true }, out);
  out(fail.state === "Refunded" && !fail.keyReleased
    ? "=> Refunded: the client was refunded and the key was never released, so the report stays sealed."
    : `=> unexpected: ${JSON.stringify(fail)}`);
  out("");
  out("Both runs: the worker deleted its key from the vault once the job settled. The same agents run on testnet with");
  out("node agent.mjs worker|client (see the README, \"Two agents, no human\").");
  return { pass, fail };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runDemo();

// The two agents: the worker's skill (fill the fields the client's criteria require, from facts
// read on chain) and the client and worker roles running a sealed job with no human input.
// Runs offline: the real judge runs here through web/verify.js's WASI host.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publicFromSecret } from "../../judge-wasm/scripts/sealed.mjs";
import { runJudge } from "../../web/verify.js";
import { preview, runClient, runWorker } from "../lib/agent.mjs";
import { COMMANDS } from "../lib/commands.mjs";
import { PUBLISHED_ESCROW_CODE_HASH } from "../lib/config.mjs";
import { eciesDecrypt, secretsProfile } from "../lib/keystore.mjs";
import { deliverableFor, escrowFacts } from "../lib/skill.mjs";

const AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(AGENTS, "..");
const judge = new Uint8Array(fs.readFileSync(path.join(ROOT, "judge-wasm", "release", "judge.wasm")));
const PASS_TASK = fs.readFileSync(path.join(AGENTS, "tasks", "escrow-report.json"), "utf8");
const FAIL_TASK = fs.readFileSync(path.join(AGENTS, "tasks", "escrow-report-with-tvl.json"), "utf8");
const FACTS = {
  escrow: "escrow.judgenear.testnet",
  job: 5,
  jobs: 6,
  completed: 3,
  refunded: 2,
  paid_to_workers: "1.5 NEAR",
  read_at: "2026-11-02T15:00:00.000Z",
};
const judgeOn = async (criteria, deliverable) => JSON.parse(await runJudge(judge, JSON.stringify({ criteria, deliverable })));

// ---- the worker's skill ----

test("the skill fills every field the client's schema check requires, with the type it names, and the real judge passes it", async () => {
  const { text, missing } = deliverableFor(PASS_TASK, FACTS);
  assert.deepEqual(missing, []);
  const report = JSON.parse(text);
  assert.deepEqual(Object.keys(report), ["escrow", "job", "jobs", "completed", "refunded", "paid_to_workers", "read_at"]);
  assert.deepEqual(report, FACTS);
  const verdict = await judgeOn(PASS_TASK, text);
  assert.equal(verdict.pass, true, JSON.stringify(verdict));
  assert.equal(verdict.score, 100);
});

test("the fail run's proof: a field the skill cannot supply is left out, never invented, and the judge fails the schema check", async () => {
  const { text, missing } = deliverableFor(FAIL_TASK, FACTS);
  assert.deepEqual(missing, ["mainnet_tvl_usd"]);
  assert.ok(!("mainnet_tvl_usd" in JSON.parse(text)));
  const verdict = await judgeOn(FAIL_TASK, text);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.checks.map((c) => [c.id.split("#")[0], c.ok]), [["schema", false], ["length", true]]);
});

test("a fact of the wrong type counts as missing; it is never sent as another type", () => {
  const { text, missing } = deliverableFor(PASS_TASK, { ...FACTS, jobs: "6", read_at: undefined });
  assert.deepEqual(missing, ["jobs", "read_at"]);
  const report = JSON.parse(text);
  assert.ok(!("jobs" in report) && !("read_at" in report));
});

test("the skill takes only criteria that ask for a JSON object with named fields", () => {
  assert.throws(() => deliverableFor("not json", FACTS), /criteria are not JSON/);
  assert.throws(() => deliverableFor('{"checks":[{"kind":"length","params":{"max":10}}]}', FACTS), /no schema check/);
  assert.throws(() => deliverableFor('{"checks":[{"kind":"schema","params":{}}]}', FACTS), /names no required fields/);
});

test("escrowFacts counts the escrow's jobs and what they paid, at the worker's clock", () => {
  const job = (state, amount, sealed = false) => ({ state, amount, sealed });
  const jobs = [job("Completed", "500000000000000000000000"), job("Refunded", "500000000000000000000000"), job("Completed", "1000000000000000000000000", true), job("Funded", "500000000000000000000000", true)];
  assert.deepEqual(escrowFacts({ escrow: "escrow.judgenear.testnet", jobId: 3, jobs, now: Date.UTC(2026, 10, 2, 15) }), {
    escrow: "escrow.judgenear.testnet",
    job: 3,
    jobs: 4,
    completed: 2,
    refunded: 1,
    paid_to_workers: "1.5 NEAR",
    read_at: "2026-11-02T15:00:00.000Z",
  });
});

// ---- the two roles, against a fake escrow and OutLayer that run the real judge ----

const ESCROW = "escrow.judgenear.testnet";
const CLIENT = "alice.testnet";
const WORKER = "bob.testnet";
const PASS_FILE = path.join(AGENTS, "tasks", "escrow-report.json");
const FAIL_FILE = path.join(AGENTS, "tasks", "escrow-report-with-tvl.json");
const JUDGE_HASH = fs.readFileSync(path.join(ROOT, "judge-wasm", "release", "judge.wasm.sha256"), "utf8").split(/\s+/)[0];
const FAKE_NEAR_KEY = "ed25519:FAKEtestKeyNotReal7Qm2Wx9Zk4Lp8Rv3Ty6Ub1Nc5Hd0Gj";
const b64 = (s) => Buffer.from(s).toString("base64");
const DAY = 24 * 60 * 60 * 1000;
const sha256hex = (x) => crypto.createHash("sha256").update(x).digest("hex");

// Every temporary folder a test makes is removed when the file's tests end.
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A temporary HOME with a fake NEAR key for both accounts. */
function tempHome() {
  const home = tempDir("jn-agent-test-");
  const dir = path.join(home, ".near-credentials", "testnet");
  fs.mkdirSync(dir, { recursive: true });
  for (const account of [CLIENT, WORKER]) fs.writeFileSync(path.join(dir, `${account}.json`), JSON.stringify({ account_id: account, private_key: FAKE_NEAR_KEY }));
  return home;
}

/** One clock for both roles: sleeping moves it forward and lets the other role run. */
function fakeClock(start = 1_762_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      // One real millisecond per fake wait, so the fake clock cannot race far ahead of real work.
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
}

/** deps for one role, with a deterministic rng that records every 32-byte key it hands out. */
function roleDeps(label, { home, chain, clock, tmpdir }) {
  const lines = [];
  const keys = [];
  let draws = 0;
  const rng = (size) => {
    const b = Buffer.alloc(size);
    for (let at = 0; at < size; at += 32) crypto.createHash("sha256").update(`agent test ${label} ${draws}:${at}`).digest().copy(b, at);
    draws += 1;
    if (size === 32) keys.push(Buffer.from(b));
    return b;
  };
  const deps = { env: { JN_ESCROW: ESCROW }, home, out: (s) => lines.push(String(s)), rng, now: clock.now, sleep: clock.sleep, fetch: chain.fetch, near: chain.near, tmpdir };
  return { deps, lines, keys };
}

function jobView(extra) {
  return { client: CLIENT, provider: WORKER, criteria: "{}", ch: "", deliverable: "", dh: "", sealed: true, client_pk: "c".repeat(64), deliverable_ct: "", k: null, amount: "500000000000000000000000", state: "Completed", expires_at_ns: "1", attempt: "1", created_at_ns: "1", ...extra };
}

/** A stateful fake escrow and OutLayer: jobs advance as the agents call them; request_ruling runs the real judge with the K the fake keystore received. */
function fakeChain(existing = []) {
  const keystoreSecret = crypto.randomBytes(32);
  const jobs = existing.map((j) => ({ ...j }));
  const secrets = new Map();
  const finals = new Map();
  const calls = [];
  let n = 0;
  const near = {
    codeHash: async () => PUBLISHED_ESCROW_CODE_HASH,
    view: async (contract, method, args) => {
      assert.equal(contract, ESCROW);
      if (method === "get_judge") return { outlayer: "outlayer.testnet", url: "https://example.test/judge.wasm", hash: JUDGE_HASH, build_target: "wasm32-wasip1", min_ruling_deposit: "10000000000000000000000" };
      if (method === "get_secrets_profile") return jobs[args.job_id]?.sealed ? secretsProfile(ESCROW, args.job_id) : null;
      if (method === "get_job") return jobs[args.job_id] ? { ...jobs[args.job_id] } : null;
      if (method === "list_jobs") return jobs.slice(args.from_index, args.from_index + args.limit).map((j) => ({ ...j }));
      throw new Error(`unexpected view ${method}`);
    },
    call: async (signer, c) => {
      const txHash = `tx${++n}`;
      const a = c.args;
      calls.push({ signer, contract: c.contractId, method: c.methodName, job: a.job_id });
      const ok = (value) => ({ txHash, outcome: { status: { SuccessValue: value === undefined ? "" : b64(JSON.stringify(value)) } } });
      if (c.contractId === "outlayer.testnet" && c.methodName === "store_secrets") {
        secrets.set(a.profile, JSON.parse(eciesDecrypt(keystoreSecret, a.encrypted_secrets_base64)).JN_KEY);
        return ok();
      }
      assert.equal(c.contractId, ESCROW);
      const j = jobs[a.job_id];
      switch (c.methodName) {
        case "create_job":
          jobs.push(jobView({ client: signer, provider: a.provider, criteria: a.criteria, ch: sha256hex(a.criteria), sealed: Boolean(a.client_pk), client_pk: a.client_pk ?? null, amount: "0", state: "Open", expires_at_ns: a.expires_at_ns, attempt: "0" }));
          return ok(jobs.length - 1);
        case "fund":
          assert.equal(j.client, signer);
          assert.equal(j.state, "Open");
          Object.assign(j, { amount: c.depositYocto, state: "Funded" });
          return ok();
        case "submit_sealed":
          assert.equal(j.provider, signer);
          assert.equal(j.state, "Funded");
          Object.assign(j, { deliverable_ct: a.deliverable_ct, dh: a.dh, state: "Submitted" });
          return ok();
        case "request_ruling": {
          assert.ok([j.client, j.provider].includes(signer));
          assert.equal(j.state, "Submitted");
          const key = secrets.get(secretsProfile(ESCROW, a.job_id));
          const text = await runJudge(judge, JSON.stringify({ criteria: j.criteria, deliverable_ct: j.deliverable_ct, dh: j.dh, client_pk: j.client_pk }), key ? { JN_KEY: key } : {});
          const verdict = JSON.parse(text);
          j.attempt = String(Number(j.attempt) + 1);
          if (verdict.err === "key_missing") j.state = "Submitted";
          else if (verdict.pass) Object.assign(j, { state: "Completed", k: verdict.k });
          else j.state = "Refunded";
          finals.set(txHash, { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { executor_id: "outlayer.testnet", logs: [], status: { SuccessValue: b64(text) } } }] });
          return { txHash, outcome: {} };
        }
        default:
          throw new Error(`unexpected call ${c.methodName}`);
      }
    },
    txStatus: async (txHash) => {
      if (!finals.has(txHash)) throw new Error("pending");
      return finals.get(txHash);
    },
  };
  const fetch = async () => ({ ok: true, json: async () => ({ pubkey: publicFromSecret(keystoreSecret).toString("hex") }) });
  return { near, fetch, jobs, calls };
}

/** No 32-byte secret either role drew appears in any printed line, as hex or base64. */
function assertNoSecretPrinted(lines, keys, who) {
  const text = lines.join("\n");
  for (const k of keys) {
    assert.ok(!text.includes(k.toString("hex")), `${who} printed a secret as hex`);
    assert.ok(!text.includes(k.toString("base64")), `${who} printed a secret as base64`);
  }
}

/** Both roles at once on one fake chain, as two processes would run them. */
/** The same chain, but the first `failures[method]` reads of each method fail, as a busy RPC node would. */
function flakyReads(near, failures) {
  const left = { ...failures };
  return {
    ...near,
    view: async (contract, method, args) => {
      if (left[method] > 0) {
        left[method] -= 1;
        throw new Error("HTTP 429");
      }
      return near.view(contract, method, args);
    },
  };
}

async function runBoth(task, existing, { flaky = false, workerOpts = {} } = {}) {
  const chain = fakeChain(existing);
  const clock = fakeClock();
  const home = tempHome();
  const tmpdir = tempDir("jn-agent-work-");
  const outDir = tempDir("jn-agent-out-");
  const worker = roleDeps("worker", { home, chain, clock, tmpdir });
  const client = roleDeps("client", { home, chain, clock, tmpdir });
  if (flaky) {
    // The worker's first poll and the client's first two polls fail.
    worker.deps.near = flakyReads(chain.near, { list_jobs: 1 });
    client.deps.near = flakyReads(chain.near, { get_job: 2 });
  }
  const [w, c] = await Promise.all([
    // The shared fake clock moves on every poll, while the real judge takes real time; generous waits
    // keep either role from giving up while the other is still working (the timeouts have their own test).
    runWorker({ as: WORKER, once: true, waitMs: DAY, ...workerOpts }, worker.deps),
    runClient({ as: CLIENT, provider: WORKER, task, amount: "0.5", expiresIn: "2h", outDir, timeoutMs: DAY }, client.deps),
  ]);
  return { chain, worker, client, w, c, tmpdir, outDir };
}

const OTHERS = [
  jobView({ state: "Completed" }),
  jobView({ state: "Funded", provider: "carol.testnet" }),
  jobView({ state: "Funded", sealed: false, client_pk: null }),
];

test("two agents, no human: the client posts and funds a sealed job, the worker delivers it sealed, the judge passes it, the worker is paid and the client opens the exact report", async () => {
  const { chain, worker, client, w, c, tmpdir, outDir } = await runBoth(PASS_FILE, OTHERS);
  const id = OTHERS.length;
  assert.equal(c.jobId, id);
  assert.equal(c.state, "Completed");
  assert.equal(w.jobId, id);
  assert.equal(w.verdict.pass, true);
  const job = chain.jobs[id];
  assert.equal(job.state, "Completed");
  assert.equal(typeof job.k, "string");
  assert.deepEqual(chain.calls.map((x) => [x.signer, x.method, x.job]), [
    [CLIENT, "create_job", undefined],
    [CLIENT, "fund", id],
    [WORKER, "store_secrets", undefined],
    [WORKER, "submit_sealed", id],
    [WORKER, "request_ruling", id],
  ]);
  const opened = fs.readFileSync(c.out, "utf8");
  assert.equal(path.dirname(c.out), outDir);
  assert.equal(sha256hex(opened), job.dh);
  const report = JSON.parse(opened);
  assert.equal(report.job, id);
  assert.equal(report.jobs, OTHERS.length + 1);
  assert.ok(client.lines.join("\n").includes(opened), "the client sees the report once it is opened");
  const workerText = worker.lines.join("\n");
  assert.ok(!workerText.includes(opened) && !workerText.includes(report.read_at), "the worker never prints the sealed report");
  assertNoSecretPrinted(worker.lines, [...worker.keys, ...client.keys], "worker");
  assertNoSecretPrinted(client.lines, [...worker.keys, ...client.keys], "client");
  assert.deepEqual(fs.readdirSync(tmpdir), [], "the worker removes its plaintext file");
});

test("the fail run (--deliver-anyway): the client requires a field the worker cannot supply; the judge fails it, the client is refunded and the key is never released", async () => {
  const { chain, worker, client, w, c, outDir } = await runBoth(FAIL_FILE, [], { workerOpts: { deliverAnyway: true } });
  assert.equal(c.state, "Refunded");
  assert.equal(w.verdict.pass, false);
  assert.deepEqual(w.missing, ["mainnet_tvl_usd"]);
  assert.equal(chain.jobs[0].state, "Refunded");
  assert.equal(chain.jobs[0].k, null);
  assert.deepEqual(fs.readdirSync(outDir), [], "nothing is opened");
  assert.match(client.lines.join("\n"), /job 0: refunded; the key was never released, so the delivery stays sealed/);
  const workerText = worker.lines.join("\n");
  assert.match(workerText, /no fact for mainnet_tvl_usd, so it is left out/);
  assert.match(workerText, /the judge, run here, would fail this report \(score 50: schema#0 failed\); delivering it anyway \(--deliver-anyway\)/);
});

test("the worker skips a funded job it cannot do, and signs nothing for it", async () => {
  const chain = fakeChain([jobView({ state: "Funded", criteria: '{"checks":[{"kind":"length","params":{"max":10}}]}' })]);
  const { deps, lines } = roleDeps("worker", { home: tempHome(), chain, clock: fakeClock(), tmpdir: tempDir("jn-agent-work-") });
  const result = await runWorker({ as: WORKER, once: true }, deps);
  assert.equal(result.jobId, 0);
  assert.match(result.skipped, /no schema check/);
  assert.deepEqual(chain.calls, []);
  assert.match(lines.join("\n"), /job 0: skipped/);
});

test("a worker with nothing to do stops after its wait, and a client whose job never settles says how to check it later", async () => {
  const chain = fakeChain([]);
  const { deps } = roleDeps("worker", { home: tempHome(), chain, clock: fakeClock(), tmpdir: tempDir("jn-agent-work-") });
  await assert.rejects(runWorker({ as: WORKER, once: true, waitMs: 60_000 }, deps), /no funded sealed job for bob\.testnet appeared within 1 minute/);
  const quiet = fakeChain([]);
  const client = roleDeps("client", { home: tempHome(), chain: quiet, clock: fakeClock(), tmpdir: tempDir("jn-agent-work-") });
  await assert.rejects(runClient({ as: CLIENT, provider: WORKER, task: PASS_FILE, amount: "0.5", expiresIn: "2h", outDir: tempDir("jn-agent-out-"), timeoutMs: 60_000 }, client.deps), /job 0 is still Funded after 1 minute; check later with: node jn\.mjs status --job 0/);
});

test("preview reads the escrow, signs nothing, and shows the report the worker would deliver with the judge's verdict on it, run here", async () => {
  const chain = fakeChain(OTHERS);
  const { deps, lines } = roleDeps("preview", { home: tempHome(), chain, clock: fakeClock(), tmpdir: tempDir("jn-agent-work-") });
  const got = await preview({ task: PASS_FILE }, deps);
  assert.equal(got.verdict.pass, true);
  assert.equal(JSON.parse(got.text).job, OTHERS.length, "the report is for the next job id");
  assert.deepEqual(chain.calls, []);
  const text = lines.join("\n");
  assert.ok(text.includes(got.text));
  assert.match(text, /the judge, run here: pass, score 100/);
  const bad = await preview({ task: FAIL_FILE }, deps);
  assert.equal(bad.verdict.pass, false);
  assert.match(lines.join("\n"), /no fact for mainnet_tvl_usd/);
});

test("agent.mjs: --help lists the three roles; an unknown role or a missing option fails before anything runs", () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(AGENTS, "agent.mjs"), ...args], { encoding: "utf8", env: { ...process.env, JN_ESCROW: ESCROW, JN_RPC: "http://127.0.0.1:9" } });
  const help = run("--help");
  assert.equal(help.status, 0);
  for (const role of ["worker", "client", "preview"]) assert.match(help.stdout, new RegExp(`^  ${role} `, "m"));
  assert.match(help.stdout, /signs nothing/);
  assert.match(help.stdout, /--deliver-anyway/);
  assert.match(help.stdout, /--min-amount 0\.1/);
  const unknown = run("dance");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown role: dance/);
  const noTask = run("client", "--as", CLIENT, "--provider", WORKER);
  assert.equal(noTask.status, 1);
  assert.match(noTask.stderr, /--task needs a criteria file/);
});

test("a failed read while polling is retried on the next tick; it does not stop either agent", async () => {
  const { worker, client, w, c } = await runBoth(PASS_FILE, [], { flaky: true });
  assert.equal(c.state, "Completed");
  assert.equal(w.verdict.pass, true);
  assert.match(worker.lines.join("\n"), /reading the escrow failed \(HTTP 429\); trying again in 5 s/);
  assert.match(client.lines.join("\n"), /reading job 0 failed \(HTTP 429\); trying again in 5 s/);
});

const REAL_CLIENT_PK = publicFromSecret(Buffer.alloc(32, 7)).toString("hex");

test("by default the worker runs the judge on its report first, and does not deliver one the judge would fail", async () => {
  const chain = fakeChain([jobView({ state: "Funded", criteria: FAIL_TASK, client_pk: REAL_CLIENT_PK })]);
  const { deps, lines } = roleDeps("worker", { home: tempHome(), chain, clock: fakeClock(), tmpdir: tempDir("jn-agent-work-") });
  const result = await runWorker({ as: WORKER, once: true }, deps);
  assert.equal(result.jobId, 0);
  assert.match(result.declined, /the judge would fail it/);
  assert.equal(result.verdict.score, 50);
  assert.deepEqual(chain.calls, [], "nothing signed, so nothing spent");
  assert.match(lines.join("\n"), /job 0: the judge, run here, would fail this report \(score 50: schema#0 failed\); not delivering, nothing signed/);
});

test("the worker does not work for less than its minimum price (0.1 NEAR unless --min-amount says otherwise)", async () => {
  const cheap = jobView({ state: "Funded", criteria: PASS_TASK, amount: "10000000000000000000000", client_pk: REAL_CLIENT_PK }); // 0.01 NEAR
  const chain = fakeChain([cheap]);
  const { deps, lines } = roleDeps("worker", { home: tempHome(), chain, clock: fakeClock(), tmpdir: tempDir("jn-agent-work-") });
  const result = await runWorker({ as: WORKER, once: true }, deps);
  assert.match(result.declined, /below the minimum price/);
  assert.deepEqual(chain.calls, []);
  assert.match(lines.join("\n"), /job 0: pays 0\.01 NEAR, below this worker's minimum of 0\.1 NEAR; not delivering, nothing signed/);
  const willing = fakeChain([cheap]);
  const w2 = roleDeps("worker-2", { home: tempHome(), chain: willing, clock: fakeClock(), tmpdir: tempDir("jn-agent-work-") });
  const taken = await runWorker({ as: WORKER, once: true, minAmount: "0.01" }, w2.deps);
  assert.equal(taken.verdict.pass, true);
});

test("the client shows control characters in an opened delivery as visible codes, never raw; the file keeps the exact bytes", async () => {
  const chain = fakeChain([]);
  const clock = fakeClock();
  const home = tempHome();
  const tmpdir = tempDir("jn-agent-work-");
  const outDir = tempDir("jn-agent-out-");
  const taskFile = path.join(tempDir("jn-agent-task-"), "any-text.json");
  fs.writeFileSync(taskFile, '{"checks":[{"kind":"length","params":{"max":200,"unit":"chars"}}]}');
  const hostile = "report\u001b[2J\u001b]0;owned\u0007\rdone\n";
  const evil = roleDeps("evil", { home, chain, clock, tmpdir });
  const client = roleDeps("client", { home, chain, clock, tmpdir });
  const evilWorker = async () => {
    while (chain.jobs[0]?.state !== "Funded") await clock.sleep(5_000);
    const file = path.join(tmpdir, "hostile.txt");
    fs.writeFileSync(file, hostile);
    await COMMANDS["submit-sealed"]({ as: WORKER, job: "0", file }, evil.deps);
    await COMMANDS.ruling({ as: WORKER, job: "0" }, evil.deps);
  };
  const [, c] = await Promise.all([evilWorker(), runClient({ as: CLIENT, provider: WORKER, task: taskFile, amount: "0.5", expiresIn: "2h", outDir, timeoutMs: DAY }, client.deps)]);
  assert.equal(c.state, "Completed");
  const text = client.lines.join("\n");
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text), "no raw control character reaches the terminal");
  assert.ok(text.includes("report\\x1b[2J\\x1b]0;owned\\x07\\x0ddone"), text);
  assert.equal(fs.readFileSync(c.out, "utf8"), hostile);
});

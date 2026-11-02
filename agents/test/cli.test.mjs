// The agent commands: what they send, where secrets go, and that no key material is ever
// printed. Runs offline: a fake chain and a fake keystore stand in for the network, and
// HOME is a fresh temporary directory holding a FAKE NEAR key.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptDeliverable, encryptDeliverable, publicFromSecret, sealK } from "../../judge-wasm/scripts/sealed.mjs";
import { COMMANDS, rulingResult } from "../lib/commands.mjs";
import { ARCHIVAL_RPC_URLS, PUBLISHED_ESCROW_CODE_HASH } from "../lib/config.mjs";
import { TESTNET_ARCHIVAL_RPCS } from "../../web/verify.js";
import { eciesDecrypt, secretsProfile } from "../lib/keystore.mjs";
import { loadAccountKey } from "../lib/near.mjs";
import { loadOrCreateK, saveClientKey } from "../lib/secrets-store.mjs";

const AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(AGENTS, "..");
const ESCROW = "escrow.judgenear.testnet";
const CLIENT = "alice.testnet";
const PROVIDER = "bob.testnet";
const CRITERIA = path.join(AGENTS, "examples", "criteria.json");
const DELIVERABLE = path.join(AGENTS, "examples", "deliverable.txt");
const FAKE_NEAR_KEY = "ed25519:FAKEtestKeyNotReal7Qm2Wx9Zk4Lp8Rv3Ty6Ub1Nc5Hd0Gj";
const ESCROW_CODE = PUBLISHED_ESCROW_CODE_HASH;
const JUDGE_HASH = fs.readFileSync(path.join(ROOT, "judge-wasm", "release", "judge.wasm.sha256"), "utf8").split(/\s+/)[0];
const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");

// Every temporary folder a test makes is removed when the file's tests end.
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A temporary HOME with a fake NEAR key for each test account. */
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jn-test-"));
  made.push(home);
  const dir = path.join(home, ".near-credentials", "testnet");
  fs.mkdirSync(dir, { recursive: true });
  for (const account of [CLIENT, PROVIDER]) {
    fs.writeFileSync(path.join(dir, `${account}.json`), JSON.stringify({ account_id: account, private_key: FAKE_NEAR_KEY }));
  }
  return home;
}

/** deps with a deterministic, recording rng: every 32-byte draw is a key (K, a client
 *  secret, an ECIES ephemeral secret), so the test knows each one and can look for it. */
function makeDeps({ home, near, fetch }) {
  const lines = [];
  const keys = [];
  let draws = 0;
  const rng = (size) => {
    const b = Buffer.alloc(size);
    for (let at = 0; at < size; at += 32) crypto.createHash("sha256").update(`jn test rng ${draws}:${at}`).digest().copy(b, at);
    draws += 1;
    if (size === 32) keys.push(Buffer.from(b));
    return b;
  };
  return { deps: { env: { JN_ESCROW: ESCROW }, home, out: (s) => lines.push(String(s)), rng, now: () => 1_762_000_000_000, sleep: async () => {}, fetch, near }, lines, keys };
}

/** No NEAR key and none of `keys`, in any common encoding or as a 16-hex prefix. */
function assertNoKeyMaterial(text, keys, label) {
  assert.ok(!text.includes("ed25519:"), `${label}: printed a NEAR key`);
  assert.ok(!text.includes(FAKE_NEAR_KEY.slice("ed25519:".length)), `${label}: printed the NEAR key body`);
  for (const k of keys) {
    const hex = k.toString("hex");
    for (const form of [hex, hex.toUpperCase(), hex.slice(0, 16), k.toString("base64"), k.toString("base64").replace(/=+$/, ""), k.toString("base64url")]) {
      assert.ok(!text.includes(form), `${label}: printed key material (${form.slice(0, 6)}...)`);
    }
  }
}

const offline = () => {
  throw new Error("this test runs offline");
};
const OFFLINE_NEAR = { codeHash: offline, view: offline, call: offline, txStatus: offline };

const DRY_RUNS = [
  ["create", { as: CLIENT, provider: PROVIDER, criteria: CRITERIA, "expires-in": "2h" }, ["create_job"]],
  ["create", { as: CLIENT, provider: PROVIDER, criteria: CRITERIA, "expires-in": "2h", sealed: true }, ["create_job", "client_pk"]],
  ["fund", { as: CLIENT, job: "0", amount: "1" }, ["\"fund\"", "1 NEAR"]],
  ["submit", { as: PROVIDER, job: "0", file: DELIVERABLE }, ["\"submit\""]],
  ["submit-sealed", { as: PROVIDER, job: "0", file: DELIVERABLE }, ["store_secrets", "submit_sealed", "/secrets/pubkey", JUDGE_HASH, secretsProfile(ESCROW, 0)]],
  ["ruling", { as: PROVIDER, job: "0" }, ["request_ruling", "300 Tgas", "get_judge.min_ruling_deposit"]],
  ["open", { as: CLIENT, job: "0" }, ["get_job"]],
  ["status", { job: "0" }, ["get_job"]],
  ["verify", { tx: "G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1", signer: PROVIDER }, ["G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1", "re-run", "https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org", "JN_ARCHIVAL_RPC"]],
];

for (const [command, opts, expected] of DRY_RUNS) {
  test(`--dry-run ${command}${opts.sealed ? " --sealed" : ""}: prints the call, no key material, no side effects`, async () => {
    const home = tempHome();
    const { deps, lines, keys } = makeDeps({ home, near: OFFLINE_NEAR, fetch: offline });
    await COMMANDS[command]({ ...opts, "dry-run": true }, deps);
    const text = lines.join("\n");
    for (const e of expected) assert.ok(text.includes(e), `${command}: expected ${e} in\n${text}`);
    assertNoKeyMaterial(text, keys, `dry-run ${command}`);
    assert.ok(!fs.existsSync(path.join(home, ".judge-near")), "a dry run must not write secrets");
  });
}

test("--dry-run submit-sealed shows dh of the file and a ciphertext under 21,884 characters, shortened", async () => {
  const { deps, lines } = makeDeps({ home: tempHome(), near: OFFLINE_NEAR, fetch: offline });
  await COMMANDS["submit-sealed"]({ as: PROVIDER, job: "5", file: DELIVERABLE, "dry-run": true }, deps);
  const submit = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.method === "submit_sealed");
  assert.equal(submit.args.dh, sha256hex(fs.readFileSync(DELIVERABLE)));
  assert.match(submit.args.deliverable_ct, /^.{48}\.\.\..{16} \(\d+ chars, sha256 [0-9a-f]{64}\)$/);
  assert.equal(submit.deposit, "0.25 NEAR (250000000000000000000000 yocto)");
});

test("a sealed job end to end on a fake chain: secrets stay in ~/.judge-near (0600) and never reach the output", async () => {
  const home = tempHome();
  const keystoreSecret = crypto.randomBytes(32); // the fake keystore's own key
  const keystorePub = publicFromSecret(keystoreSecret).toString("hex");
  const criteria = fs.readFileSync(CRITERIA, "utf8");
  const plaintext = fs.readFileSync(DELIVERABLE);
  const calls = [];
  let job = null;
  let final = null;
  const near = {
    async codeHash(accountId) {
      assert.equal(accountId, ESCROW);
      return ESCROW_CODE;
    },
    async view(contractId, method, args) {
      assert.equal(contractId, ESCROW);
      if (method === "get_judge") return { outlayer: "outlayer.testnet", url: "https://example.org/judge.wasm", hash: JUDGE_HASH, build_target: "wasm32-wasip1", min_ruling_deposit: "10000000000000000000000" };
      if (method === "get_secrets_profile") return secretsProfile(ESCROW, args.job_id);
      if (method === "get_job") return job;
      throw new Error(`unexpected view ${method}`);
    },
    async call(signer, c, opts = {}) {
      assert.equal(loadAccountKey(home, signer), FAKE_NEAR_KEY); // as near.mjs does, inside the seam
      calls.push({ signer, ...c, waitUntil: opts.waitUntil });
      const value = c.methodName === "create_job" ? Buffer.from("0").toString("base64") : "";
      return { txHash: `tx${calls.length}`, outcome: { status: { SuccessValue: value } } };
    },
    async txStatus() {
      return final;
    },
  };
  const fetch = async (url, init) => {
    assert.equal(url, "https://testnet-api.outlayer.ai/secrets/pubkey");
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { accessor: { type: "WasmHash", hash: JUDGE_HASH }, owner: PROVIDER, profile: secretsProfile(ESCROW, 0), secrets_json: "{}" });
    assert.match(init.headers["User-Agent"], /^judge-near-agents\//);
    return { ok: true, json: async () => ({ pubkey: keystorePub }) };
  };
  const runs = [];
  const run = async (command, opts) => {
    const r = makeDeps({ home, near, fetch });
    runs.push(r);
    await COMMANDS[command](opts, r.deps);
    return r.lines.join("\n");
  };

  // The client creates a sealed job: client_pk on chain, its secret in ~/.judge-near (0600).
  await run("create", { as: CLIENT, provider: PROVIDER, criteria: CRITERIA, "expires-in": "2h", sealed: true });
  const create = calls.at(-1);
  assert.equal(create.methodName, "create_job");
  assert.equal(create.args.criteria, criteria);
  assert.equal(create.args.expires_at_ns, String((1_762_000_000_000n + 7_200_000n) * 1_000_000n));
  const clientPk = create.args.client_pk;
  assert.match(clientPk, HEX64);
  const clientDir = path.join(home, ".judge-near", CLIENT);
  assert.equal(fs.statSync(clientDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(clientDir, `x25519-${clientPk}.json`)).mode & 0o777, 0o600);

  await run("fund", { as: CLIENT, job: "0", amount: "1" });
  assert.equal(calls.at(-1).depositYocto, "1000000000000000000000000");

  // The provider submits sealed: K saved first (0600), stored for the judge, then submit_sealed.
  job = { client: CLIENT, provider: PROVIDER, criteria, sealed: true, client_pk: clientPk, state: "Funded", dh: "", deliverable_ct: "", k: null };
  const submitOut = await run("submit-sealed", { as: PROVIDER, job: "0", file: DELIVERABLE });
  const [store, submit] = calls.slice(-2);
  assert.equal(store.contractId, "outlayer.testnet");
  assert.equal(store.methodName, "store_secrets");
  assert.equal(store.gasTgas, "50");
  assert.equal(store.depositYocto, "100000000000000000000000");
  assert.deepEqual(store.args.accessor, { WasmHash: { hash: JUDGE_HASH } });
  assert.equal(store.args.profile, secretsProfile(ESCROW, 0));
  assert.equal(store.args.vault_id, null);
  assert.deepEqual(store.args.access.Logic.conditions, [{ WasmHash: { hash: JUDGE_HASH } }, { Predecessor: { condition: { Whitelist: { accounts: [ESCROW] } } } }]);
  const K = Buffer.from(JSON.parse(eciesDecrypt(keystoreSecret, store.args.encrypted_secrets_base64)).JN_KEY, "hex");
  assert.equal(K.length, 32, "the keystore receives K under JN_KEY");
  const kFile = path.join(home, ".judge-near", PROVIDER, `K-${ESCROW}-0.json`);
  assert.equal(fs.statSync(kFile).mode & 0o777, 0o600);
  assert.equal(submit.methodName, "submit_sealed");
  assert.equal(submit.args.dh, sha256hex(plaintext));
  assert.deepEqual(decryptDeliverable(K, submit.args.deliverable_ct), plaintext, "C opens with the stored K");
  assert.match(submitOut, /new K for job 0 saved to ~\/\.judge-near\/bob\.testnet\/K-/);

  // A retry reuses the saved K, so the stored secret and a new C still agree.
  const retryOut = await run("submit-sealed", { as: PROVIDER, job: "0", file: DELIVERABLE });
  assert.match(retryOut, /reusing the K saved at/);
  const again = calls.at(-2);
  assert.ok(Buffer.from(JSON.parse(eciesDecrypt(keystoreSecret, again.args.encrypted_secrets_base64)).JN_KEY, "hex").equals(K));

  // The ruling: what the judge and escrow would emit on a pass.
  const ch = sha256hex(Buffer.from(criteria, "utf8"));
  const dh = sha256hex(plaintext);
  const k = sealK(K, clientPk, ch, dh);
  const verdict = { checks: [{ id: "length#0", ok: true }, { id: "contains#1", ok: true }], ch, dh, eh: "e".repeat(64), k, pass: true, score: 100, th: 100, v: 1 };
  final = {
    status: { SuccessValue: "" },
    receipts_outcome: [
      { outcome: { executor_id: "outlayer.testnet", logs: [], status: { SuccessValue: Buffer.from(JSON.stringify(verdict)).toString("base64") } } },
      { outcome: { executor_id: ESCROW, logs: [`EVENT_JSON:${JSON.stringify({ standard: "judge_near", version: "1.0.0", event: "ruling_applied", data: [{ job_id: 0, pass: true, score: 100, eh: verdict.eh, k }] })}`], status: { SuccessValue: "" } } },
    ],
  };
  const rulingOut = await run("ruling", { as: PROVIDER, job: "0" });
  const req = calls.at(-1);
  assert.equal(req.methodName, "request_ruling");
  assert.equal(req.depositYocto, "10000000000000000000000", "get_judge's min_ruling_deposit");
  assert.equal(req.gasTgas, "300");
  assert.equal(req.waitUntil, "INCLUDED_FINAL");
  assert.match(rulingOut, /verdict: \{.*"pass":true/);
  assert.match(rulingOut, /event ruling_applied: \{"job_id":0,"pass":true/);
  assert.match(rulingOut, new RegExp(`tx tx${calls.length}`));

  // The client opens k, recovers K, decrypts C and checks dh.
  job = { client: CLIENT, provider: PROVIDER, criteria, ch, sealed: true, client_pk: clientPk, deliverable: "", deliverable_ct: submit.args.deliverable_ct, dh, k, state: "Completed", amount: "1000000000000000000000000", attempt: "1", expires_at_ns: create.args.expires_at_ns };
  const outFile = path.join(home, "opened.txt");
  const openOut = await run("open", { as: CLIENT, job: "0", out: outFile });
  assert.deepEqual(fs.readFileSync(outFile), plaintext);
  assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);
  assert.match(openOut, /its sha256 matches dh/);
  await run("status", { job: "0" });

  // Not one line of any command carried key material.
  const allKeys = runs.flatMap((r) => r.keys).concat([K]);
  for (const r of runs) assertNoKeyMaterial(r.lines.join("\n"), allKeys, "live");
});

test("submit-sealed refuses an escrow whose secrets profile differs, before saving a K or sending anything", async () => {
  const home = tempHome();
  const calls = [];
  const near = {
    codeHash: async () => ESCROW_CODE,
    view: async (_c, method) => (method === "get_judge" ? { hash: JUDGE_HASH, min_ruling_deposit: "1" } : "jn-0000000000000000-0"),
    call: async (...a) => calls.push(a),
  };
  const { deps } = makeDeps({ home, near, fetch: offline });
  await assert.rejects(COMMANDS["submit-sealed"]({ as: PROVIDER, job: "0", file: DELIVERABLE }, deps), /names secrets profile jn-0000000000000000-0/);
  assert.equal(calls.length, 0);
  assert.ok(!fs.existsSync(path.join(home, ".judge-near")), "no K may be saved for a misconfigured escrow");
});

test("open refuses before a key is released, and for someone else's job", async () => {
  const home = tempHome();
  const base = { client: CLIENT, provider: PROVIDER, sealed: true, client_pk: publicFromSecret(crypto.randomBytes(32)).toString("hex"), deliverable_ct: "", dh: "d".repeat(64), k: null, state: "Submitted" };
  for (const [job, as, message] of [[base, CLIENT, /no key released/], [{ ...base, k: "x".repeat(124) }, "carol.testnet", /belongs to client alice\.testnet/]]) {
    const { deps } = makeDeps({ home, near: { view: async () => job }, fetch: offline });
    await assert.rejects(COMMANDS.open({ as, job: "0", out: path.join(home, "x.txt") }, deps), message);
  }
});

test("open refuses a deliverable that does not match dh and writes nothing", async () => {
  const home = tempHome();
  const clientSecret = crypto.randomBytes(32);
  const clientPk = publicFromSecret(clientSecret).toString("hex");
  saveClientKey(home, CLIENT, clientPk, clientSecret);
  const K = crypto.randomBytes(32);
  const plaintext = fs.readFileSync(DELIVERABLE);
  const ch = "a".repeat(64);
  const k = sealK(K, clientPk, ch, sha256hex(plaintext));
  const job = { client: CLIENT, sealed: true, client_pk: clientPk, deliverable_ct: encryptDeliverable(K, plaintext, crypto.randomBytes(12)), dh: sha256hex(Buffer.from("other bytes")), k, state: "Completed" };
  const outFile = path.join(home, "opened.txt");
  const { deps } = makeDeps({ home, near: { view: async () => job }, fetch: offline });
  await assert.rejects(COMMANDS.open({ as: CLIENT, job: "0", out: outFile }, deps), /does not match dh/);
  assert.ok(!fs.existsSync(outFile), "nothing is written when dh does not match");
});

test("the ruling result reader takes the verdict from receipts and the escrow's events only", () => {
  const verdict = { v: 1, pass: false, score: 50, eh: "f".repeat(64) };
  const { verdict: v, events } = rulingResult({
    receipts_outcome: [
      { outcome: { executor_id: "someone.testnet", logs: ['EVENT_JSON:{"standard":"judge_near","event":"spoof","data":[{}]}'], status: { SuccessValue: Buffer.from(JSON.stringify(verdict)).toString("base64") } } },
      { outcome: { executor_id: ESCROW, logs: ["not an event", 'EVENT_JSON:{"standard":"judge_near","version":"1.0.0","event":"refunded","data":[{"job_id":3}]}'], status: { SuccessValue: "" } } },
    ],
  }, ESCROW);
  assert.deepEqual(v, verdict);
  assert.deepEqual(events, [{ event: "refunded", data: { job_id: 3 } }], "events from other accounts are ignored");
});

test("loadAccountKey reads ~/.near-credentials/testnet and names no key in its errors", () => {
  const home = tempHome();
  assert.equal(loadAccountKey(home, CLIENT), FAKE_NEAR_KEY);
  assert.throws(() => loadAccountKey(home, "nobody.testnet"), (e) => /no NEAR key for nobody\.testnet/.test(e.message) && !e.message.includes("ed25519"));
  assert.throws(() => loadAccountKey(home, "../escape"), /not a NEAR account id/);
});

test("jn.mjs --dry-run runs every subcommand from the command line, offline, printing no key", () => {
  const home = tempHome();
  const cli = (args) => spawnSync(process.execPath, [path.join(AGENTS, "jn.mjs"), ...args, "--dry-run"], { env: { ...process.env, HOME: home, JN_ESCROW: ESCROW }, encoding: "utf8" });
  for (const [args, method] of [
    [["create", "--as", CLIENT, "--provider", PROVIDER, "--criteria", CRITERIA, "--expires-in", "2h", "--sealed"], "create_job"],
    [["fund", "--as", CLIENT, "--job", "0", "--amount", "1"], "\"fund\""],
    [["submit", "--as", PROVIDER, "--job", "0", "--file", DELIVERABLE], "\"submit\""],
    [["submit-sealed", "--as", PROVIDER, "--job", "0", "--file", DELIVERABLE], "submit_sealed"],
    [["ruling", "--as", PROVIDER, "--job", "0"], "request_ruling"],
    [["open", "--as", CLIENT, "--job", "0"], "get_job"],
    [["status", "--job", "0"], "get_job"],
    [["verify", "--tx", "G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1", "--signer", PROVIDER], "re-run"],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`);
    assert.ok(r.stdout.includes(method), `${args[0]}: ${r.stdout}`);
    assert.ok(!(r.stdout + r.stderr).includes("ed25519:"), `${args[0]} printed a NEAR key`);
  }
  assert.ok(!fs.existsSync(path.join(home, ".judge-near")), "a dry run must not write secrets");
  assert.equal(cli(["create", "--as", CLIENT]).status, 1, "missing flags fail cleanly");
});

/** A fake chain for the escrow checks: the account's code hash, get_judge, and a call recorder. */
function checkedNear({ code = ESCROW_CODE, judge = JUDGE_HASH, minDeposit = "10000000000000000000000" } = {}) {
  const calls = [];
  const near = {
    codeHash: async (accountId) => {
      assert.equal(accountId, ESCROW);
      return code;
    },
    view: async (_c, method, args) => {
      if (method === "get_judge") return { hash: judge, min_ruling_deposit: minDeposit };
      if (method === "get_secrets_profile") return secretsProfile(ESCROW, args.job_id);
      throw new Error(`unexpected view ${method}`);
    },
    call: async (_signer, c) => {
      calls.push(c);
      return { txHash: "tx1", outcome: { status: { SuccessValue: Buffer.from("0").toString("base64") } } };
    },
    txStatus: async () => ({ status: { SuccessValue: "" }, receipts_outcome: [] }),
  };
  return { near, calls };
}

const LIVE = [
  ["create", { as: CLIENT, provider: PROVIDER, criteria: CRITERIA, "expires-in": "2h", sealed: true }],
  ["fund", { as: CLIENT, job: "0", amount: "1" }],
  ["submit", { as: PROVIDER, job: "0", file: DELIVERABLE }],
  ["submit-sealed", { as: PROVIDER, job: "0", file: DELIVERABLE }],
  ["ruling", { as: PROVIDER, job: "0" }],
];

for (const [command, opts] of LIVE) {
  test(`live ${command} refuses an escrow that does not run the published escrow build, before saving or signing anything`, async () => {
    const home = tempHome();
    const { near, calls } = checkedNear({ code: "11111111111111111111111111111111" });
    const { deps } = makeDeps({ home, near, fetch: offline });
    await assert.rejects(COMMANDS[command](opts, deps), /runs code 11111111111111111111111111111111/);
    assert.equal(calls.length, 0, "nothing may be signed for an unknown escrow");
    assert.ok(!fs.existsSync(path.join(home, ".judge-near")), "no secret may be saved for an unknown escrow");
  });

  test(`live ${command} refuses an escrow that does not run the published judge, before saving or signing anything`, async () => {
    const home = tempHome();
    const { near, calls } = checkedNear({ judge: "0".repeat(64) });
    const { deps } = makeDeps({ home, near, fetch: offline });
    await assert.rejects(COMMANDS[command](opts, deps), /runs judge 0{64}/);
    assert.equal(calls.length, 0);
    assert.ok(!fs.existsSync(path.join(home, ".judge-near")));
  });
}

test("--escrow-code-hash and --judge-hash accept another build only when they name it exactly", async () => {
  const other = { code: "11111111111111111111111111111111", judge: "0".repeat(64) };
  const wrongFlag = checkedNear(other);
  const a = makeDeps({ home: tempHome(), near: wrongFlag.near, fetch: offline });
  await assert.rejects(COMMANDS.fund({ as: CLIENT, job: "0", amount: "1", "escrow-code-hash": "2".repeat(32), "judge-hash": other.judge }, a.deps), /runs code 1{32}/);
  assert.equal(wrongFlag.calls.length, 0);

  const named = checkedNear(other);
  const b = makeDeps({ home: tempHome(), near: named.near, fetch: offline });
  await COMMANDS.fund({ as: CLIENT, job: "0", amount: "1", "escrow-code-hash": other.code, "judge-hash": other.judge }, b.deps);
  assert.equal(named.calls.length, 1);
  assert.match(b.lines.join("\n"), /accepted by flag/);
});

test("live commands say which escrow and judge builds they checked", async () => {
  const { near, calls } = checkedNear();
  const { deps, lines } = makeDeps({ home: tempHome(), near, fetch: offline });
  await COMMANDS.fund({ as: CLIENT, job: "0", amount: "1" }, deps);
  assert.equal(calls.length, 1);
  assert.ok(lines.join("\n").includes(`code ${ESCROW_CODE}, judge ${JUDGE_HASH} (the published builds)`));
});

test("ruling refuses a min_ruling_deposit above the 0.1 NEAR cap and signs nothing", async () => {
  const { near, calls } = checkedNear({ minDeposit: "1000000000000000000000000" });
  const { deps } = makeDeps({ home: tempHome(), near, fetch: offline });
  await assert.rejects(COMMANDS.ruling({ as: PROVIDER, job: "0" }, deps), /above the 0\.1 NEAR cap/);
  assert.equal(calls.length, 0);
});

test("the escrow code hash the agents expect is the one contract/BUILD.md publishes", () => {
  const build = fs.readFileSync(path.join(ROOT, "contract", "BUILD.md"), "utf8");
  const m = /SHA-256 base58 \(NEAR code_hash form\): `([1-9A-HJ-NP-Za-km-z]{43,44})`/.exec(build);
  assert.ok(m, "contract/BUILD.md names the base58 code hash");
  assert.equal(PUBLISHED_ESCROW_CODE_HASH, m[1]);
});

// ---- submit-sealed reads the job first; after key_missing it stores the saved K again ----

/** A fake chain for submit-sealed: the published builds, the given job, a fake keystore, a call recorder. */
function sealedChain(job) {
  const keystoreSecret = crypto.randomBytes(32);
  const calls = [];
  const near = {
    codeHash: async () => ESCROW_CODE,
    view: async (_c, method, args) => {
      if (method === "get_judge") return { hash: JUDGE_HASH, min_ruling_deposit: "10000000000000000000000" };
      if (method === "get_secrets_profile") return secretsProfile(ESCROW, args.job_id);
      if (method === "get_job") return job;
      throw new Error(`unexpected view ${method}`);
    },
    call: async (_signer, c) => {
      calls.push(c);
      return { txHash: `tx${calls.length}`, outcome: { status: { SuccessValue: "" } } };
    },
  };
  const fetch = async () => ({ ok: true, json: async () => ({ pubkey: publicFromSecret(keystoreSecret).toString("hex") }) });
  return { near, calls, fetch, keystoreSecret };
}
const sealedJob = (over = {}) => ({ client: CLIENT, provider: PROVIDER, sealed: true, client_pk: "c".repeat(64), state: "Funded", dh: "", deliverable_ct: "", k: null, ...over });
const keyIn = (chain, call) => Buffer.from(JSON.parse(eciesDecrypt(chain.keystoreSecret, call.args.encrypted_secrets_base64)).JN_KEY, "hex");

test("submit-sealed reads the job first and refuses one it cannot submit to, before saving a K or sending anything", async () => {
  for (const [job, message] of [
    [null, /no job 0 on escrow\.judgenear\.testnet/],
    [sealedJob({ sealed: false, client_pk: null }), /job 0 is not sealed: use submit/],
    [sealedJob({ provider: "carol.testnet" }), /job 0 belongs to provider carol\.testnet, not bob\.testnet/],
    [sealedJob({ state: "Completed" }), /job 0 is Completed; submit-sealed needs a Funded job/],
    [sealedJob({ state: "Ruling" }), /job 0 is Ruling; submit-sealed needs a Funded job/],
  ]) {
    const home = tempHome();
    const chain = sealedChain(job);
    const { deps } = makeDeps({ home, near: chain.near, fetch: chain.fetch });
    await assert.rejects(COMMANDS["submit-sealed"]({ as: PROVIDER, job: "0", file: DELIVERABLE }, deps), message);
    assert.equal(chain.calls.length, 0, `nothing may be sent (${message})`);
    assert.ok(!fs.existsSync(path.join(home, ".judge-near")), `no K may be saved (${message})`);
  }
});

test("after key_missing, submit-sealed stores the saved K again and sends nothing else", async () => {
  const home = tempHome();
  const job = sealedJob();
  const chain = sealedChain(job);
  const first = makeDeps({ home, near: chain.near, fetch: chain.fetch });
  await COMMANDS["submit-sealed"]({ as: PROVIDER, job: "0", file: DELIVERABLE }, first.deps);
  assert.deepEqual(chain.calls.map((c) => c.methodName), ["store_secrets", "submit_sealed"]);
  const K = keyIn(chain, chain.calls[0]);

  // The escrow took the delivery; the judge then found no key and the job went back to Submitted.
  Object.assign(job, { state: "Submitted", dh: sha256hex(fs.readFileSync(DELIVERABLE)), deliverable_ct: chain.calls[1].args.deliverable_ct });
  const again = makeDeps({ home, near: chain.near, fetch: chain.fetch });
  await COMMANDS["submit-sealed"]({ as: PROVIDER, job: "0", file: DELIVERABLE }, again.deps);
  assert.deepEqual(chain.calls.map((c) => c.methodName), ["store_secrets", "submit_sealed", "store_secrets"], "only the key is stored again");
  const restore = chain.calls[2];
  assert.equal(restore.contractId, "outlayer.testnet");
  assert.equal(restore.args.profile, secretsProfile(ESCROW, 0));
  assert.deepEqual(restore.args.access, chain.calls[0].args.access, "the same keystore rule");
  assert.ok(keyIn(chain, restore).equals(K), "the same K that sealed the delivery on chain");
  assert.deepEqual(decryptDeliverable(K, job.deliverable_ct), fs.readFileSync(DELIVERABLE));
  const text = again.lines.join("\n");
  assert.match(text, /job 0 is already submitted with this deliverable/);
  assert.match(text, /node jn\.mjs ruling --as bob\.testnet --job 0/);
  assertNoKeyMaterial(text, [K, ...again.keys, ...first.keys], "restore");
});

test("submit-sealed on a Submitted job refuses another deliverable, or a job whose K is not saved here, and sends nothing", async () => {
  const submittedDh = sha256hex(fs.readFileSync(DELIVERABLE));
  {
    const home = tempHome();
    loadOrCreateK(home, PROVIDER, ESCROW, 0, () => crypto.randomBytes(32));
    const chain = sealedChain(sealedJob({ state: "Submitted", dh: submittedDh }));
    const { deps } = makeDeps({ home, near: chain.near, fetch: chain.fetch });
    await assert.rejects(COMMANDS["submit-sealed"]({ as: PROVIDER, job: "0", file: path.join(AGENTS, "examples", "deliverable-fail.txt") }, deps), /job 0 was submitted with another deliverable/);
    assert.equal(chain.calls.length, 0);
  }
  {
    const home = tempHome();
    const chain = sealedChain(sealedJob({ state: "Submitted", dh: submittedDh }));
    const { deps } = makeDeps({ home, near: chain.near, fetch: chain.fetch });
    await assert.rejects(COMMANDS["submit-sealed"]({ as: PROVIDER, job: "0", file: DELIVERABLE }, deps), /no K for job 0 is saved/);
    assert.equal(chain.calls.length, 0);
    assert.ok(!fs.existsSync(path.join(home, ".judge-near")), "a new K could not open the delivery on chain, so none is made (looking writes nothing)");
  }
});

// ---- verify: the browser verifier's checks, from the command line ----

const TX = "G5zVDozZmDykpyQmpDKYzjjVvWgjdGWFRFv8c1s5uXG1";
const OK_STEPS = [
  { id: "published", ok: true, label: "That hash is a published Judge on NEAR build", detail: "judge v2 (public and sealed jobs), commit fd3dcc6" },
  { id: "match", ok: true, label: "The local verdict equals the on-chain verdict, field by field", detail: "pass: true, score: 100" },
];

/** A fake verifier (web/verify.js's seam): records what verifyRuling receives. */
function fakeVerifier(ruling, report = { ok: true, steps: OK_STEPS, local: { pass: true, score: 100 } }) {
  const seen = { fetch: [], verify: [] };
  const verifier = {
    fetchTransaction: async (txHash, signer, o) => {
      seen.fetch.push({ txHash, signer, rpc: o.rpc });
      return { transaction: { receiver_id: ESCROW } };
    },
    findRuling: () => ruling,
    rulingJob: () => ({ escrow: ESCROW, jobId: 0 }),
    verifyRuling: async (_r, o) => {
      seen.verify.push({ env: o.env, signer: o.signer, rpc: o.rpc });
      return report;
    },
  };
  return { verifier, seen };
}
const publicRuling = { secretsRef: null, verdict: { v: 1, pass: true, score: 100 } };
const sealedRulingOf = (verdict = { v: 1, pass: true, score: 100 }) => ({ secretsRef: { profile: secretsProfile(ESCROW, 0), account_id: PROVIDER }, verdict });

test("verify a public ruling: prints each check and the result, loads no key even with --as", async () => {
  const home = tempHome();
  const { verifier, seen } = fakeVerifier(publicRuling);
  const { deps, lines } = makeDeps({ home, near: OFFLINE_NEAR, fetch: offline });
  deps.verifier = verifier;
  deps.env.JN_ARCHIVAL_RPC = "https://archive.example.test";
  await COMMANDS.verify({ tx: TX, signer: PROVIDER, as: CLIENT }, deps);
  assert.deepEqual(seen.fetch, [{ txHash: TX, signer: PROVIDER, rpc: "https://archive.example.test" }]);
  assert.deepEqual(seen.verify[0].env, {}, "a public ruling never gets a key");
  const text = lines.join("\n");
  assert.match(text, /ok {3}That hash is a published Judge on NEAR build \| judge v2/);
  assert.match(text, /Verified: judge v2 \(public and sealed jobs\), commit fd3dcc6 computes exactly this ruling \(pass: true, score: 100\)\./);
  assert.ok(!fs.existsSync(path.join(home, ".judge-near")), "no secret is touched");
});

test("verify --as CLIENT opens k in memory and hands K only to the verifier", async () => {
  const home = tempHome();
  const clientSecret = crypto.randomBytes(32);
  const clientPk = publicFromSecret(clientSecret).toString("hex");
  saveClientKey(home, CLIENT, clientPk, clientSecret);
  const K = crypto.randomBytes(32);
  const k = sealK(K, clientPk, "a".repeat(64), "b".repeat(64));
  const near = { view: async (c, method, args) => {
    assert.deepEqual([c, method, args], [ESCROW, "get_job", { job_id: 0 }]);
    return { client: CLIENT, provider: PROVIDER, sealed: true, client_pk: clientPk, k, state: "Completed" };
  } };
  const { verifier, seen } = fakeVerifier(sealedRulingOf());
  const { deps, lines } = makeDeps({ home, near, fetch: offline });
  deps.verifier = verifier;
  await COMMANDS.verify({ tx: TX, signer: PROVIDER, as: CLIENT }, deps);
  assert.deepEqual(seen.verify[0].env, { JN_KEY: K.toString("hex") });
  assertNoKeyMaterial(lines.join("\n"), [K, clientSecret], "verify --as client");
});

test("verify --as PROVIDER uses the K saved for that job", async () => {
  const home = tempHome();
  const K = crypto.randomBytes(32);
  loadOrCreateK(home, PROVIDER, ESCROW, 0, () => K);
  const near = { view: async () => ({ client: CLIENT, provider: PROVIDER, sealed: true, client_pk: "c".repeat(64), k: null, state: "Refunded" }) };
  const { verifier, seen } = fakeVerifier(sealedRulingOf({ v: 1, pass: false, score: 50 }), { ok: true, steps: OK_STEPS, local: { pass: false, score: 50 } });
  const { deps, lines } = makeDeps({ home, near, fetch: offline });
  deps.verifier = verifier;
  await COMMANDS.verify({ tx: TX, signer: CLIENT, as: PROVIDER }, deps);
  assert.deepEqual(seen.verify[0].env, { JN_KEY: K.toString("hex") });
  assertNoKeyMaterial(lines.join("\n"), [K], "verify --as provider");
});

test("verify refuses --as someone else, a client before k is released, or a provider with no saved K, and runs nothing", async () => {
  const base = { client: CLIENT, provider: PROVIDER, sealed: true, client_pk: "c".repeat(64), k: null, state: "Submitted" };
  for (const [as, message] of [
    ["carol.testnet", /--as must be the job's client alice\.testnet or provider bob\.testnet/],
    [CLIENT, /no key released for job 0 yet \(state Submitted\)/],
    [PROVIDER, /no K for job 0 of escrow\.judgenear\.testnet is saved/],
  ]) {
    const home = tempHome();
    const { verifier, seen } = fakeVerifier(sealedRulingOf());
    const { deps } = makeDeps({ home, near: { view: async () => base }, fetch: offline });
    deps.verifier = verifier;
    await assert.rejects(COMMANDS.verify({ tx: TX, signer: PROVIDER, as }, deps), message);
    assert.equal(seen.verify.length, 0, `${as}: the verifier must not run`);
  }
});

test("verify a key_missing ruling loads no key: the judge ran without one", async () => {
  const home = tempHome();
  const { verifier, seen } = fakeVerifier(sealedRulingOf({ v: 1, pass: false, score: 0, err: "key_missing" }), { ok: true, steps: OK_STEPS, local: { pass: false, score: 0 } });
  const { deps } = makeDeps({ home, near: { view: offline }, fetch: offline });
  deps.verifier = verifier;
  await COMMANDS.verify({ tx: TX, signer: PROVIDER, as: CLIENT }, deps);
  assert.deepEqual(seen.verify[0].env, {});
  assert.ok(!fs.existsSync(path.join(home, ".judge-near")));
});

test("verify fails when a check fails, and prints that check as FAIL", async () => {
  const failed = { ok: false, steps: [OK_STEPS[0], { id: "match", ok: false, label: "The local verdict equals the on-chain verdict, field by field", detail: "on chain: {}" }] };
  const { verifier } = fakeVerifier(publicRuling, failed);
  const { deps, lines } = makeDeps({ home: tempHome(), near: OFFLINE_NEAR, fetch: offline });
  deps.verifier = verifier;
  await assert.rejects(COMMANDS.verify({ tx: TX, signer: PROVIDER }, deps), /not verified: see the check marked FAIL above/);
  const text = lines.join("\n");
  assert.match(text, /^ok {3}That hash is a published Judge on NEAR build/m);
  assert.match(text, /^FAIL The local verdict equals the on-chain verdict, field by field/m);
  assert.doesNotMatch(text, /Verified:/);
});

test("verify a sealed ruling without --as: the checks that need no key print ok, the re-run prints skip, never FAIL, and it says how to give the key", async () => {
  const needsKey = {
    ok: false,
    needsKey: true,
    steps: [
      { id: "ch", ok: true, label: "The verdict's ch is the SHA-256 of the job's criteria", detail: "4dad61a8" },
      { id: "key", ok: null, label: "Not re-run: the score needs the delivery key, which only the worker and, after a pass, the client hold", detail: "" },
    ],
  };
  const { verifier } = fakeVerifier(sealedRulingOf(), needsKey);
  const { deps, lines } = makeDeps({ home: tempHome(), near: OFFLINE_NEAR, fetch: offline });
  deps.verifier = verifier;
  await assert.rejects(COMMANDS.verify({ tx: TX, signer: PROVIDER }, deps), /not re-run: the deliverable key is needed/);
  const text = lines.join("\n");
  assert.match(text, /^ok {3}The verdict's ch is the SHA-256 of the job's criteria \| 4dad61a8$/m);
  assert.match(text, /^skip Not re-run: the score needs the delivery key/m);
  assert.doesNotMatch(text, /FAIL|Verified:/);
  assert.match(text, /add --as <client> \(after the key is released\) or --as <provider>/);
});

test("verify refuses a malformed transaction hash and a transaction with no OutLayer run", async () => {
  const { deps } = makeDeps({ home: tempHome(), near: OFFLINE_NEAR, fetch: offline });
  await assert.rejects(COMMANDS.verify({ tx: "not-a-hash", signer: PROVIDER }, deps), /--tx needs a transaction hash/);
  deps.verifier = fakeVerifier(null).verifier;
  await assert.rejects(COMMANDS.verify({ tx: TX, signer: PROVIDER }, deps), /did not ask OutLayer to run anything/);
});

// ---- verify reads old transactions from archival nodes ----
// Regular testnet nodes drop transactions after about 30 hours; live commands keep JN_RPC.

const ARCHIVAL = ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];

test("verify reads the chain from the archival nodes by default, the same list the browser verifier uses, and ignores JN_RPC", async () => {
  assert.deepEqual([...ARCHIVAL_RPC_URLS], ARCHIVAL);
  assert.deepEqual([...ARCHIVAL_RPC_URLS], [...TESTNET_ARCHIVAL_RPCS], "agents/lib/config.mjs and web/verify.js list the same hosts");
  const { verifier, seen } = fakeVerifier(publicRuling);
  const { deps } = makeDeps({ home: tempHome(), near: OFFLINE_NEAR, fetch: offline });
  deps.verifier = verifier;
  deps.env.JN_RPC = "https://rpc.example.test"; // for live commands; verify must not use it
  await COMMANDS.verify({ tx: TX, signer: PROVIDER }, deps);
  assert.deepEqual([...seen.fetch[0].rpc], ARCHIVAL);
  assert.deepEqual([...seen.verify[0].rpc], ARCHIVAL);
});

test("verify uses JN_ARCHIVAL_RPC when set, for the transaction and for the escrow job, never JN_RPC", async () => {
  const { verifier, seen } = fakeVerifier(publicRuling);
  const { deps } = makeDeps({ home: tempHome(), near: OFFLINE_NEAR, fetch: offline });
  deps.verifier = verifier;
  deps.env.JN_RPC = "https://rpc.example.test";
  deps.env.JN_ARCHIVAL_RPC = "https://archive.example.test";
  await COMMANDS.verify({ tx: TX, signer: PROVIDER }, deps);
  assert.equal(seen.fetch[0].rpc, "https://archive.example.test");
  assert.equal(seen.verify[0].rpc, "https://archive.example.test");
});

test("verify --dry-run names the archival hosts, or JN_ARCHIVAL_RPC when it is set", async () => {
  const { deps, lines } = makeDeps({ home: tempHome(), near: OFFLINE_NEAR, fetch: offline });
  deps.env.JN_RPC = "https://rpc.example.test";
  await COMMANDS.verify({ tx: TX, signer: PROVIDER, "dry-run": true }, deps);
  const shown = JSON.parse(lines.join("\n")).verify;
  assert.deepEqual(shown.archival_rpc, ARCHIVAL);
  assert.ok(!lines.join("\n").includes("rpc.example.test"), "verify never reads JN_RPC");
  const set = makeDeps({ home: tempHome(), near: OFFLINE_NEAR, fetch: offline });
  set.deps.env.JN_ARCHIVAL_RPC = "https://archive.example.test";
  await COMMANDS.verify({ tx: TX, signer: PROVIDER, "dry-run": true }, set.deps);
  assert.deepEqual(JSON.parse(set.lines.join("\n")).verify.archival_rpc, ["https://archive.example.test"]);
});

test("jn.mjs --help says where verify reads from and how to change it", () => {
  const r = spawnSync(process.execPath, [path.join(AGENTS, "jn.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /archival/);
  assert.match(r.stdout, /JN_ARCHIVAL_RPC/);
  assert.match(r.stdout, /JN_RPC/);
});

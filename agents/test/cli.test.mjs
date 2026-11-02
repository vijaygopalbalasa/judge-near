// The agent commands: what they send, where secrets go, and that no key material is ever
// printed. Runs offline: a fake chain and a fake keystore stand in for the network, and
// HOME is a fresh temporary directory holding a FAKE NEAR key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptDeliverable, encryptDeliverable, publicFromSecret, sealK } from "../../judge-wasm/scripts/sealed.mjs";
import { COMMANDS, rulingResult } from "../lib/commands.mjs";
import { eciesDecrypt, secretsProfile } from "../lib/keystore.mjs";
import { loadAccountKey } from "../lib/near.mjs";
import { saveClientKey } from "../lib/secrets-store.mjs";

const AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(AGENTS, "..");
const ESCROW = "escrow.judgenear.testnet";
const CLIENT = "alice.testnet";
const PROVIDER = "bob.testnet";
const CRITERIA = path.join(AGENTS, "examples", "criteria.json");
const DELIVERABLE = path.join(AGENTS, "examples", "deliverable.txt");
const FAKE_NEAR_KEY = "ed25519:FAKEtestKeyNotReal7Qm2Wx9Zk4Lp8Rv3Ty6Ub1Nc5Hd0Gj";
const JUDGE_HASH = fs.readFileSync(path.join(ROOT, "judge-wasm", "release", "judge.wasm.sha256"), "utf8").split(/\s+/)[0];
const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** A temporary HOME with a fake NEAR key for each test account. */
function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jn-test-"));
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
const OFFLINE_NEAR = { view: offline, call: offline, txStatus: offline };

const DRY_RUNS = [
  ["create", { as: CLIENT, provider: PROVIDER, criteria: CRITERIA, "expires-in": "2h" }, ["create_job"]],
  ["create", { as: CLIENT, provider: PROVIDER, criteria: CRITERIA, "expires-in": "2h", sealed: true }, ["create_job", "client_pk"]],
  ["fund", { as: CLIENT, job: "0", amount: "1" }, ["\"fund\"", "1 NEAR"]],
  ["submit", { as: PROVIDER, job: "0", file: DELIVERABLE }, ["\"submit\""]],
  ["submit-sealed", { as: PROVIDER, job: "0", file: DELIVERABLE }, ["store_secrets", "submit_sealed", "/secrets/pubkey", JUDGE_HASH, secretsProfile(ESCROW, 0)]],
  ["ruling", { as: PROVIDER, job: "0" }, ["request_ruling", "300 Tgas", "get_judge.min_ruling_deposit"]],
  ["open", { as: CLIENT, job: "0" }, ["get_job"]],
  ["status", { job: "0" }, ["get_job"]],
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
  ]) {
    const r = cli(args);
    assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`);
    assert.ok(r.stdout.includes(method), `${args[0]}: ${r.stdout}`);
    assert.ok(!(r.stdout + r.stderr).includes("ed25519:"), `${args[0]} printed a NEAR key`);
  }
  assert.ok(!fs.existsSync(path.join(home, ".judge-near")), "a dry run must not write secrets");
  assert.equal(cli(["create", "--as", CLIENT]).status, 1, "missing flags fail cleanly");
});

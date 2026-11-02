// Run from the repository root: node --test web/test/*.test.mjs   (no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESCROW, JOB_NOTES, PUBLISHED_ESCROW_CODE_HASH, RULINGS, TESTNET_STATE_RPCS, TESTNET_TX_INDEX, discoverRulings, disclosedDelivery, formatNear, formatTime, jobOutcome, mergeRulings, parseDeepLink, readEscrow, rulingFromIndexed } from "../escrow.js";
import { TESTNET_ARCHIVAL_RPCS } from "../verify.js";
import * as agentsConfig from "../../agents/lib/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(path.join(root, "README.md"), "utf8");

test("the ruling list is the README's escrow table, row for row, with the signers the README names", () => {
  const section = readme.split("### The escrow on testnet")[1].split("\n## ")[0];
  const rows = section.split("\n").filter((line) => /^\| \d/.test(line));
  const fromReadme = rows.map((row) => {
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    // Each ruling links to the hosted page, which re-runs it: web/?tx=<hash>&signer=<account>.
    const m = /\(https:\/\/vijaygopalbalasa\.github\.io\/judge-near\/web\/\?tx=([1-9A-HJ-NP-Za-km-z]{43,44})&signer=([a-z0-9._-]+)\)/.exec(cells.at(-1));
    assert.ok(m, `the ruling cell links to the page: ${cells.at(-1)}`);
    return { job: Number.parseInt(cells[0], 10), tx: m[1], signer: m[2] };
  });
  assert.equal(fromReadme.length, 10);
  assert.deepEqual(RULINGS.map(({ job, tx, signer }) => ({ job, tx, signer })), fromReadme);
  assert.ok(!/nearblocks\.io\/txns/.test(readme), "no links to the testnet explorer, which stopped indexing on Sep 27 2026");
  const prose = section.replace(/\s+/g, " ");
  assert.ok(prose.includes("Signers: jobs 1 and 3 were signed by `judgenear-client.testnet`, the others by `judgenear-worker.testnet`."));
  for (const r of RULINGS) assert.equal(r.signer, [1, 3].includes(r.job) ? "judgenear-client.testnet" : "judgenear-worker.testnet", r.tx);
  assert.ok(prose.includes(`\`${ESCROW}\` was deployed`));
});

test("the page's published escrow build is the agents' and contract/BUILD.md's", () => {
  assert.equal(PUBLISHED_ESCROW_CODE_HASH, agentsConfig.PUBLISHED_ESCROW_CODE_HASH);
  assert.ok(readFileSync(path.join(root, "contract/BUILD.md"), "utf8").includes(`SHA-256 base58 (NEAR code_hash form): \`${PUBLISHED_ESCROW_CODE_HASH}\``));
});

test("current state is read from FastNEAR's regular node first (0.2 to 0.5 s a call), then NEAR's, then the archival nodes", () => {
  assert.deepEqual([...TESTNET_STATE_RPCS], ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org", ...TESTNET_ARCHIVAL_RPCS]);
});

// ---- reading the escrow: a fake chain that answers view_account, get_judge and list_jobs ----

const JUDGE = {
  outlayer: "outlayer.testnet",
  url: "https://raw.githubusercontent.com/vijaygopalbalasa/judge-near/fd3dcc65a9f616a6c7e9dc411a65de50560e2ed6/judge-wasm/release/judge.wasm",
  hash: "911b8a351d199d003735ceef138647ec8485de8eff197aa909f5db496b92c958",
  build_target: "wasm32-wasip1",
  min_ruling_deposit: "10000000000000000000000",
};
const bytesOf = (value) => [...new TextEncoder().encode(JSON.stringify(value))];
const jobView = (n, extra = {}) => ({
  client: "client.testnet", provider: "worker.testnet", criteria: "{}", ch: "a".repeat(64), deliverable: `delivery ${n}`, dh: "b".repeat(64),
  sealed: false, client_pk: null, deliverable_ct: "", k: null, amount: "500000000000000000000000", state: "Completed",
  expires_at_ns: "1", attempt: "1", created_at_ns: "1", ...extra,
});

/** `fail` maps a host to a response maker that fails; every other host answers from the fake chain. */
const FULL = { public_key: "ed25519:Full", access_key: { nonce: 1, permission: "FullAccess" } };
const LIMITED = { public_key: "ed25519:Fn", access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: "x.testnet", method_names: [] } } } };

function fakeChain({ codeHash = PUBLISHED_ESCROW_CODE_HASH, jobs = [], fail = {}, contractError, accessKeys = [] } = {}) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    asked.push({ url, method, request: params.request_type, fn: params.method_name, account: params.account_id, args: params.args_base64 ? JSON.parse(atob(params.args_base64)) : undefined });
    if (fail[url]) return fail[url]();
    let result;
    if (params.request_type === "view_account") result = { code_hash: codeHash, amount: "1", block_height: 275900123 };
    else if (params.request_type === "view_access_key_list") result = { keys: accessKeys };
    else if (contractError) result = { error: contractError, logs: [] };
    else if (params.method_name === "get_judge") result = { result: bytesOf(JUDGE), logs: [] };
    else if (params.method_name === "list_jobs") {
      const { from_index: from, limit } = JSON.parse(atob(params.args_base64));
      result = { result: bytesOf(jobs.slice(from, from + limit)), logs: [] };
    } else throw new Error(`unexpected call ${params.method_name}`);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "x", result }) };
  };
  return { fetchImpl, asked };
}

test("readEscrow reads the code hash, the judge and every job, numbering each job by its place in list_jobs", async () => {
  const jobs = Array.from({ length: 23 }, (_, n) => jobView(n));
  const { fetchImpl, asked } = fakeChain({ jobs });
  const got = await readEscrow(ESCROW, { fetchImpl });
  assert.equal(got.escrow, ESCROW);
  assert.equal(got.codeHash, PUBLISHED_ESCROW_CODE_HASH);
  assert.equal(got.publishedBuild, true);
  assert.equal(got.blockHeight, 275900123);
  assert.deepEqual(got.judge, JUDGE);
  assert.deepEqual(got.jobs.map((j) => j.id), [...Array(23).keys()]);
  assert.deepEqual(got.jobs.map((j) => j.deliverable), jobs.map((j) => j.deliverable));
  assert.deepEqual(asked.filter((a) => a.fn === "list_jobs").map((a) => a.args), [
    { from_index: 0, limit: 10 }, { from_index: 10, limit: 10 }, { from_index: 20, limit: 10 },
  ]);
  assert.ok(asked.every((a) => a.url === TESTNET_STATE_RPCS[0] && a.account === ESCROW && a.method === "query"));
});

test("readEscrow stops after an empty page, and flags an escrow that does not run the published build", async () => {
  const { fetchImpl, asked } = fakeChain({ codeHash: "11111111111111111111111111111111", jobs: Array.from({ length: 10 }, (_, n) => jobView(n)) });
  const got = await readEscrow(ESCROW, { fetchImpl });
  assert.equal(got.publishedBuild, false);
  assert.equal(got.jobs.length, 10);
  assert.deepEqual(asked.filter((a) => a.fn === "list_jobs").map((a) => a.args.from_index), [0, 10]);
});

test("readEscrow moves to the next node when one fails, and reports a contract error by method", async () => {
  const down = { [TESTNET_STATE_RPCS[0]]: () => ({ ok: false, status: 429, json: async () => ({}) }) };
  const { fetchImpl, asked } = fakeChain({ jobs: [jobView(0)], fail: down });
  const got = await readEscrow(ESCROW, { fetchImpl });
  assert.equal(got.jobs.length, 1);
  assert.deepEqual([...new Set(asked.map((a) => a.url))], TESTNET_STATE_RPCS.slice(0, 2));
  const broken = fakeChain({ contractError: "wasm execution failed with error: MethodNotFound" });
  await assert.rejects(readEscrow(ESCROW, { fetchImpl: broken.fetchImpl }), /get_judge on judgenear-escrow\.testnet failed: wasm execution failed/);
});

test("formatNear shows yoctoNEAR exactly, without floating point", () => {
  assert.equal(formatNear("500000000000000000000000"), "0.5 NEAR");
  assert.equal(formatNear("1000000000000000000000000"), "1 NEAR");
  assert.equal(formatNear("12345000000000000000000000"), "12.345 NEAR");
  assert.equal(formatNear("10000000000000000000000"), "0.01 NEAR");
  assert.equal(formatNear("1"), "0.000000000000000000000001 NEAR");
  assert.equal(formatNear("0"), "0 NEAR");
  for (const bad of ["-1", "1.5", "", "0x10", 5]) assert.throws(() => formatNear(bad), /yoctoNEAR/, String(bad));
});

test("jobOutcome says in one line what happened to a job, and whether a sealed key went to the client", () => {
  const pub = (state) => jobView(0, { state });
  const sealed = (state, k = null) => jobView(0, { state, sealed: true, client_pk: "c".repeat(64), deliverable: "", deliverable_ct: "AAAA", k });
  assert.equal(jobOutcome(pub("Completed")), "Passed: the escrow paid the worker.");
  assert.equal(jobOutcome(sealed("Completed", "k".repeat(124))), "Passed: the escrow paid the worker and released the key to the client in the same step.");
  assert.equal(jobOutcome(sealed("Completed")), "Passed: the escrow paid the worker.");
  assert.equal(jobOutcome(pub("Refunded")), "Refunded to the client.");
  assert.equal(jobOutcome(sealed("Refunded")), "Refunded to the client; the key was never released, so the delivery stays sealed.");
  assert.equal(jobOutcome(pub("Open")), "Created; waiting for the client to fund it.");
  assert.equal(jobOutcome(pub("Funded")), "Funded; waiting for the delivery.");
  assert.equal(jobOutcome(pub("Submitted")), "Delivered; waiting for a ruling.");
  assert.equal(jobOutcome(pub("Ruling")), "OutLayer is running the judge.");
  assert.equal(jobOutcome(pub("Lost")), "Unknown state: Lost");
});

test("readEscrow counts the escrow's full-access keys: none means nobody can replace its code", async () => {
  const locked = await readEscrow(ESCROW, { fetchImpl: fakeChain({ accessKeys: [] }).fetchImpl });
  assert.equal(locked.fullAccessKeys, 0);
  const open = await readEscrow(ESCROW, { fetchImpl: fakeChain({ accessKeys: [FULL, LIMITED] }).fetchImpl });
  assert.equal(open.fullAccessKeys, 1, "a function-call key cannot deploy code; only full-access keys count");
});

test("readEscrow asks for the code hash, the keys, the judge and the first page of jobs at once, not one after another", async () => {
  const chain = fakeChain({ jobs: [jobView(0)] });
  const started = [];
  const release = [];
  const fetchImpl = (url, init) => {
    started.push(JSON.parse(init.body).params);
    return new Promise((resolve) => release.push(() => resolve(chain.fetchImpl(url, init))));
  };
  const reading = readEscrow(ESCROW, { fetchImpl });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started.map((p) => p.method_name ?? p.request_type).sort(), ["get_judge", "list_jobs", "view_access_key_list", "view_account"]);
  while (release.length) release.shift()();
  const got = await reading;
  assert.equal(got.jobs.length, 1);
});

test("parseDeepLink reads ?tx=&signer= for the verifier, and refuses anything that is not a hash and an account id", () => {
  const tx = "5E4FiCfc1CQ7ywUeEDZ9jVMpkronjaCH4oNWWqM8hN71";
  assert.deepEqual(parseDeepLink(`?tx=${tx}&signer=judgenear-worker.testnet`), { tx, signer: "judgenear-worker.testnet" });
  for (const bad of ["", "?tx=abc&signer=judgenear-worker.testnet", `?tx=${tx}`, `?tx=${tx}&signer=Not An Account`, `?tx=${tx}0OIl&signer=a.testnet`, `?signer=a.testnet`]) {
    assert.equal(parseDeepLink(bad), null, bad);
  }
});

test("formatTime shows a job's nanosecond timestamp as a UTC minute", () => {
  assert.equal(formatTime("1793641487945000000"), "2026-11-02 17:44 UTC");
  assert.equal(formatTime("0"), "1970-01-01 00:00 UTC");
  assert.equal(formatTime("not a time"), "");
});

test("every sealed demo job on the page says how secret its delivery is, as the README does", () => {
  assert.deepEqual(Object.keys(JOB_NOTES).map(Number), [2, 3, 4, 5, 6, 7, 8]);
  for (const n of [2, 3, 4, 5, 6]) assert.match(JOB_NOTES[n], /not secret/, `job ${n}`);
  for (const n of [7, 8]) assert.match(JOB_NOTES[n], /random nonce/, `job ${n}`);
  for (const n of Object.keys(JOB_NOTES).map(Number)) assert.ok(RULINGS.some((r) => r.job === n), `job ${n} has a ruling listed`);
  const prose = readme.replace(/\s+/g, " ");
  assert.ok(prose.includes("Only jobs 7 and 8 are unguessable."));
});

test("a sealed job's delivery is disclosed when a public job delivered text with the same dh", () => {
  const jobs = [
    { id: 0, sealed: false, dh: "a".repeat(64), deliverable: "public text" },
    { id: 1, sealed: false, dh: null, deliverable: null },
    { id: 2, sealed: true, dh: "a".repeat(64), deliverable_ct: "QUJD" },
    { id: 3, sealed: true, dh: null, deliverable_ct: null },
    { id: 4, sealed: true, dh: "c".repeat(64), deliverable_ct: "QUJD" },
  ];
  assert.deepEqual(disclosedDelivery(jobs[2], jobs), { text: "public text", fromJob: 0 });
  assert.equal(disclosedDelivery(jobs[3], jobs), null, "nothing delivered yet: no dh to match, even against a public job with none");
  assert.equal(disclosedDelivery(jobs[4], jobs), null);
  assert.equal(disclosedDelivery(jobs[0], jobs), null, "a public job's delivery is already in its ruling's input");
});

test("the one ruling that never opened a delivery (job 4's key_missing) is marked, so the page offers no delivery check for it", () => {
  assert.deepEqual(RULINGS.filter((r) => r.keyMissing).map((r) => [r.job, r.tx]), [[4, "J5hX6nup9AjXM4hsGXcRf29u279RAgseK3qZ9A8HPNt3"]]);
});

// ---- finding the rulings: FastNEAR's transaction index, with the README's list as the fallback ----

const indexFixture = JSON.parse(readFileSync(path.join(root, "web/test/fixtures/fastnear-escrow-index.json"), "utf8"));
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const asListed = (r) => ({ job: r.job, tx: r.tx, signer: r.signer, keyMissing: Boolean(r.keyMissing) });

/** A fake transaction index that answers from the recording of Nov 3 2026. */
function fakeIndex() {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url, body });
    if (url === `${TESTNET_TX_INDEX}/v0/account`) return ok(indexFixture.account);
    if (url === `${TESTNET_TX_INDEX}/v0/transactions`) return ok({ transactions: body.tx_hashes.map((h) => indexFixture.transactions[h]).filter(Boolean) });
    throw new Error(`asked an unexpected URL: ${url}`);
  };
  return { fetchImpl, asked };
}

test("discoverRulings finds the escrow's rulings through FastNEAR's transaction index: the README's ten, in order, job 4's key_missing one marked", async () => {
  const { fetchImpl, asked } = fakeIndex();
  const found = await discoverRulings(ESCROW, { fetchImpl });
  assert.deepEqual(found.map(asListed), RULINGS.map(asListed));
  const account = asked.filter((a) => a.url.endsWith("/v0/account"));
  assert.deepEqual(account.map((a) => a.body), [{ account_id: ESCROW, limit: 200 }]);
  const batches = asked.filter((a) => a.url.endsWith("/v0/transactions"));
  assert.ok(batches.length >= 4 && batches.every((b) => b.body.tx_hashes.length <= 10), "transactions are asked for in batches of at most 10, all at once");
});

test("discoverRulings reads every page of the index (resume_token), stops after ten pages, and fails loudly on an HTTP error", async () => {
  const all = indexFixture.account.account_txs;
  const pages = [all.slice(0, 15), all.slice(15, 30), all.slice(30)];
  const tokens = [];
  const paged = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/v0/account")) {
      tokens.push(body.resume_token);
      const i = body.resume_token === undefined ? 0 : Number(body.resume_token);
      return ok({ account_txs: pages[i], ...(i + 1 < pages.length ? { resume_token: String(i + 1) } : {}) });
    }
    return ok({ transactions: body.tx_hashes.map((h) => indexFixture.transactions[h]).filter(Boolean) });
  };
  assert.equal((await discoverRulings(ESCROW, { fetchImpl: paged })).length, 10);
  assert.deepEqual(tokens, [undefined, "1", "2"]);
  let calls = 0;
  const endless = async (url) => {
    if (url.endsWith("/v0/account")) {
      calls++;
      return ok({ account_txs: [], resume_token: "7" });
    }
    return ok({ transactions: [] });
  };
  assert.deepEqual(await discoverRulings(ESCROW, { fetchImpl: endless }), []);
  assert.equal(calls, 10);
  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(discoverRulings(ESCROW, { fetchImpl: down }), /transaction index.*HTTP 503/);
});

test("only a request_ruling to the escrow that the escrow itself logged as ruling_requested counts as a ruling", () => {
  const recovered = indexFixture.transactions["5G6jQja3xjvw6tnzkmpE3P86Sracs5PFStJJP38o4a2J"];
  assert.deepEqual(asListed(rulingFromIndexed(recovered, ESCROW)), { job: 4, tx: "5G6jQja3xjvw6tnzkmpE3P86Sracs5PFStJJP38o4a2J", signer: "judgenear-worker.testnet", keyMissing: false });
  assert.equal(rulingFromIndexed(indexFixture.transactions["J5hX6nup9AjXM4hsGXcRf29u279RAgseK3qZ9A8HPNt3"], ESCROW).keyMissing, true);
  const spoof = structuredClone(recovered);
  for (const r of spoof.receipts) r.execution_outcome.outcome.executor_id = "look-alike.testnet";
  assert.equal(rulingFromIndexed(spoof, ESCROW), null, "the same events logged by another account do not count");
  const elsewhere = structuredClone(recovered);
  elsewhere.transaction.receiver_id = "other.testnet";
  assert.equal(rulingFromIndexed(elsewhere, ESCROW), null);
  const refused = structuredClone(recovered);
  for (const r of refused.receipts) r.execution_outcome.outcome.logs = [];
  assert.equal(rulingFromIndexed(refused, ESCROW), null, "a request the escrow refused has no ruling_requested event");
  const fund = Object.values(indexFixture.transactions).find((t) => t.transaction.actions[0]?.FunctionCall?.method_name === "fund");
  assert.equal(rulingFromIndexed(fund, ESCROW), null);
  assert.equal(rulingFromIndexed(null, ESCROW), null);
});

test("mergeRulings: the index's rulings plus any listed one it left out; the list alone when the index did not answer", () => {
  const found = [{ job: 0, tx: "A", signer: "w" }, { job: 1, tx: "B", signer: "c" }];
  const listed = [{ job: 0, tx: "A", signer: "w" }, { job: 2, tx: "C", signer: "w", keyMissing: true }];
  assert.deepEqual(mergeRulings(listed, found).map((r) => r.tx), ["A", "B", "C"]);
  assert.equal(mergeRulings(listed, found).at(-1).keyMissing, true);
  assert.deepEqual(mergeRulings(listed, null), listed);
});

test("discoverRulings asks again, once, when an index request fails, as a busy index sometimes does", async () => {
  let failures = 1;
  const asked = [];
  const flaky = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(url);
    if (url.endsWith("/v0/transactions") && failures > 0) {
      failures--;
      throw new TypeError("Failed to fetch");
    }
    if (url.endsWith("/v0/account")) return ok(indexFixture.account);
    return ok({ transactions: body.tx_hashes.map((h) => indexFixture.transactions[h]).filter(Boolean) });
  };
  const found = await discoverRulings(ESCROW, { fetchImpl: flaky, retryDelayMs: 0 });
  assert.equal(found.length, 10, "the failed batch was asked again and answered");
  const always = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(discoverRulings(ESCROW, { fetchImpl: always, retryDelayMs: 0 }), /did not answer: Failed to fetch/);
});

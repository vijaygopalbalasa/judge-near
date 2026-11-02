// Page wiring for web/index.html. All checking logic lives in verify.js; reading the escrow in escrow.js.
import { ESCROW, RULINGS, formatNear, jobOutcome, parseDeepLink, readEscrow } from "./escrow.js";
import { PUBLISHED_JUDGES, publishedJudgeName, reportOutcome, sha256Hex, verifyTransaction } from "./verify.js";

const $ = (id) => document.getElementById(id);
const RUN_LIMIT_MS = 10_000;
const MARKS = { ok: "✓", bad: "✗", skip: "○" };

/** Run the judge in a worker with a time limit (the same WASI host as verify.js uses in Node). */
function runInWorker(bytes, input, env = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./judge-worker.js", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`the judge ran longer than ${RUN_LIMIT_MS / 1000} s and was stopped`));
    }, RUN_LIMIT_MS);
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.text);
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(e.message || "the judge worker failed"));
    };
    worker.postMessage({ bytes, input, env });
  });
}

/** An element with a class and text (text only: nothing read from the chain is ever parsed as HTML). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function markItem(kind, label, detail) {
  const li = el("li", kind);
  li.append(el("span", "mark", MARKS[kind]), document.createTextNode(label));
  if (detail) li.append(el("span", "detail", detail));
  return li;
}

function renderSteps(list, steps) {
  list.replaceChildren(...steps.map((s) => markItem(s.ok === true ? "ok" : s.ok === null ? "skip" : "bad", s.label, s.detail)));
}

/** The one-line summary of a report: verified, checked without the key, or not verified. */
function showOutcome(summary, report) {
  const outcome = reportOutcome(report);
  if (outcome === "verified") {
    summary.className = "summary ok";
    summary.textContent = `Verified: ${report.steps.find((s) => s.id === "published").detail} computes exactly this ruling (pass: ${report.local.pass}, score: ${report.local.score}).`;
  } else if (outcome === "needs-key") {
    summary.className = "summary note";
    summary.textContent = "Consistent, not re-run: every check that needs no key passed. Re-running the score needs the delivery key.";
  } else {
    summary.className = "summary bad";
    summary.textContent = "Not verified: see the step that failed below.";
  }
}

async function runCheck(button, summary, list, check) {
  button.disabled = true;
  summary.className = "summary";
  summary.textContent = "Checking...";
  list.replaceChildren();
  try {
    const report = await check();
    renderSteps(list, report.steps);
    showOutcome(summary, report);
  } catch (err) {
    summary.className = "summary bad";
    summary.textContent = `Could not check it: ${err.message}`;
  } finally {
    button.disabled = false;
  }
}

const short = (text, n = 6) => (text.length > n + 1 ? `${text.slice(0, n)}…` : text);
/** The transaction page (tx.html) reads any transaction from NEAR archival nodes; testnet explorers lag. */
const txLink = (tx, signer) => {
  const a = el("a", "", short(tx));
  a.href = `tx.html?tx=${encodeURIComponent(tx)}&signer=${encodeURIComponent(signer)}`;
  a.title = tx;
  return a;
};

function prettyCriteria(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function rulingRow(r) {
  const box = el("div", "ruling");
  const head = el("div", "ruling-head");
  const what = el("span");
  what.append("Ruling ", txLink(r.tx, r.signer), `, signed by ${r.signer}`);
  const button = el("button", "", "Verify");
  button.type = "button";
  head.append(what, button);
  const summary = el("div", "summary");
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  const list = el("ol", "steps");
  box.append(head, summary, list);
  button.addEventListener("click", () =>
    runCheck(button, summary, list, () => verifyTransaction(r.tx, r.signer, { job: { escrow: ESCROW, jobId: r.job }, runner: runInWorker })),
  );
  return box;
}

function jobCard(job) {
  const card = el("article", "job");
  card.id = `job-${job.id}`;
  const head = el("div", "job-head");
  head.append(el("h3", "", `Job ${job.id}`), el("span", job.sealed ? "badge sealed" : "badge", job.sealed ? "sealed" : "public"), el("span", `badge ${job.state}`, job.state));
  card.append(head);
  card.append(el("p", "meta", `${formatNear(job.amount)} · ${job.client} → ${job.provider}`));
  card.append(el("p", "outcome", jobOutcome(job)));
  if (job.sealed) {
    const note = job.deliverable_ct
      ? `Delivery: sealed, on chain only as ciphertext (${job.deliverable_ct.length} base64 characters); the worker's commitment is dh ${short(job.dh, 8)}`
      : "Delivery: sealed; nothing delivered yet.";
    card.append(el("p", "sealed-note", note));
  } else if (job.deliverable) {
    const d = el("details");
    d.append(el("summary", "", `Delivery (public, ${job.deliverable.length} characters)`), el("pre", "", job.deliverable));
    card.append(d);
  }
  const c = el("details");
  c.append(el("summary", "", "Criteria"), el("pre", "", prettyCriteria(job.criteria)));
  card.append(c);
  const rulings = RULINGS.filter((r) => r.job === job.id);
  if (rulings.length === 0) card.append(el("p", "meta", "No ruling of this job is listed on this page; paste its transaction in panel 2 to check it."));
  for (const r of rulings) card.append(rulingRow(r));
  return card;
}

async function loadJobs() {
  const status = $("jobs-status");
  try {
    const escrow = await readEscrow(ESCROW);
    const facts = $("escrow-facts");
    facts.replaceChildren(
      escrow.publishedBuild
        ? markItem("ok", "Runs the published escrow build", `code hash ${escrow.codeHash} (contract/BUILD.md)`)
        : markItem("bad", "Does not run the published escrow build", `code hash ${escrow.codeHash}`),
      PUBLISHED_JUDGES.has(escrow.judge.hash)
        ? markItem("ok", `Its judge is ${PUBLISHED_JUDGES.get(escrow.judge.hash)}`, `sha256 ${escrow.judge.hash}`)
        : markItem("bad", "Its judge is not a published Judge on NEAR build", `sha256 ${escrow.judge.hash}`),
      escrow.fullAccessKeys === 0
        ? markItem("ok", "No full-access key: nobody can replace its code", "the account has no key that can deploy")
        : markItem("skip", `Still has ${escrow.fullAccessKeys === 1 ? "a full-access key" : `${escrow.fullAccessKeys} full-access keys`}: its owner could replace the code`, "see the README, \"Security model and honest limits\""),
    );
    status.className = "summary";
    status.textContent = `${escrow.jobs.length} jobs, read at block ${escrow.blockHeight}.`;
    $("jobs").replaceChildren(...escrow.jobs.map(jobCard));
  } catch (err) {
    status.className = "summary bad";
    status.textContent = `Could not read the escrow: ${err.message}`;
  }
}

$("tx-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("key").value.trim();
  runCheck($("tx-go"), $("tx-summary"), $("tx-steps"), () =>
    verifyTransaction($("tx").value.trim(), $("signer").value.trim(), { env: key ? { JN_KEY: key } : {}, runner: runInWorker }),
  );
});

let judgeBytes;
let judgeName;
$("run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("run-go");
  const summary = $("run-summary");
  const out = $("run-out");
  button.disabled = true;
  try {
    if (!judgeBytes) {
      const res = await fetch("../judge-wasm/release/judge.wasm");
      if (!res.ok) throw new Error(`could not load the judge (HTTP ${res.status}); serve the repository root`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      judgeName = await publishedJudgeName(bytes);
      if (!judgeName) throw new Error(`the judge file served here (sha256 ${await sha256Hex(bytes)}) is not a published build; not running it`);
      judgeBytes = bytes;
    }
    const input = JSON.stringify({ criteria: $("criteria").value, deliverable: $("deliverable").value });
    const text = await runInWorker(judgeBytes, input);
    const verdict = JSON.parse(text);
    summary.className = `summary ${verdict.pass ? "ok" : "bad"}`;
    summary.textContent = verdict.err
      ? `Not judged: ${verdict.err}`
      : `${verdict.pass ? "Pass" : "Fail"}: score ${verdict.score} of 100 (threshold ${verdict.th}), by ${judgeName}.`;
    out.hidden = false;
    out.textContent = text;
  } catch (err) {
    summary.className = "summary bad";
    summary.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

loadJobs();

// A link to one ruling, ?tx=<hash>&signer=<account>, opens the page with it checked in panel 2.
const link = parseDeepLink(location.search);
if (link) {
  $("tx").value = link.tx;
  $("signer").value = link.signer;
  $("tx-form").scrollIntoView();
  $("tx-form").requestSubmit();
}

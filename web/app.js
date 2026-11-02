// Page wiring for web/index.html. All checking logic lives in verify.js; reading the escrow in escrow.js.
import { ESCROW, JOB_NOTES, RULINGS, disclosedDelivery, formatNear, formatTime, jobOutcome, parseDeepLink, readEscrow } from "./escrow.js";
import { PUBLISHED_JUDGES, publishedJudgeName, reportOutcome, sha256Hex, verifyTransaction } from "./verify.js";

const $ = (id) => document.getElementById(id);
const RUN_LIMIT_MS = 10_000;
const MAX_CARDS = 60; // newest first; anyone can create jobs, so a flood of them cannot bury the page
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

/** The one-line summary of a report (verified, checked without the key, or not verified) and what it means. */
function showOutcome(summary, report) {
  const outcome = reportOutcome(report);
  let line;
  let meaning = "";
  const judge = report.steps.find((s) => s.id === "published")?.detail;
  if (outcome === "verified" && report.steps.some((s) => s.id === "delivery")) {
    summary.className = "summary ok";
    line = `Verified on the disclosed delivery: ${judge} computes exactly this ruling (pass: ${report.local.pass}, score: ${report.local.score}).`;
    meaning = "The delivery hashes to the worker's commitment dh on chain, and the exact judge OutLayer ran, checked by its SHA-256, gives the same verdict on it here: pass, score, threshold, hashes and checks. No key was needed. The verdict's k and eh are not compared: they seal the key to the client.";
  } else if (outcome === "verified") {
    summary.className = "summary ok";
    line = `Verified: ${judge} computes exactly this ruling (pass: ${report.local.pass}, score: ${report.local.score}).`;
    meaning = "The exact judge OutLayer ran, downloaded and checked by its SHA-256, gives the same verdict here on the same input, field by field.";
  } else if (outcome === "needs-key") {
    summary.className = "summary note";
    line = "Consistent, not re-run: every check that needs no key passed. Re-running the score needs the delivery key.";
    meaning = "Checked without the key: the transaction asked for this job, the judge is a published build, and the verdict's hashes match the job's criteria, the worker's commitment and the verdict itself.";
  } else {
    summary.className = "summary bad";
    line = "Not verified: see the step that failed below.";
  }
  summary.replaceChildren(document.createTextNode(line), ...(meaning ? [el("span", "explain", meaning)] : []));
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

/** One listed ruling: a Verify button and, when the job's delivery is disclosed, a check on that text. */
function rulingRow(r, disclosed) {
  const box = el("div", "ruling");
  const head = el("div", "ruling-head");
  const what = el("span");
  what.append("Ruling ", txLink(r.tx, r.signer), `, signed by ${r.signer}`);
  const actions = el("span", "actions");
  const button = el("button", "", "Verify");
  button.type = "button";
  actions.append(button);
  head.append(what, actions);
  const summary = el("div", "summary");
  summary.setAttribute("role", "status");
  summary.setAttribute("aria-live", "polite");
  const list = el("ol", "steps");
  box.append(head, summary, list);
  const job = { escrow: ESCROW, jobId: r.job };
  button.addEventListener("click", () => runCheck(button, summary, list, () => verifyTransaction(r.tx, r.signer, { job, runner: runInWorker })));
  // A key_missing ruling never opened the delivery, so the text cannot re-check it; Verify re-runs it in full.
  if (disclosed && !r.keyMissing) {
    const onText = el("button", "secondary", "Verify on the disclosed text");
    onText.type = "button";
    actions.append(onText);
    onText.addEventListener("click", () => runCheck(onText, summary, list, () => verifyTransaction(r.tx, r.signer, { job, runner: runInWorker, delivery: disclosed.text })));
  }
  return box;
}

function jobCard(job, jobs) {
  const card = el("article", "job");
  card.id = `job-${job.id}`;
  const head = el("div", "job-head");
  head.append(el("h3", "", `Job ${job.id}`), el("span", job.sealed ? "badge sealed" : "badge", job.sealed ? "sealed" : "public"), el("span", `badge ${job.state}`, job.state));
  card.append(head);
  const when = formatTime(job.created_at_ns);
  card.append(el("p", "meta", `${formatNear(job.amount)} · ${job.client} → ${job.provider}${when ? ` · created ${when}` : ""}`));
  card.append(el("p", "outcome", jobOutcome(job)));
  const disclosed = disclosedDelivery(job, jobs);
  if (job.sealed) {
    const note = job.deliverable_ct
      ? `Delivery: sealed, on chain only as ciphertext (${job.deliverable_ct.length} base64 characters); the worker's commitment is dh ${short(job.dh, 8)}`
      : "Delivery: sealed; nothing delivered yet.";
    card.append(el("p", "sealed-note", note));
    if (JOB_NOTES[job.id]) card.append(el("p", "sealed-note", JOB_NOTES[job.id]));
    if (disclosed) card.append(el("p", "sealed-note", `Disclosed: job ${disclosed.fromJob} delivered the same text in public (same dh), so its rulings can be re-run in full on that text, with no key.`));
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
  for (const r of rulings) card.append(rulingRow(r, disclosed));
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
    const shown = escrow.jobs.slice(-MAX_CARDS).reverse();
    status.textContent = `${escrow.jobs.length} jobs, read at block ${escrow.blockHeight}; newest first${escrow.jobs.length > MAX_CARDS ? `, the ${MAX_CARDS} newest shown` : ""}.`;
    $("jobs").replaceChildren(...shown.map((job) => jobCard(job, escrow.jobs)));
  } catch (err) {
    status.className = "summary bad";
    status.textContent = `Could not read the escrow: ${err.message}`;
  }
}

$("tx-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("key").value.trim();
  const delivery = $("delivery").value; // exactly as pasted: its SHA-256 must be the job's dh
  if (key && delivery) {
    $("tx-summary").className = "summary bad";
    $("tx-summary").textContent = "Give the deliverable key or the disclosed delivery, not both.";
    $("tx-steps").replaceChildren();
    return;
  }
  const options = delivery ? { delivery, runner: runInWorker } : { env: key ? { JN_KEY: key } : {}, runner: runInWorker };
  runCheck($("tx-go"), $("tx-summary"), $("tx-steps"), () => verifyTransaction($("tx").value.trim(), $("signer").value.trim(), options));
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

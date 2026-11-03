// Page wiring for web/index.html. All checking logic lives in verify.js; reading the escrow in escrow.js.
import { ESCROW, JOB_NOTES, RULINGS, discoverRulings, disclosedDelivery, formatNear, formatTime, jobOutcome, mergeRulings, parseDeepLink, readEscrow } from "./escrow.js";
import { describeCheck, explainCriteria } from "./criteria.js";
import { EXAMPLES } from "./examples.js";
import { PUBLISHED_JUDGES, publishedJudgeName, reportOutcome, sha256Hex, verifyTransaction } from "./verify.js";
import { REGISTER_CONTRACT, checkTransactionAttestation, loadDcap } from "./attest.js";

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
  if (report.note) meaning = `${meaning} ${report.note}`.trim();
  // A ruling another contract asked for can pass every check; it is not one of this escrow's, so it is not shown green
  // and the headline says so first.
  if (report.asker && report.asker.account !== ESCROW) {
    if (outcome === "verified") {
      summary.className = "summary note";
      line = `Not a ruling of ${ESCROW}. ${line}`;
    }
    meaning = `${meaning} ${report.asker.account} asked for this ruling, not ${ESCROW}. The checks prove what the published judge computes on this input; they say nothing about what that account did with the verdict.`.trim();
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

// The DCAP verifier (about 1 MB of wasm) loads once, on the first attestation check, after its SHA-256 is checked.
let dcapLoading = null;
const getDcap = () => (dcapLoading ??= loadDcap().catch((err) => {
  dcapLoading = null;
  throw err;
}));

function showAttestation(summary, report) {
  if (report.ok) {
    summary.className = "summary ok";
    summary.replaceChildren(document.createTextNode("Proven: this ruling ran on genuine Intel TDX hardware, in an approved OutLayer worker build, and the quote covers exactly this run, this input and this output."),
      el("span", "explain", `Checked here in your browser: Intel's signature chain with dcap-qvl (compiled to wasm), against Intel's TCB data valid when the run happened (${report.executedAt}); the approved builds on ${REGISTER_CONTRACT}; and the record's fields against the hash the quote signed.`));
    return;
  }
  const first = report.steps.find((step) => step.ok !== true);
  summary.className = first?.ok === false ? "summary bad" : "summary note";
  summary.textContent = first?.ok === false ? "Not proven: a check below fails." : "Not proven: a check below could not be answered, which is not a pass.";
}

async function runAttestation(button, summary, list, tx, signer) {
  button.disabled = true;
  summary.className = "summary";
  summary.textContent = "Checking the TEE attestation...";
  list.replaceChildren();
  try {
    const report = await checkTransactionAttestation(tx, signer, { dcap: await getDcap() });
    renderSteps(list, report.steps);
    showAttestation(summary, report);
  } catch (err) {
    summary.className = "summary bad";
    summary.textContent = `Could not check it: ${err.message}`;
  } finally {
    button.disabled = false;
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
  const attestButton = el("button", "secondary", "TEE attestation");
  attestButton.type = "button";
  attestButton.title = "Check the Intel TDX attestation OutLayer recorded for this run";
  const attestSummary = el("div", "summary");
  attestSummary.setAttribute("role", "status");
  attestSummary.setAttribute("aria-live", "polite");
  const attestList = el("ol", "steps");
  // Hidden until asked for, so the card keeps its height.
  attestSummary.hidden = true;
  attestList.hidden = true;
  box.append(head, summary, list, attestSummary, attestList);
  attestButton.addEventListener("click", () => {
    attestSummary.hidden = false;
    attestList.hidden = false;
    runAttestation(attestButton, attestSummary, attestList, r.tx, r.signer);
  });
  const job = { escrow: ESCROW, jobId: r.job };
  button.addEventListener("click", () => runCheck(button, summary, list, () => verifyTransaction(r.tx, r.signer, { job, runner: runInWorker })));
  // A key_missing ruling never opened the delivery, so the text cannot re-check it; Verify re-runs it in full.
  if (disclosed && !r.keyMissing) {
    const onText = el("button", "secondary", "Verify on the disclosed text");
    onText.type = "button";
    actions.append(onText);
    onText.addEventListener("click", () => runCheck(onText, summary, list, () => verifyTransaction(r.tx, r.signer, { job, runner: runInWorker, delivery: disclosed.text })));
  }
  actions.append(attestButton);
  return box;
}

function jobCard(job, jobs, allRulings) {
  const card = el("article", "job");
  card.id = `job-${job.id}`;
  const head = el("div", "job-head");
  head.append(el("h3", "", `Job ${job.id}`), el("span", job.sealed ? "badge sealed" : "badge", job.sealed ? "sealed" : "public"), el("span", `badge ${job.state}`, job.state));
  card.append(head);
  const when = formatTime(job.created_at_ns);
  card.append(el("p", "meta", `${formatNear(job.amount)} · ${job.client} → ${job.provider}${when ? ` · created ${when}` : ""}`));
  card.append(el("p", "outcome", jobOutcome(job)));
  const disclosed = disclosedDelivery(job, jobs);
  if (disclosed) {
    card.append(el("p", "sealed-note", disclosed.published
      ? "Disclosed: this project publishes the delivery (see the README), so its ruling can be re-run in full on it, with no key."
      : `Disclosed: job ${disclosed.fromJob} delivered the same text in public (same dh), so its rulings can be re-run in full on that text, with no key.`));
  }
  // The delivery and the criteria fold away, so a phone shows each job's outcome and rulings without scrolling far.
  const more = el("details");
  more.append(el("summary", "", job.sealed ? "Delivery (sealed) and criteria" : "Delivery and criteria"));
  if (job.sealed) {
    more.append(el("p", "sealed-note", job.deliverable_ct
      ? `Sealed: on chain only as ciphertext (${job.deliverable_ct.length} base64 characters); the worker's commitment is dh ${short(job.dh, 8)}`
      : "Sealed; nothing delivered yet."));
    if (JOB_NOTES[job.id]) more.append(el("p", "sealed-note", JOB_NOTES[job.id]));
  } else if (job.deliverable) {
    more.append(el("p", "meta", `Delivery, public, ${job.deliverable.length} characters:`), el("pre", "", job.deliverable));
  } else {
    more.append(el("p", "meta", "Nothing delivered yet."));
  }
  let checks = [];
  try {
    checks = JSON.parse(job.criteria).checks ?? [];
  } catch {
    checks = [];
  }
  const kinds = el("ul", "facts");
  kinds.replaceChildren(...(Array.isArray(checks) ? checks : []).map((c, i) => el("li", "", `${c?.kind ?? "?"}#${i}: ${describeCheck(c)}`)));
  more.append(el("p", "meta", "Criteria:"), kinds, el("pre", "", prettyCriteria(job.criteria)));
  card.append(more);
  const rulings = allRulings.filter((r) => r.job === job.id);
  if (rulings.length === 0) card.append(el("p", "meta", "No ruling found for this job; to check one, paste its transaction under \u201cRe-run any ruling\u201d below."));
  for (const r of rulings) card.append(rulingRow(r, disclosed));
  return card;
}

async function loadJobs() {
  const status = $("jobs-status");
  // Rulings come from FastNEAR's transaction index. The jobs show at once with the list in escrow.js; the index's
  // answer is merged in when it comes, and only cards whose rulings changed are drawn again.
  const indexed = discoverRulings(ESCROW).catch((err) => ({ error: err }));
  let escrow;
  try {
    escrow = await readEscrow(ESCROW);
  } catch (err) {
    status.className = "summary bad";
    status.textContent = `Could not read the escrow: ${err.message}`;
    return;
  }
  $("escrow-facts").replaceChildren(
    escrow.publishedBuild
      ? markItem("ok", "Runs the published escrow build", `code hash ${escrow.codeHash} (contract/BUILD.md)`)
      : markItem("bad", "Does not run the published escrow build", `code hash ${escrow.codeHash}`),
    PUBLISHED_JUDGES.has(escrow.judge.hash)
      ? markItem("ok", `Its judge is ${PUBLISHED_JUDGES.get(escrow.judge.hash)}`, `sha256 ${escrow.judge.hash}`)
      : markItem("bad", "Its judge is not a published Judge on NEAR build", `sha256 ${escrow.judge.hash}`),
    escrow.fullAccessKeys === 0
      ? markItem("ok", "No full-access key: nobody can replace its code", "the account has no key that can deploy")
      : markItem("skip", `Still has ${escrow.fullAccessKeys === 1 ? "a full-access key" : `${escrow.fullAccessKeys} full-access keys`}: its owner could replace the code`, "see the README, \"Security model and limits\""),
  );
  status.className = "summary";
  const shown = escrow.jobs.slice(-MAX_CARDS).reverse();
  const line = (count, source) => `${escrow.jobs.length} jobs and ${count} rulings, read at block ${escrow.blockHeight}; newest first${escrow.jobs.length > MAX_CARDS ? `, the ${MAX_CARDS} newest shown` : ""}; ${source}.`;
  status.textContent = line(RULINGS.length, "rulings from the list in escrow.js while FastNEAR's transaction index is asked");
  $("jobs").replaceChildren(...shown.map((job) => jobCard(job, escrow.jobs, RULINGS)));

  const found = await indexed;
  if (!Array.isArray(found)) {
    status.textContent = line(RULINGS.length, `rulings from the list in escrow.js (the transaction index did not answer: ${found.error.message})`);
    return;
  }
  const rulings = mergeRulings(RULINGS, found);
  const key = (list, id) => JSON.stringify(list.filter((r) => r.job === id).map((r) => [r.tx, Boolean(r.keyMissing)]));
  for (const job of shown) {
    if (key(rulings, job.id) !== key(RULINGS, job.id)) $(`job-${job.id}`)?.replaceWith(jobCard(job, escrow.jobs, rulings));
  }
  status.textContent = line(rulings.length, "rulings found through FastNEAR's transaction index");
}

// A disclosed delivery loaded from a file keeps its exact bytes; a text box turns CRLF line endings into LF.
let deliveryFile = null;
$("delivery-file").addEventListener("change", async () => {
  const file = $("delivery-file").files?.[0];
  deliveryFile = null;
  $("delivery-file-note").textContent = "";
  if (!file) return;
  try {
    deliveryFile = { name: file.name, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) };
    $("delivery").value = "";
    $("delivery-file-note").textContent = `Loaded ${file.name} (${file.size} bytes), exactly as saved.`;
  } catch {
    $("delivery-file-note").textContent = `${file.name} is not UTF-8 text, so it cannot be a delivery.`;
  }
});
$("delivery").addEventListener("input", () => {
  if (!deliveryFile) return;
  deliveryFile = null;
  $("delivery-file").value = "";
  $("delivery-file-note").textContent = "";
});

$("tx-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("key").value.trim();
  const delivery = deliveryFile ? deliveryFile.text : $("delivery").value;
  if (key && delivery) {
    $("tx-summary").className = "summary bad";
    $("tx-summary").textContent = "Give the deliverable key or the disclosed delivery, not both.";
    $("tx-steps").replaceChildren();
    return;
  }
  const tx = $("tx").value.trim();
  const signer = $("signer").value.trim();
  const options = delivery ? { delivery, runner: runInWorker } : { env: key ? { JN_KEY: key } : {}, runner: runInWorker };
  runCheck($("tx-go"), $("tx-summary"), $("tx-steps"), async () => {
    const report = await verifyTransaction(tx, signer, options);
    const last = report.steps.at(-1);
    // Pasted text lost any CR when it went into the text box: try it once with CRLF line endings.
    if (delivery && !deliveryFile && delivery.includes("\n") && last?.id === "delivery" && last.ok === false) {
      const again = await verifyTransaction(tx, signer, { ...options, delivery: delivery.replace(/\r?\n/g, "\r\n") });
      if (again.steps.find((s) => s.id === "delivery")?.ok === true) {
        return { ...again, note: "The pasted text matched once its line endings were put back to CRLF: a browser text box turns CRLF into LF." };
      }
    }
    return report;
  });
});

// The examples fill both boxes and run the judge; editing either box drops the example's note.
let activeExample = null;
for (const ex of EXAMPLES) {
  const button = el("button", "secondary", ex.label);
  button.type = "button";
  button.addEventListener("click", () => {
    $("criteria").value = ex.criteria;
    $("deliverable").value = ex.deliverable;
    activeExample = ex;
    $("run-form").requestSubmit();
  });
  $("examples").append(button);
}
for (const id of ["criteria", "deliverable"]) $(id).addEventListener("input", () => (activeExample = null));

let judgeBytes;
let judgeName;
$("run-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("run-go");
  const summary = $("run-summary");
  const out = $("run-out");
  button.disabled = true;
  $("run-checks").replaceChildren();
  try {
    if (!judgeBytes) {
      const res = await fetch("../judge-wasm/release/judge.wasm");
      if (!res.ok) throw new Error(`could not load the judge (HTTP ${res.status}); serve the repository root`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      judgeName = await publishedJudgeName(bytes);
      if (!judgeName) throw new Error(`the judge file served here (sha256 ${await sha256Hex(bytes)}) is not a published build; not running it`);
      judgeBytes = bytes;
    }
    const criteriaText = $("criteria").value;
    const input = JSON.stringify({ criteria: criteriaText, deliverable: $("deliverable").value });
    const text = await runInWorker(judgeBytes, input);
    const verdict = JSON.parse(text);
    summary.className = `summary ${verdict.pass ? "ok" : "bad"}`;
    if (verdict.err === "invalid_criteria") {
      summary.textContent = `Not judged: the judge calls these criteria invalid. ${explainCriteria(criteriaText) ?? "See the check kinds in docs/interface.md, section 2."}`;
    } else {
      summary.textContent = verdict.err
        ? `Not judged: ${verdict.err}`
        : `${verdict.pass ? "Pass" : "Fail"}: score ${verdict.score} of 100 (threshold ${verdict.th}), by ${judgeName}.`;
    }
    // Each check in plain words, next to the judge's id for it (kind#index into the criteria's checks).
    let checks = [];
    try {
      checks = JSON.parse(criteriaText).checks ?? [];
    } catch {
      checks = [];
    }
    $("run-checks").replaceChildren(...(verdict.checks ?? []).map((c) => markItem(c.ok ? "ok" : "bad", `${c.id}: ${describeCheck(checks[Number(c.id.split("#")[1])])}`)));
    if (activeExample?.note) summary.append(el("span", "explain", activeExample.note));
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

// A link to one ruling, ?tx=<hash>&signer=<account>, opens the page with it checked under "Re-run any ruling".
const link = parseDeepLink(location.search);
if (link) {
  $("tx").value = link.tx;
  $("signer").value = link.signer;
  $("tx-form").scrollIntoView();
  $("tx-form").requestSubmit();
}

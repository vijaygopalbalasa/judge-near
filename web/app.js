// Page wiring for web/index.html. All checking logic lives in verify.js.
import { verifyTransaction } from "./verify.js";

const $ = (id) => document.getElementById(id);
const RUN_LIMIT_MS = 10_000;

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

function renderSteps(list, steps) {
  list.replaceChildren(
    ...steps.map((s) => {
      const li = document.createElement("li");
      li.className = s.ok ? "ok" : "bad";
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = s.ok ? "✓" : "✗";
      li.append(mark, document.createTextNode(s.label));
      if (s.detail) {
        const d = document.createElement("span");
        d.className = "detail";
        d.textContent = s.detail;
        li.append(d);
      }
      return li;
    }),
  );
}

$("tx-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = $("tx-go");
  const summary = $("tx-summary");
  button.disabled = true;
  summary.className = "summary";
  summary.textContent = "Checking...";
  $("tx-steps").replaceChildren();
  try {
    const key = $("key").value.trim();
    const report = await verifyTransaction($("tx").value.trim(), $("signer").value.trim(), {
      env: key ? { JN_KEY: key } : {},
      runner: runInWorker,
    });
    renderSteps($("tx-steps"), report.steps);
    summary.className = `summary ${report.ok ? "ok" : "bad"}`;
    summary.textContent = report.ok
      ? `Verified: ${report.steps.find((s) => s.id === "published").detail} computes exactly this ruling (pass: ${report.local.pass}, score: ${report.local.score}).`
      : "Not verified: see the step that failed below.";
  } catch (err) {
    summary.className = "summary bad";
    summary.textContent = `Could not check it: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

let judgeBytes;
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
      judgeBytes = new Uint8Array(await res.arrayBuffer());
    }
    const input = JSON.stringify({ criteria: $("criteria").value, deliverable: $("deliverable").value });
    const text = await runInWorker(judgeBytes, input);
    const verdict = JSON.parse(text);
    summary.className = `summary ${verdict.pass ? "ok" : "bad"}`;
    summary.textContent = verdict.err
      ? `Not judged: ${verdict.err}`
      : `${verdict.pass ? "Pass" : "Fail"}: score ${verdict.score} of 100 (threshold ${verdict.th}).`;
    out.hidden = false;
    out.textContent = text;
  } catch (err) {
    summary.className = "summary bad";
    summary.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// Page wiring for web/tx.html: one transaction in plain terms. The reading and summarising live in verify.js.
import { parseDeepLink } from "./escrow.js";
import { PUBLISHED_JUDGES, fetchTransaction, findRuling, summarizeTx } from "./verify.js";

const $ = (id) => document.getElementById(id);

/** An element with a class and text (text only: nothing read from the chain is ever parsed as HTML). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(key, value, className = "mono") {
  const r = el("div", "row");
  r.append(el("div", "k", key), el("div", className, value));
  return r;
}

const yocto = (s) => {
  if (!/^\d+$/.test(s)) return s;
  const d = s.padStart(25, "0");
  const whole = d.slice(0, -24).replace(/^0+(?=\d)/, "");
  const frac = d.slice(-24).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} NEAR`;
};

async function main() {
  const status = $("status");
  const link = parseDeepLink(location.search);
  if (!link) {
    status.textContent = "Add ?tx=<transaction hash>&signer=<account that signed it> to the address.";
    return;
  }
  try {
    const tx = await fetchTransaction(link.tx, link.signer);
    const sum = summarizeTx(tx);
    const refused = sum.outlayer.some((o) => !o.success);
    status.className = sum.status === "success" && !refused ? "ok" : "bad";
    status.textContent = sum.status !== "success" ? "The transaction failed."
      : refused ? "The transaction went through, and OutLayer refused to run the wasm (below)." : "The transaction succeeded.";
    const head = el("section");
    head.append(el("h2", "", "Transaction"), row("hash", link.tx), row("signer", sum.signer), row("receiver", sum.receiver));
    for (const a of sum.actions) {
      head.append(row("action", a.kind === "FunctionCall" ? `${a.method}(), deposit ${yocto(a.deposit)}` : a.deposit ? `${a.kind}, ${yocto(a.deposit)}` : a.kind));
      if (a.args) {
        let text = a.args;
        try {
          text = JSON.stringify(JSON.parse(a.args), null, 2);
        } catch {
          // not JSON: shown as it is
        }
        const box = el("div", "row");
        box.append(el("div", "k", "arguments"), el("pre", "", text.length > 1500 ? `${text.slice(0, 1500)}...` : text));
        head.append(box);
      }
    }
    if (sum.failure) head.append(row("failure", sum.failure));
    for (const o of sum.outlayer) {
      head.append(o.success
        ? row("OutLayer", `ran the wasm: ${o.instructions ?? "?"} instructions, ${o.timeMs ?? "?"} ms`, "mono ok")
        : row("OutLayer", `refused: ${o.error ?? "no reason given"}`, "mono bad"));
    }
    const ruling = findRuling(tx);
    if (ruling && PUBLISHED_JUDGES.has(ruling.source?.hash)) {
      const p = el("p");
      const a = el("a", "", "Re-run this ruling in the verifier");
      a.href = `./?tx=${encodeURIComponent(link.tx)}&signer=${encodeURIComponent(link.signer)}`;
      p.append(`This transaction asked OutLayer to run ${PUBLISHED_JUDGES.get(ruling.source.hash)}. `, a, ".");
      head.append(p);
    } else if (ruling) {
      head.append(el("p", "", `This transaction asked OutLayer to run a wasm that is not a published judge build (sha256 ${ruling.source?.hash ?? "unknown"}).`));
    }
    const receipts = el("section");
    receipts.append(el("h2", "", `Receipts (${sum.receipts.length})`));
    sum.receipts.forEach((r, i) => {
      receipts.append(row(`#${i + 1}`, `${r.executor}: ${r.status}`, `mono ${r.status === "failure" ? "bad" : ""}`));
      if (r.failure) receipts.append(row("failure", r.failure));
      for (const e of r.events) {
        const pre = el("pre", "", JSON.stringify(e, null, 2));
        const box = el("div", "row");
        box.append(el("div", "k", "event"), pre);
        receipts.append(box);
      }
      for (const l of r.logs) receipts.append(row("log", l));
      if (r.returned) receipts.append(row("returned", r.returned.length > 1200 ? `${r.returned.slice(0, 1200)}...` : r.returned));
    });
    $("out").replaceChildren(head, receipts);
  } catch (err) {
    status.className = "bad";
    status.textContent = `Could not read it: ${err.message}`;
  }
}

main();

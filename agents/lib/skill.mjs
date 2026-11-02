// The worker agent's skill. It takes jobs whose criteria ask for a JSON object with named fields
// (a schema check: `required` fields, typed as its `types` say) and fills them from facts it reads
// on chain about the escrow. A field it has no fact for is left out, never invented, so the judge
// fails that delivery. No language model: the same criteria and facts always give the same text.

import { formatNear } from "../../web/escrow.js";

/** JavaScript's typeof, as the judge's schema check compares it: arrays and null are "object". */
const typeOf = (value) => (value === null || Array.isArray(value) ? "object" : typeof value);

/** The report for these criteria: {text, missing}, where missing lists the required fields with no fact of the named type. */
export function deliverableFor(criteriaText, facts) {
  let criteria;
  try {
    criteria = JSON.parse(criteriaText);
  } catch {
    throw new Error("the criteria are not JSON");
  }
  const schemas = (Array.isArray(criteria?.checks) ? criteria.checks : []).filter((c) => c?.kind === "schema");
  if (schemas.length === 0) throw new Error("the criteria have no schema check: this worker only delivers JSON objects with named fields");
  const required = [];
  const types = {};
  for (const s of schemas) {
    for (const field of Array.isArray(s.params?.required) ? s.params.required : []) {
      if (typeof field === "string" && !required.includes(field)) required.push(field);
    }
    if (s.params?.types && typeof s.params.types === "object") Object.assign(types, s.params.types);
  }
  if (required.length === 0) throw new Error("the schema check names no required fields");
  const report = {};
  const missing = [];
  for (const field of required) {
    const value = Object.hasOwn(facts, field) ? facts[field] : undefined;
    const want = types[field];
    if (value === undefined || (typeof want === "string" && typeOf(value) !== want)) missing.push(field);
    else report[field] = value;
  }
  return { text: JSON.stringify(report, null, 2), missing };
}

/** What the worker knows about the escrow: its job counts and what it paid workers, read at `now`. */
export function escrowFacts({ escrow, jobId, jobs, now }) {
  const completed = jobs.filter((j) => j.state === "Completed");
  const paid = completed.reduce((sum, j) => sum + BigInt(j.amount), 0n);
  return {
    escrow,
    job: jobId,
    jobs: jobs.length,
    completed: completed.length,
    refunded: jobs.filter((j) => j.state === "Refunded").length,
    paid_to_workers: formatNear(paid.toString()),
    read_at: new Date(now).toISOString(),
  };
}

// The criteria language (docs/interface.md, section 2) in plain words: what each kind of check takes, a one-line
// description of a check, and the first problem in criteria the judge calls invalid_criteria. The judge decides what
// is valid; this file only explains (web/test/criteria.test.mjs checks it against the published judge).

/** Each kind of check: what it asks, and what each parameter must be. */
export const CHECK_KINDS = Object.freeze({
  length: Object.freeze({
    asks: "the delivery's length is within min and max",
    params: { min: "a number of 0 or more", max: "a number of 0 or more, not below min", unit: '"words" (the default) or "chars"' },
  }),
  contains: Object.freeze({
    asks: "every term in all appears in the delivery (case matters)",
    params: { all: "a list of up to 256 terms", wholeWords: "true to match whole words only" },
  }),
  schema: Object.freeze({
    asks: "the delivery is a JSON object with the required fields, of the named types",
    params: { required: "a list of up to 256 field names", types: 'an object giving fields a type: "string", "number", "boolean" or "object"' },
  }),
  checksum: Object.freeze({
    asks: "the delivery's SHA-256 is the given one",
    params: { sha256: "64 hex digits" },
  }),
  json: Object.freeze({
    asks: "the delivery is JSON that matches a shape",
    params: { shape: 'a subset of JSON Schema: type, enum, anyOf, required, properties, additionalProperties, items, minItems, maxItems, uniqueBy ({"field": ..., "key": "value" or "domain"}), minLength, maxLength, format ("url" or "email"), minimum, maximum' },
  }),
});

const KINDS = Object.keys(CHECK_KINDS);
const TYPE_NAMES = ["string", "number", "boolean", "object"];
const SHAPE_KEYWORDS = ["type", "enum", "anyOf", "required", "properties", "additionalProperties", "items", "minItems", "maxItems", "uniqueBy", "minLength", "maxLength", "format", "minimum", "maximum"];
const SHAPE_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];
const MAX_CHECKS = 16;
const MAX_DEPTH = 12;
const TERMS = 256;
const TERM_CHARS = 1024;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const present = (o, k) => Object.hasOwn(o, k) && o[k] !== null;
const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isTermList = (v) => Array.isArray(v) && v.length <= TERMS && v.every((s) => typeof s === "string" && s.length <= TERM_CHARS);
const andList = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function depthOf(v) {
  if (v === null || typeof v !== "object") return 0;
  let deepest = 0;
  for (const x of Object.values(v)) deepest = Math.max(deepest, depthOf(x));
  return deepest + 1;
}

function hasProtoKey(v) {
  if (v === null || typeof v !== "object") return false;
  return Object.keys(v).some((k) => k === "__proto__" || hasProtoKey(v[k]));
}

/** The first problem with a json check's shape that this file can name, or null. */
function shapeProblem(shape) {
  if (!isObject(shape)) return "shape must be an object";
  const unknown = Object.keys(shape).find((k) => !SHAPE_KEYWORDS.includes(k));
  if (unknown) return `shape is not valid: unknown keyword ${unknown}`;
  if (present(shape, "type") && !SHAPE_TYPES.includes(shape.type)) return `shape is not valid: type must be one of ${andList(SHAPE_TYPES.map((t) => `"${t}"`))}`;
  return null;
}

/** The first problem with one check's params, or null. */
function paramsProblem(kind, params) {
  const allowed = Object.keys(CHECK_KINDS[kind].params);
  const extra = Object.keys(params).find((k) => !allowed.includes(k));
  if (extra) return `${kind} takes ${andList(allowed)}, not ${extra}`;
  if (kind === "length") {
    for (const k of ["min", "max"]) if (present(params, k) && !isCount(params[k])) return `${k} must be a number of 0 or more`;
    if (present(params, "min") && present(params, "max") && params.min > params.max) return "min is above max";
    if (present(params, "unit") && !["chars", "words"].includes(params.unit)) return 'unit must be "chars" or "words"';
  } else if (kind === "contains") {
    if (present(params, "all") && !isTermList(params.all)) return "all must be a list of terms (up to 256, each up to 1,024 characters)";
    if (present(params, "wholeWords") && typeof params.wholeWords !== "boolean") return "wholeWords must be true or false";
  } else if (kind === "schema") {
    if (present(params, "required") && !isTermList(params.required)) return "required must be a list of field names";
    if (present(params, "types")) {
      if (!isObject(params.types) || Object.keys(params.types).length > TERMS) return "types must be an object of up to 256 fields";
      if (Object.values(params.types).some((t) => !TYPE_NAMES.includes(t))) return 'each type in types must be "string", "number", "boolean" or "object"';
    }
  } else if (kind === "checksum") {
    if (typeof params.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(params.sha256)) return "sha256 must be 64 hex digits";
  } else if (kind === "json" && present(params, "shape")) {
    return shapeProblem(params.shape);
  }
  return null;
}

/**
 * The first problem in these criteria, in plain words, or null when this file finds none. Meant for criteria the
 * judge answered invalid_criteria on; null then means the problem is one this file does not name.
 */
export function explainCriteria(text) {
  let criteria;
  try {
    criteria = JSON.parse(text);
  } catch {
    return "the criteria are not JSON";
  }
  if (!isObject(criteria)) return "the criteria must be a JSON object";
  if (depthOf(criteria) > MAX_DEPTH) return "the criteria nest more than 12 levels deep";
  if (hasProtoKey(criteria)) return "the criteria use the key __proto__, which the judge refuses";
  const checks = criteria.checks;
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > MAX_CHECKS) return "checks must be a list of 1 to 16 checks";
  if (Object.hasOwn(criteria, "passThreshold")) {
    const t = criteria.passThreshold;
    if (typeof t !== "number" || !Number.isInteger(t) || t < 0 || t > 100) return "passThreshold must be a whole number from 0 to 100";
  }
  for (const [i, check] of checks.entries()) {
    const n = `check ${i + 1}`;
    if (!isObject(check)) return `${n} must be an object`;
    const extra = Object.keys(check).find((k) => !["kind", "params", "weight"].includes(k));
    if (extra) return `${n} takes kind, params and weight, not ${extra}`;
    if (!KINDS.includes(check.kind)) return `${n}: unknown kind ${JSON.stringify(check.kind ?? null)}; the kinds are ${andList(KINDS)}`;
    if (Object.hasOwn(check, "weight") && !(typeof check.weight === "number" && check.weight > 0 && check.weight <= 1000)) return `${n}: weight must be a number above 0 and at most 1000`;
    if (present(check, "params") && !isObject(check.params)) return `${n}: params must be an object`;
    const problem = paramsProblem(check.kind, present(check, "params") ? check.params : {});
    if (problem) return `${n}: ${problem}`;
  }
  return null;
}

/** One check in plain words, such as "at most 600 characters" or 'contains "a" and "b"'. */
export function describeCheck(check) {
  const p = isObject(check?.params) ? check.params : {};
  switch (check?.kind) {
    case "length": {
      const unit = p.unit === "chars" ? "characters" : "words"; // the judge counts words unless unit is "chars"
      if (present(p, "min") && present(p, "max")) return `${p.min} to ${p.max} ${unit}`;
      if (present(p, "max")) return `at most ${p.max} ${unit}`;
      if (present(p, "min")) return `at least ${p.min} ${unit}`;
      return "any length";
    }
    case "contains":
      return `contains ${andList((Array.isArray(p.all) ? p.all : []).map((t) => JSON.stringify(t)))}${p.wholeWords ? " as whole words" : ""}`;
    case "schema": {
      const types = isObject(p.types) ? p.types : {};
      const fields = (Array.isArray(p.required) ? p.required : []).map((f) => (types[f] ? `${f} (${types[f]})` : f));
      return fields.length ? `a JSON object with ${andList(fields)}` : "a JSON object";
    }
    case "checksum":
      return `SHA-256 is ${String(p.sha256 ?? "").slice(0, 8)}...`;
    case "json":
      return "JSON that matches the given shape";
    default:
      return "an unknown check";
  }
}

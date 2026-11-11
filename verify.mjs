#!/usr/bin/env node
/**
 * Run-receipt verifier, v0.1.
 *
 * Answers one question about a receipt file: does it hold together? First
 * against the schema (shape, bounds), then against itself (the rules in
 * SPEC.md: a grade that follows from the totals, a verdict that follows from
 * where each reviewer ended, checks whose state matches their exit code).
 *
 * It does not prove the run happened. A receipt is the producer's account;
 * this proves the account is well-formed, internally consistent and, when it
 * carries a digest, unaltered since the digest was taken.
 *
 * No dependencies: Node 18 or later and this file, with the schema beside it.
 */
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SCHEMA_URL = new URL("./receipt.schema.json", import.meta.url);
let cachedSchema = null;
export function loadSchema() {
  return (cachedSchema ??= JSON.parse(readFileSync(SCHEMA_URL, "utf8")));
}

/* ── Schema: the subset of JSON Schema that receipt.schema.json uses ───── */

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => typeOf(v) === t || (t === "number" && typeof v === "number");

/** Every way `value` fails `schema`, as "path: what is wrong". Empty when it passes. */
export function validateSchema(value, schema, root = schema, path = "$") {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    if (!target) return [`${path}: schema reference ${schema.$ref} not found`];
    return validateSchema(value, target, root, path);
  }
  if (schema.anyOf) {
    return schema.anyOf.some((s) => validateSchema(value, s, root, path).length === 0) ? [] : [`${path}: matches none of the allowed forms`];
  }
  const out = [];
  if ("const" in schema && value !== schema.const) return [`${path}: must be ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: must be one of ${schema.enum.join(", ")}`];
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) return [`${path}: must be ${types.join(" or ")}, found ${typeOf(value)}`];
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${path}: must be a finite number`);
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${path}: does not have the required form`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: allows at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...validateSchema(v, schema.items, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) out.push(`${path}.${key}: is required`);
    for (const [key, v] of Object.entries(value)) {
      if (key in props) out.push(...validateSchema(v, props[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${key}: is not part of the format`);
    }
  }
  return out;
}

/* ── Digest ──────────────────────────────────────────────────────────── */

/** The receipt as bytes to hash: keys sorted, no whitespace, `digest` left out. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export function digestOf(receipt) {
  const { digest: _left_out, ...rest } = receipt;
  return `sha256:${createHash("sha256").update(canonical(rest), "utf8").digest("hex")}`;
}

/* ── Consistency: the rules of SPEC.md, by number ────────────────────── */

/** The grade the totals earn (SPEC rule G). */
export function gradeOf(t) {
  if (t.failingNow > 0 || t.contradicted > 0) return "failed";
  if (t.ran > 0) return t.verifiers >= t.reviewers ? "verified" : "partial";
  if (t.filesChanged === 0) return "reviewed";
  if (t.reviewers > 0 && (t.notVisible ?? 0) >= t.reviewers) return "not-visible";
  return "unverified";
}

/** Errors and warnings from a receipt that already passed the schema. */
export function checkConsistency(r) {
  const errors = [], warnings = [];
  const err = (rule, msg) => errors.push(`${rule}: ${msg}`);
  const t = r.totals;

  // S — seats.
  const names = r.seats.map((s) => s.name);
  if (new Set(names).size !== names.length) err("S1", "two seats share a name");
  if (!r.seats.some((s) => s.role === "lead")) err("S2", "no seat is the lead");
  const reviewers = r.seats.filter((s) => s.role === "reviewer");
  for (const s of r.seats) {
    if (s.timeouts > s.errors) err("S3", `${s.name}: more timeouts than errors`);
    if (s.role === "reviewer" && !s.stance) err("S4", `${s.name}: a reviewer needs a stance`);
    if (s.role === "lead" && s.stance) err("S4", `${s.name}: the lead has no stance`);
    if (s.costBasis && s.costBasis !== "metered" && s.costUsd > 0) err("S5", `${s.name}: a ${s.costBasis} seat cannot carry a metered cost`);
  }

  // V — verdict.
  const agreed = reviewers.filter((s) => s.stance === "agreed");
  const answered = reviewers.filter((s) => s.stance !== "unavailable");
  const out = reviewers.filter((s) => s.stance && s.stance !== "agreed");
  if (reviewers.length === 0) {
    if (r.verdict !== null) err("V1", "nobody reviewed, so there can be no verdict");
  } else if (r.verdict === null) {
    err("V1", "reviewers took part, so a verdict is required");
  } else {
    const v = r.verdict;
    if (v.agreed !== agreed.length) err("V2", `verdict counts ${v.agreed} agreeing; the seats show ${agreed.length}`);
    const key = (h) => `${h.name}\u0000${h.stance}`;
    const want = out.map(key).sort().join("\n"), got = v.holdouts.map(key).sort().join("\n");
    if (want !== got) err("V3", "holdouts are not exactly the reviewers that did not agree");
    if (v.outcome === "agreed") {
      const allWhoAnsweredAgreed = answered.length > 0 && answered.every((s) => s.stance === "agreed");
      const someoneMissing = answered.length < reviewers.length;
      if (!allWhoAnsweredAgreed) err("V4", "outcome is agreed while a reviewer that answered did not agree");
      else if (someoneMissing && t.failingNow > 0) err("V4", "outcome is agreed without a reviewer while a check is still failing");
      if (v.reviewers !== answered.length) err("V5", `an agreed verdict counts the reviewers that answered (${answered.length}), not ${v.reviewers}`);
    } else {
      const expected = agreed.length * 2 > reviewers.length ? "majority" : "none";
      if (v.outcome !== expected) err("V4", `outcome should be ${expected}: ${agreed.length} of ${reviewers.length} agree`);
      if (v.reviewers !== reviewers.length) err("V5", `verdict counts ${v.reviewers} reviewers; the seats show ${reviewers.length}`);
    }
  }

  // T — totals.
  if (t.reviewers !== answered.length) err("T1", `totals count ${t.reviewers} reviewers; ${answered.length} answered`);
  if (t.verifiers > t.reviewers) err("T2", "more verifiers than reviewers");
  if ((t.notVisible ?? 0) > t.reviewers) err("T2", "more not-visible seats than reviewers");
  if (t.contradicted > t.reviewers) err("T2", "more contradicted seats than reviewers");
  const hidden = reviewers.filter((s) => s.commandsVisible === false).length;
  if ((t.notVisible ?? 0) > hidden) err("T2", `totals count ${t.notVisible} not-visible seats; ${hidden} reviewer(s) are marked so`);
  if (t.passed + t.failed + (t.expected ?? 0) > t.ran) err("T3", "passed, failed and expected add up to more than ran");
  if (t.failingNow > t.failed) err("T4", "more checks failing now than ever failed");
  if ((t.resolved ?? 0) > t.failed - t.failingNow) err("T4", "more checks resolved than stopped failing");
  if (t.ran > 0 && t.verifiers === 0) err("T5", "commands were run, but no reviewer is counted as running any");
  if (t.ran === 0 && t.verifiers > 0) err("T5", "a reviewer is counted as running commands, but none were run");

  // G — grade.
  const grade = gradeOf(t);
  if (r.grade !== grade) err("G1", `grade is ${r.grade}; the totals earn ${grade}`);

  // C — checks.
  r.checks.forEach((c, i) => {
    const at = `checks[${i}]`;
    for (const who of [c.by, ...(c.alsoBy ?? [])]) if (who !== null && !names.includes(who)) err("C1", `${at}: ${who} is not a seat in this run`);
    if (c.exitCode === 0 && c.state !== "checked") err("C2", `${at}: exited 0, so its state is checked, not ${c.state}`);
    if ((c.state === "blocked") !== (c.missingSetup !== null)) err("C3", `${at}: blocked and missing setup go together`);
    if ((c.state === "unknown" || c.state === "untested") && c.exitCode !== null) err("C4", `${at}: a state of ${c.state} has no exit code`);
  });
  const ranHere = r.checks.filter((c) => c.state !== "untested").length;
  if (ranHere > t.ran) warnings.push(`C5: ${ranHere} checks are listed as run, but the totals count ${t.ran}`);

  // M — money and time.
  const seatCost = r.seats.reduce((n, s) => n + s.costUsd, 0);
  if (Math.abs(seatCost - r.costUsd) > 0.01) warnings.push(`M1: seats add up to $${seatCost.toFixed(4)}; the run says $${r.costUsd.toFixed(4)}`);
  if (r.firstReplyMs !== undefined && r.firstReplyMs > r.durationMs) err("M2", "the first reply came after the run ended");
  if (Number.isNaN(Date.parse(r.endedAt))) err("M3", "endedAt is not a real date");

  // D — digest.
  if (r.digest && r.digest !== digestOf(r)) err("D1", "digest does not match the receipt's contents");
  if (!r.digest) warnings.push("D2: no digest, so a copy cannot be told from an edited one");

  return { errors, warnings };
}

/** Schema first; the consistency rules only run on a receipt with the right shape. */
export function verifyReceipt(receipt) {
  const schemaErrors = validateSchema(receipt, loadSchema());
  if (schemaErrors.length) return { valid: false, errors: schemaErrors.map((e) => `schema: ${e}`), warnings: [] };
  const { errors, warnings } = checkConsistency(receipt);
  return { valid: errors.length === 0, errors, warnings };
}

/* ── Command line ────────────────────────────────────────────────────── */

const USAGE = `Usage:
  verify.mjs <receipt.json>            check a receipt; exit 0 valid, 1 invalid
  verify.mjs --json <receipt.json>     the same, as JSON
  verify.mjs --digest <receipt.json>   print the digest the receipt should carry`;

function main(argv) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length !== 1 || flags.some((f) => !["--json", "--digest"].includes(f))) { console.error(USAGE); return 2; }
  let receipt;
  try { receipt = JSON.parse(readFileSync(files[0], "utf8")); }
  catch (e) { console.error(`Cannot read ${files[0]}: ${e.message}`); return 2; }
  if (flags.includes("--digest")) {
    if (typeOf(receipt) !== "object") { console.error("Not a receipt."); return 2; }
    console.log(digestOf(receipt));
    return 0;
  }
  const result = verifyReceipt(receipt);
  if (flags.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.valid ? `VALID    ${files[0]}` : `INVALID  ${files[0]}`);
    for (const e of result.errors) console.log(`  error    ${e}`);
    for (const w of result.warnings) console.log(`  warning  ${w}`);
  }
  return result.valid ? 0 : 1;
}

/** Run as a program, and not imported: true through a symlink too, which is how an installed command arrives. */
function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) process.exit(main(process.argv.slice(2)));

#!/usr/bin/env node
// Copyright 2026 GPULogy AI LLC
// SPDX-License-Identifier: Apache-2.0
//
// The GitHub Action: verify the receipts a pull request carries and report
// their grade, checks and gaps. No dependencies; it runs on the Node the
// runner already has.
//
// Everything in a receipt is somebody else's text. A pull request from a fork
// can put anything in one, so nothing from a receipt reaches the report, the
// log or the outputs without being made inert first: see text() and the log
// guard in main().

import { readFileSync, statSync, readdirSync, appendFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyReceipt, parseKeys, shortKey } from "./verify.mjs";

/** Hidden first line of the comment, so the next run updates it instead of adding another. */
export const MARKER = "<!-- run-receipts:report -->";
/** A receipt is a few kilobytes. Anything near this is not one. */
export const MAX_BYTES = 1024 * 1024;
export const MAX_RECEIPTS = 20;
const MAX_CHECK_ROWS = 30;
const MAX_GAP_ROWS = 20;
const MAX_ERROR_ROWS = 20;
/** GitHub refuses a comment over 65,536 characters. */
const MAX_BODY = 60000;

/* ── Making a receipt's text inert ───────────────────────────────────── */

/**
 * A receipt's string as text that is only ever text: no Markdown, no HTML,
 * no link, no mention. Every ASCII punctuation mark becomes a numeric
 * character reference, which Markdown reads as the literal character, and an
 * "@" is followed by a zero-width space so that a name in a receipt cannot
 * notify the person it names.
 */
export function text(value, max = 200) {
  let s = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  if (chars.length > max) s = chars.slice(0, max - 1).join("") + "…";
  return s.replace(/[!-/:-@[-`{-~]/g, (c) => (c === "@" ? "&#64;&#8203;" : `&#${c.charCodeAt(0)};`));
}

/** The same, set as code. */
export const code = (value, max = 300) => `<code>${text(value, max)}</code>`;

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (v) => (Number.isFinite(v) ? v : 0);

/* ── Finding receipts ────────────────────────────────────────────────── */

/**
 * The files an input names. One path per line; a folder stands for the .json
 * files inside it, at any depth. Paths are kept inside the workspace: an
 * input is a workflow author's, but a symlink in a pull request is not.
 */
export function findReceipts(input, workspace) {
  const root = realpathSync(resolve(workspace));
  const inside = (p) => p === root || p.startsWith(root + sep);
  const files = [];
  const problems = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(p);
    }
  };
  for (const line of String(input ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    let real;
    try { real = realpathSync(resolve(root, line)); } catch { continue; }
    if (!inside(real)) { problems.push(`${line} is outside the workspace`); continue; }
    const st = statSync(real);
    if (st.isDirectory()) walk(real, 0);
    else if (st.isFile()) files.push(real);
  }
  const unique = [...new Set(files)];
  if (unique.length > MAX_RECEIPTS) problems.push(`Found ${unique.length} files; only the first ${MAX_RECEIPTS} are checked`);
  return { files: unique.slice(0, MAX_RECEIPTS).map((f) => ({ file: f, name: relative(root, f).split(sep).join("/") })), problems };
}

/** Read and verify one file. A file that cannot be read is an invalid receipt, not a crash. */
export function checkFile({ file, name }, { trustedKeys = [] } = {}) {
  let receipt;
  try {
    if (statSync(file).size > MAX_BYTES) return { name, valid: false, errors: ["file: larger than a receipt can be"], warnings: [], signers: [], receipt: null };
    receipt = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { name, valid: false, errors: [`file: not readable as JSON (${e.name})`], warnings: [], signers: [], receipt: null };
  }
  const res = verifyReceipt(receipt, { trustedKeys });
  return { name, valid: res.valid, errors: res.errors, warnings: res.warnings, signers: res.signers, receipt: res.valid ? receipt : null };
}

/* ── The report ──────────────────────────────────────────────────────── */

export const GRADE_WORDS = {
  verified: "Verified",
  partial: "Partly verified",
  reviewed: "Reviewed",
  "not-visible": "Checks not visible",
  unverified: "Not verified",
  failed: "Failed",
};

const GRADE_MEANS = {
  verified: "Every reviewer that answered ran at least one command, and nothing was failing at the end.",
  partial: "Commands were run, but not by every reviewer.",
  reviewed: "No files changed and no commands were run: the reviewers read the answer.",
  "not-visible": "The reviewers worked where their commands could not be observed.",
  unverified: "Nobody ran a command to test the work.",
  failed: "A check was still failing when the run ended, or a reviewer agreed while its own checks failed.",
};

function verdictLine(r) {
  const v = r.verdict;
  if (!v) return "Nobody reviewed this run.";
  const of = `${v.agreed} of ${count(v.reviewers, "reviewer")} agreed`;
  if (v.outcome === "agreed") return `Agreed: ${of}.`;
  const held = (v.holdouts ?? []).map((h) => `${text(h.name, 60)} (${text(h.stance, 20)})`).join(", ");
  return `${v.outcome === "majority" ? "A majority, not everyone" : "No majority"}: ${of}.${held ? ` Did not agree: ${held}.` : ""}`;
}

function totalsLine(t) {
  const parts = [`${count(num(t.ran), "command")} run`, `${num(t.passed)} passed`, `${num(t.failed)} failed`, `${num(t.failingNow)} failing at the end`];
  if (num(t.resolved)) parts.push(`${t.resolved} caught and fixed`);
  if (num(t.expected)) parts.push(`${t.expected} failed as intended`);
  const who = `${num(t.verifiers)} of ${count(num(t.reviewers), "reviewer")} ran commands`;
  const extra = [];
  if (num(t.notVisible)) extra.push(`${t.notVisible} not visible`);
  if (num(t.contradicted)) extra.push(`${t.contradicted} agreed while failing`);
  return `${parts.join(", ")}. ${who}${extra.length ? ` (${extra.join(", ")})` : ""}.`;
}

function exitCell(c) {
  if (c.state === "blocked") return `blocked${c.missingSetup ? `: ${text(c.missingSetup, 80)}` : ""}`;
  if (c.state === "untested") return "not run";
  if (c.exitCode === null || c.exitCode === undefined) return "not seen";
  return `exit ${text(c.exitCode, 8)}`;
}

/**
 * Who signed, in a sentence. A name here is the workflow's own name for a key
 * it listed, never anything the receipt says about itself.
 */
function signedLine(signers) {
  const trusted = signers.filter((s) => s.trusted);
  if (trusted.length) return `Signed by ${trusted.map((s) => `${s.name ? `${text(s.name, 80)} ` : ""}(${code(shortKey(s.key), 20)})`).join(" and ")}.`;
  if (signers.length) return `Signed by ${signers.map((s) => code(shortKey(s.key), 20)).join(" and ")}, which this workflow does not list as trusted, so the signature says nothing about who wrote it.`;
  return "Not signed.";
}

function receiptSection(res, many) {
  const out = [];
  const heading = many ? "####" : "###";
  if (!res.valid) {
    out.push(`${heading} Run receipt: not valid`, "", `${code(res.name, 200)} does not hold together, so its grade is not shown.`, "");
    for (const e of res.errors.slice(0, MAX_ERROR_ROWS)) out.push(`- ${text(e, 300)}`);
    if (res.errors.length > MAX_ERROR_ROWS) out.push(`- and ${res.errors.length - MAX_ERROR_ROWS} more`);
    return out.join("\n");
  }
  const r = res.receipt;
  out.push(`${heading} Run receipt: ${GRADE_WORDS[r.grade] ?? text(r.grade, 20)}`, "");
  out.push(`${GRADE_MEANS[r.grade] ?? ""}`.trim(), "");
  out.push(`${verdictLine(r)} ${totalsLine(r.totals)}`, "");

  out.push("| Seat | Role | Model | Ended |", "|---|---|---|---|");
  for (const s of r.seats) out.push(`| ${text(s.name, 60)} | ${text(s.role, 12)} | ${code(s.model, 80)} | ${s.role === "reviewer" ? text(s.stance, 20) : ""} |`);
  out.push("");

  if (r.checks.length) {
    out.push(`**Checks (${r.checks.length})**`, "", "| Command | Result | Run by | Where |", "|---|---|---|---|");
    for (const c of r.checks.slice(0, MAX_CHECK_ROWS)) {
      const by = [c.by, ...(c.alsoBy ?? [])].filter(Boolean).map((n) => text(n, 60)).join(", ") || "unknown";
      out.push(`| ${code(c.command, 300)} | ${exitCell(c)} | ${by} | ${text(c.where, 10)}${c.deployed ? ", deployed" : ""} |`);
    }
    if (r.checks.length > MAX_CHECK_ROWS) out.push("", `${r.checks.length - MAX_CHECK_ROWS} more in the file.`);
  } else {
    out.push("**Checks:** none were run.");
  }
  out.push("");

  if (r.gaps.length) {
    out.push("**Not verified**", "");
    for (const g of r.gaps.slice(0, MAX_GAP_ROWS)) out.push(`- ${text(g, 300)}`);
    if (r.gaps.length > MAX_GAP_ROWS) out.push(`- and ${r.gaps.length - MAX_GAP_ROWS} more`);
  } else {
    out.push("**Not verified:** the receipt lists nothing.");
  }
  out.push("");

  const from = `${text(r.producer?.name, 60)}${r.producer?.version ? ` ${text(r.producer.version, 30)}` : ""}`;
  const notes = [`From ${code(res.name, 200)}, written by ${from}, run ended ${text(r.endedAt, 30)}.`];
  notes.push(r.digest ? "Unchanged since its digest was taken." : "It carries no digest, so an edit after it was written would not show.");
  notes.push(signedLine(res.signers ?? []));
  for (const w of res.warnings.slice(0, 5)) notes.push(`Warning: ${text(w, 300)}`);
  out.push(notes.join(" "));
  return out.join("\n");
}

/**
 * The whole report, as Markdown, for the pull request comment and the job
 * summary alike.
 */
export function render(results, problems = []) {
  const parts = [MARKER];
  const many = results.length > 1;
  if (many) {
    const bad = results.filter((r) => !r.valid).length;
    parts.push(`### Run receipts: ${results.length} checked${bad ? `, ${bad} not valid` : ""}`);
  }
  for (const res of results) parts.push(receiptSection(res, many));
  for (const p of problems) parts.push(`Note: ${text(p, 300)}`);
  parts.push("<sub>A valid receipt is consistent with itself and, when it carries a digest, unchanged since it was written. It is the producer's own account: verifying it does not prove the commands were run. Format: <a href=\"https://github.com/gpulogyai/run-receipts\">run receipts</a> 0.1.</sub>");
  let body = parts.join("\n\n");
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY).replace(/&#?\w*$/, "") + "\n\n…the report was cut here; the job summary has the rest.";
  return body;
}

/** Which grades fail the job: the input as a set, unknown words named. */
export function gradeList(input) {
  const words = String(input ?? "").split(/[\s,]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
  const known = Object.keys(GRADE_WORDS);
  return { grades: new Set(words.filter((w) => known.includes(w))), unknown: words.filter((w) => !known.includes(w)) };
}

/** What the job does with these results: 0 to pass, 1 to fail, and why. */
export function decide(results, { failGrades = new Set(), ifNone = "warn", requireSignature = false } = {}) {
  if (!results.length) {
    return { code: ifNone === "error" ? 1 : 0, level: ifNone === "ignore" ? "none" : ifNone === "error" ? "error" : "warning", message: "No run receipt was found at the path given." };
  }
  const bad = results.filter((r) => !r.valid);
  if (bad.length) return { code: 1, level: "error", message: `${count(bad.length, "receipt")} did not verify.` };
  const unsigned = requireSignature ? results.filter((r) => !(r.signers ?? []).some((s) => s.trusted)) : [];
  if (unsigned.length) return { code: 1, level: "error", message: `${count(unsigned.length, "receipt is", "receipts are")} not signed by a trusted key, which this workflow requires.` };
  const failing = results.filter((r) => failGrades.has(r.receipt.grade));
  if (failing.length) return { code: 1, level: "error", message: `${count(failing.length, "receipt")} graded ${[...new Set(failing.map((r) => r.receipt.grade))].join(", ")}, which this workflow does not accept.` };
  return { code: 0, level: "none", message: "" };
}

/* ── Talking to GitHub ───────────────────────────────────────────────── */

/**
 * Put the report on the pull request: update our comment when there is one,
 * add it when there is not. A comment that carries our marker and is not ours
 * to edit (anyone may write one) is passed over for a new comment. A pull
 * request from a fork runs with a token that cannot write at all; the caller
 * reports that as a warning, not as this job failing.
 */
export async function postComment({ api, repo, number, token, body, fetchImpl = fetch }) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", "user-agent": "run-receipts-action" };
  const base = `${api}/repos/${repo}/issues`;
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const res = await fetchImpl(`${base}/${number}/comments?per_page=100&page=${page}`, { headers });
    if (!res.ok) return { done: false, status: res.status };
    const list = await res.json();
    existing = list.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER)) ?? null;
    if (list.length < 100) break;
  }
  if (existing) {
    const res = await fetchImpl(`${base}/comments/${existing.id}`, { method: "PATCH", headers, body: JSON.stringify({ body }) });
    if (res.ok) return { done: true, status: res.status, updated: true };
  }
  const res = await fetchImpl(`${base}/${number}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) });
  return { done: res.ok, status: res.status, updated: false };
}

/* ── Running as the action ───────────────────────────────────────────── */

/** A mistake in the workflow's own inputs: ours to word, so safe to show. */
class SetupError extends Error {}

/** One line of an output file, in the form that cannot be broken out of. */
function outputLine(name, value) {
  const fence = `rr_${randomUUID()}`;
  return `${name}<<${fence}\n${String(value)}\n${fence}\n`;
}

export async function main(env = process.env, { log = console.log, fetchImpl = fetch } = {}) {
  // Nothing printed below can be read by the runner as a command: workflow
  // commands are switched off for the length of the run and back on at the
  // end, behind a word nobody else knows.
  const guard = `rr_${randomUUID()}`;
  const annotations = [];
  const annotate = (level, message) => { if (level !== "none") annotations.push(`::${level} title=Run receipt::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`); };
  log(`::stop-commands::${guard}`);
  let exit = 0;
  try {
    const workspace = env.GITHUB_WORKSPACE || process.cwd();
    const { files, problems } = findReceipts(env.RR_PATH, workspace);
    const trusted = parseKeys(env.RR_TRUSTED_KEYS);
    for (const p of trusted.problems) problems.push(`trusted-keys, ${p}`);
    const requireSignature = env.RR_REQUIRE_SIGNATURE === "true";
    if (requireSignature && !trusted.keys.length) throw new SetupError("require-signature needs trusted-keys: a signature only means something from a key this workflow trusts.");
    const results = files.map((f) => checkFile(f, { trustedKeys: trusted.keys }));
    const { grades, unknown } = gradeList(env.RR_FAIL_ON_GRADE);
    for (const w of unknown) problems.push(`fail-on-grade names "${w}", which is not a grade`);
    const ifNone = ["error", "warn", "ignore"].includes(env.RR_IF_NO_RECEIPT) ? env.RR_IF_NO_RECEIPT : "warn";
    const verdict = decide(results, { failGrades: grades, ifNone, requireSignature });
    exit = verdict.code;
    annotate(verdict.level, verdict.message);
    for (const p of problems) annotate("warning", p);

    for (const r of results) {
      log(`${r.valid ? "VALID  " : "INVALID"}  ${r.name}${r.valid ? `  ${r.receipt.grade}` : ""}`);
      for (const e of r.errors) log(`  error    ${e}`);
      for (const w of r.warnings) log(`  warning  ${w}`);
    }
    if (!results.length) log(verdict.message);

    const body = results.length ? render(results, problems) : "";
    if (body && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, body + "\n");
    if (env.GITHUB_OUTPUT) {
      const first = results.find((r) => r.valid);
      appendFileSync(env.GITHUB_OUTPUT,
        outputLine("count", results.length)
        + outputLine("valid", results.length > 0 && results.every((r) => r.valid))
        + outputLine("grade", results.length === 1 && first ? first.receipt.grade : "")
        + outputLine("grades", results.filter((r) => r.valid).map((r) => r.receipt.grade).join(","))
        + outputLine("signed", results.length > 0 && results.every((r) => r.valid && r.signers.some((s) => s.trusted))));
    }

    if (body && env.RR_COMMENT !== "false") {
      let number = null;
      try { number = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).pull_request?.number ?? null; } catch { /* not a pull request */ }
      if (number && env.RR_TOKEN && env.GITHUB_REPOSITORY) {
        try {
          const sent = await postComment({ api: env.GITHUB_API_URL || "https://api.github.com", repo: env.GITHUB_REPOSITORY, number, token: env.RR_TOKEN, body, fetchImpl });
          if (sent.done) log(`Report ${sent.updated ? "updated" : "posted"} on pull request ${number}.`);
          else annotate("warning", `The report could not be posted on the pull request (HTTP ${sent.status}). The job needs "pull-requests: write", and a pull request from a fork cannot have it; the report is in the job summary.`);
        } catch (e) {
          annotate("warning", `The report could not be posted on the pull request (${e.name}). It is in the job summary.`);
        }
      }
    }
  } catch (e) {
    exit = 1;
    annotate("error", e instanceof SetupError ? e.message : `The action failed: ${e.name}`);
    log(String(e?.stack ?? e));
  } finally {
    log(`::${guard}::`);
  }
  for (const a of annotations) log(a);
  return exit;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) main().then((c) => process.exit(c));

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReceipt, validateSchema, loadSchema, digestOf, canonical, gradeOf } from "./verify.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const example = (name) => JSON.parse(readFileSync(join(here, "examples", name), "utf8"));
const good = () => example("agreed-verified.json");
const split = () => example("not-unanimous-failing.json");
/** A receipt changed by `edit`, with its digest retaken so only the edit is under test. */
const changed = (base, edit) => { const r = base(); edit(r); if (r.digest) r.digest = digestOf(r); return r; };
const rules = (r) => verifyReceipt(r).errors.map((e) => e.split(":")[0]);

test("both examples are valid and carry a matching digest", () => {
  for (const r of [good(), split()]) {
    const res = verifyReceipt(r);
    assert.deepEqual(res.errors, []);
    assert.equal(r.digest, digestOf(r));
    assert.deepEqual(res.warnings, []);
  }
});

test("schema: a missing field, an unknown field and a wrong type are each named", () => {
  const schema = loadSchema();
  const r = good(); delete r.grade; r.prompt = "secret"; r.tokens = "many";
  const errs = validateSchema(r, schema);
  assert.ok(errs.some((e) => e.startsWith("$.grade: is required")));
  assert.ok(errs.some((e) => e.startsWith("$.prompt: is not part of the format")));
  assert.ok(errs.some((e) => e.startsWith("$.tokens: must be integer")));
  assert.equal(verifyReceipt(r).valid, false);
});

test("schema: bounds, enums and the date form hold", () => {
  assert.ok(rules(changed(good, (r) => { r.endedAt = "yesterday"; })).includes("schema"));
  assert.ok(rules(changed(good, (r) => { r.checks[0].where = "build-host.local"; })).includes("schema"));
  assert.ok(rules(changed(good, (r) => { r.checks[0].command = "x".repeat(301); })).includes("schema"));
  assert.ok(rules(changed(good, (r) => { r.costUsd = -1; })).includes("schema"));
  assert.ok(rules(changed(good, (r) => { r.receiptVersion = "0.2"; })).includes("schema"));
});

test("seats: unique names, a lead, stances where they belong", () => {
  assert.ok(rules(changed(good, (r) => { r.seats[2].name = "Gemini"; })).includes("S1"));
  assert.ok(rules(changed(good, (r) => { r.seats[0].role = "reviewer"; r.seats[0].stance = "agreed"; })).includes("S2"));
  assert.ok(rules(changed(good, (r) => { r.seats[1].timeouts = 3; })).includes("S3"));
  assert.ok(rules(changed(good, (r) => { delete r.seats[1].stance; })).includes("S4"));
  assert.ok(rules(changed(good, (r) => { r.seats[0].stance = "agreed"; })).includes("S4"));
  assert.ok(rules(changed(split, (r) => { r.seats[0].costUsd = 1; })).includes("S5"));
});

test("verdict: follows from where each reviewer ended", () => {
  // An objector cannot sit under an agreed outcome.
  assert.ok(rules(changed(split, (r) => { r.verdict.outcome = "agreed"; })).includes("V4"));
  // The count and the holdouts are read off the seats.
  assert.ok(rules(changed(good, (r) => { r.verdict.agreed = 3; })).includes("V2"));
  assert.ok(rules(changed(split, (r) => { r.verdict.holdouts.pop(); })).includes("V3"));
  // One of three agreeing is no majority; two of three is.
  assert.ok(rules(changed(split, (r) => { r.verdict.outcome = "majority"; })).includes("V4"));
  const two = changed(split, (r) => { r.seats[1].stance = "agreed"; r.verdict = { outcome: "majority", agreed: 2, reviewers: 3, holdouts: [{ name: "Grok", stance: "unavailable" }] }; });
  assert.ok(!rules(two).some((x) => x.startsWith("V")));
  // A lead alone has no verdict; reviewers must have one.
  assert.ok(rules(changed(good, (r) => { r.verdict = null; })).includes("V1"));
});

test("verdict: agreed without a seat that could not answer, unless a check still fails", () => {
  const base = () => changed(split, (r) => {
    r.seats[1].stance = "agreed";
    r.verdict = { outcome: "agreed", agreed: 2, reviewers: 2, holdouts: [{ name: "Grok", stance: "unavailable" }] };
    r.totals = { ...r.totals, failed: 0, failingNow: 0, passed: 3, verifiers: 1 };
    r.checks = [];
    r.grade = "partial";
  });
  assert.deepEqual(verifyReceipt(base()).errors, []);
  const failing = changed(base, (r) => { r.totals.failed = 1; r.totals.failingNow = 1; r.totals.passed = 2; r.grade = "failed"; });
  assert.deepEqual(rules(failing), ["V4"]);
  assert.ok(rules(changed(base, (r) => { r.verdict.reviewers = 3; })).includes("V5"));
});

test("totals: counts cannot exceed what they are counted from", () => {
  assert.ok(rules(changed(good, (r) => { r.totals.reviewers = 3; })).includes("T1"));
  assert.ok(rules(changed(good, (r) => { r.totals.verifiers = 3; })).includes("T2"));
  assert.ok(rules(changed(good, (r) => { r.totals.notVisible = 1; })).includes("T2"));
  assert.ok(rules(changed(good, (r) => { r.totals.passed = 9; })).includes("T3"));
  assert.ok(rules(changed(good, (r) => { r.totals.failingNow = 2; })).includes("T4"));
  assert.ok(rules(changed(good, (r) => { r.totals.resolved = 2; })).includes("T4"));
  assert.ok(rules(changed(good, (r) => { r.totals.verifiers = 0; })).includes("T5"));
});

test("grade: the table, and a receipt that claims more than it earned", () => {
  const t = { reviewers: 2, verifiers: 2, contradicted: 0, ran: 4, passed: 4, failed: 0, failingNow: 0 };
  assert.equal(gradeOf(t), "verified");
  assert.equal(gradeOf({ ...t, verifiers: 1 }), "partial");
  assert.equal(gradeOf({ ...t, failed: 1, failingNow: 1 }), "failed");
  assert.equal(gradeOf({ ...t, failed: 1, failingNow: 0 }), "verified");
  assert.equal(gradeOf({ ...t, contradicted: 1 }), "failed");
  const none = { ...t, verifiers: 0, ran: 0, passed: 0 };
  assert.equal(gradeOf({ ...none, filesChanged: 0, notVisible: 2 }), "reviewed");
  assert.equal(gradeOf({ ...none, filesChanged: 2, notVisible: 2 }), "not-visible");
  assert.equal(gradeOf({ ...none, filesChanged: 2 }), "unverified");
  assert.equal(gradeOf(none), "unverified");
  assert.deepEqual(rules(changed(split, (r) => { r.grade = "verified"; })), ["G1"]);
});

test("checks: who ran them, and a state that matches the exit code", () => {
  assert.ok(rules(changed(good, (r) => { r.checks[0].by = "Mistral"; })).includes("C1"));
  assert.ok(rules(changed(good, (r) => { r.checks[0].alsoBy = ["Mistral"]; })).includes("C1"));
  assert.ok(rules(changed(good, (r) => { r.checks[0].state = "reproduced"; })).includes("C2"));
  assert.ok(rules(changed(split, (r) => { r.checks[1].missingSetup = null; })).includes("C3"));
  assert.ok(rules(changed(split, (r) => { r.checks[0].missingSetup = "a tool it needs is not installed"; })).includes("C3"));
  assert.ok(rules(changed(split, (r) => { r.checks[2].exitCode = 2; })).includes("C4"));
});

test("warnings do not make a receipt invalid", () => {
  const r = changed(good, (x) => { x.totals.ran = 2; x.totals.passed = 1; x.costUsd = 9; });
  const res = verifyReceipt(r);
  assert.equal(res.valid, true);
  assert.ok(res.warnings.some((w) => w.startsWith("C5")));
  assert.ok(res.warnings.some((w) => w.startsWith("M1")));
  const bare = good(); delete bare.digest;
  assert.ok(verifyReceipt(bare).warnings.some((w) => w.startsWith("D2")));
  assert.ok(rules(changed(good, (x) => { x.firstReplyMs = x.durationMs + 1; })).includes("M2"));
});

test("digest: any edit breaks it; key order and whitespace do not", () => {
  const r = good();
  r.totals.passed = 3;
  assert.deepEqual(rules(r), ["D1"]);
  const reordered = Object.fromEntries(Object.entries(good()).reverse());
  assert.equal(digestOf(reordered), good().digest);
  assert.equal(canonical({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
});

test("command line: exit codes and output", () => {
  const cli = (...args) => spawnSync(process.execPath, [join(here, "verify.mjs"), ...args], { encoding: "utf8" });
  const ok = cli(join(here, "examples", "agreed-verified.json"));
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^VALID/);
  const dir = mkdtempSync(join(tmpdir(), "receipt-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify(changed(split, (r) => { r.grade = "verified"; })));
  const no = cli("--json", bad);
  assert.equal(no.status, 1);
  assert.equal(JSON.parse(no.stdout).valid, false);
  assert.equal(cli("--digest", join(here, "examples", "agreed-verified.json")).stdout.trim(), good().digest);
  assert.equal(cli().status, 2);
  assert.equal(cli(join(dir, "missing.json")).status, 2);
  writeFileSync(bad, "not json");
  assert.equal(cli(bad).status, 2);
});

test("command line: runs through a symlink, as an installed command does", () => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-bin-"));
  const link = join(dir, "run-receipt-verify");
  symlinkSync(join(here, "verify.mjs"), link);
  const res = spawnSync(process.execPath, [link, join(here, "examples", "agreed-verified.json")], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^VALID/);
  const bad = spawnSync(process.execPath, [link], { encoding: "utf8" });
  assert.equal(bad.status, 2);
});

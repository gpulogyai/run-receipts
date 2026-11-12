import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReceipt, digestOf } from "./verify.mjs";
import { buildReceipt, sampleRun, mask } from "./examples/produce.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");
/** The sample run, changed by `edit`. */
const run = (edit = () => {}) => { const r = structuredClone(sampleRun); edit(r); return r; };
const seat = (r, name) => r.seats.find((s) => s.name === name);
/** A receipt for a run, which must verify with nothing to say. */
function receiptOf(r) {
  const receipt = buildReceipt(r);
  const res = verifyReceipt(receipt);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
  return receipt;
}

test("example producer: the sample run is verified, counted run by run, and masked", () => {
  const r = receiptOf(run());
  assert.equal(r.grade, "verified");
  assert.deepEqual(r.verdict, { outcome: "agreed", agreed: 2, reviewers: 2, holdouts: [] });
  assert.deepEqual(r.totals, { reviewers: 2, verifiers: 2, notVisible: 0, contradicted: 0, ran: 4, passed: 3, failed: 1, failingNow: 0, resolved: 1, filesChanged: 2 });
  assert.equal(r.checks.length, 2, "one check per command, as it stood at the end");
  assert.ok(r.checks.every((c) => c.state === "checked"));
  assert.ok(!JSON.stringify(r).includes("abc123"), "a credential in a command reached the receipt");
  assert.equal(r.digest, digestOf(r));
  assert.equal(r.costUsd, 0.29);
});

test("example producer: a reviewer that objects makes a majority or none, never agreed", () => {
  const two = receiptOf(run((r) => { seat(r, "Second reviewer").stance = "objected"; }));
  assert.deepEqual(two.verdict, { outcome: "none", agreed: 1, reviewers: 2, holdouts: [{ name: "Second reviewer", stance: "objected" }] });
  const three = receiptOf(run((r) => {
    r.seats.push({ ...seat(r, "Second reviewer"), name: "Third reviewer", stance: "silent" });
  }));
  assert.equal(three.verdict.outcome, "majority");
  assert.equal(three.grade, "partial", "the third reviewer ran nothing");
});

test("example producer: a check still failing at the end fails the run", () => {
  const r = receiptOf(run((x) => {
    x.commands.push({ by: "Second reviewer", command: "npm run lint", exitCode: 2, result: "3 problems" });
    seat(x, "Second reviewer").stance = "objected";
  }));
  assert.equal(r.grade, "failed");
  assert.equal(r.totals.failingNow, 1);
  assert.equal(r.checks.find((c) => c.command === "npm run lint").state, "reproduced");
});

test("example producer: agreeing while your own check fails is counted as contradicted", () => {
  const r = receiptOf(run((x) => { x.commands.push({ by: "Second reviewer", command: "npm run lint", exitCode: 2 }); }));
  assert.equal(r.totals.contradicted, 1);
  assert.equal(r.grade, "failed");
});

test("example producer: nothing run is reviewed, unverified or not visible, by what was measured", () => {
  const none = (edit) => receiptOf(run((x) => { x.commands = []; edit(x); }));
  assert.equal(none((x) => { x.filesChanged = 0; }).grade, "reviewed");
  assert.equal(none(() => {}).grade, "unverified");
  const unmeasured = none((x) => { delete x.filesChanged; });
  assert.equal(unmeasured.grade, "unverified");
  assert.ok(!("filesChanged" in unmeasured.totals), "not measured is left out, not written as 0");
  const hidden = none((x) => { for (const s of x.seats) if (s.role === "reviewer") s.commandsVisible = false; });
  assert.equal(hidden.grade, "not-visible");
  assert.equal(hidden.totals.notVisible, 2);
});

test("example producer: a reviewer that never answered is a seat and a holdout, and is not counted", () => {
  const r = receiptOf(run((x) => {
    Object.assign(seat(x, "Second reviewer"), { stance: "unavailable", turns: 0, errors: 2, timeouts: 2 });
    x.commands = x.commands.filter((c) => c.by !== "Second reviewer");
  }));
  assert.equal(r.totals.reviewers, 1);
  assert.deepEqual(r.verdict, { outcome: "agreed", agreed: 1, reviewers: 1, holdouts: [{ name: "Second reviewer", stance: "unavailable" }] });
  const failing = receiptOf(run((x) => {
    seat(x, "Second reviewer").stance = "unavailable";
    x.commands = [{ by: "First reviewer", command: "npm test", exitCode: 1 }];
    seat(x, "First reviewer").stance = "agreed";
  }));
  assert.equal(failing.verdict.outcome, "none", "nobody may be missing from an agreement while a check is failing");
  assert.equal(failing.verdict.reviewers, 2);
});

test("example producer: commands from the lead or an absent reviewer are not counted", () => {
  const r = receiptOf(run((x) => {
    x.commands = [{ by: "Builder", command: "npm test", exitCode: 0 }];
  }));
  assert.equal(r.totals.ran, 0);
  assert.deepEqual(r.checks, []);
  assert.equal(r.grade, "unverified");
});

test("example producer: a run with no reviewers has no verdict", () => {
  const r = receiptOf(run((x) => { x.seats = x.seats.filter((s) => s.role === "lead"); x.commands = []; }));
  assert.equal(r.verdict, null);
  assert.equal(r.grade, "unverified");
});

test("example producer: blocked and unseen results are said as such, and long text is cut to one line", () => {
  const r = receiptOf(run((x) => {
    x.commands = [
      { by: "First reviewer", command: "pytest --db postgres", exitCode: 1, missingSetup: "a database was not reachable", result: "line one\nline two" },
      { by: "Second reviewer", command: `echo ${"x".repeat(400)}`, exitCode: null },
    ];
    seat(x, "First reviewer").stance = "objected";
  }));
  assert.deepEqual(r.checks.map((c) => [c.state, c.exitCode, c.missingSetup]), [["blocked", 1, "a database was not reachable"], ["unknown", null, null]]);
  assert.equal(r.checks[0].result, "line one line two");
  assert.equal(r.checks[1].command.length, 300);
});

test("example producer: the starting mask covers a named credential, a bearer token and a home folder", () => {
  assert.equal(mask("DB_PASSWORD=hunter2 run"), "DB_PASSWORD=*** run");
  assert.equal(mask("curl -H 'Authorization: Bearer abcdef123456'"), "curl -H 'Authorization: Bearer ***'");
  assert.equal(mask("cat /Users/pat/project/a.txt /home/sam/b"), "cat ~/project/a.txt ~/b");
  assert.equal(mask("npm test"), "npm test");
});

test("example producer: run as a program, it prints a receipt the verifier accepts", () => {
  const out = spawnSync(process.execPath, [join(here, "examples", "produce.mjs")], { encoding: "utf8" });
  assert.equal(out.status, 0);
  assert.deepEqual(verifyReceipt(JSON.parse(out.stdout)).errors, []);
});

/* ── The guide itself ────────────────────────────────────────────────── */

const guide = read("PRODUCERS.md");

test("guide: every whole receipt it shows is valid", () => {
  const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('"receiptVersion"'));
  assert.ok(blocks.length >= 1);
  for (const b of blocks) {
    const receipt = JSON.parse(b);
    assert.deepEqual(verifyReceipt(receipt).errors, []);
    assert.equal(receipt.grade, "unverified");
  }
});

test("guide: every rule it names is a rule in the specification", () => {
  const spec = read("SPEC.md");
  const named = new Set([...guide.matchAll(/\b([SVTGCMD]\d)\b/g)].map((m) => m[1]));
  assert.ok(named.size >= 8);
  for (const id of named) assert.match(spec, new RegExp(`\\b${id}[. ]`), `${id} is not in SPEC.md`);
});

test("guide: every file it links to exists, and the README section it points at is there", () => {
  for (const [, target] of guide.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (/^https?:/.test(target)) continue;
    assert.ok(existsSync(join(here, target)), `${target} is linked and missing`);
  }
  assert.match(read("README.md"), /^## Verify receipts on pull requests$/m);
});

test("guide: the grade table says what the verifier does", () => {
  for (const g of ["failed", "verified", "partial", "reviewed", "not-visible", "unverified"]) assert.match(guide, new RegExp(`\\| \`${g}\` \\|`));
});

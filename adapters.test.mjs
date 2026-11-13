import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReceipt } from "./verify.mjs";
import { buildReceipt, sampleRun } from "./examples/produce.mjs";
import { parseLog, runFromEvents, receiptFromEvents, receiptFromLog, record } from "./adapters/events.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const cli = join(here, "adapters", "cli.mjs");
const exampleLog = join(here, "adapters", "example-run.jsonl");
const scratch = () => mkdtempSync(join(tmpdir(), "run-receipts-"));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

/** A small log: a lead and the reviewers given, then `more`, then the end. */
function log(reviewers, more = []) {
  return [
    { event: "start", at: "2026-11-12T09:00:00Z", producer: { name: "a-tool" } },
    { event: "seat", name: "Lead", role: "lead", model: "model-a" },
    ...reviewers.map((name) => ({ event: "seat", name, role: "reviewer", model: "model-b" })),
    { event: "turn", seat: "Lead", durationMs: 1000, costUsd: 0.01, tokens: 500 },
    ...more,
    { event: "end", at: "2026-11-12T09:01:00Z" },
  ];
}
/** The receipt for a log, which must verify with nothing to say. */
function receiptOf(events) {
  const receipt = receiptFromEvents(events);
  const res = verifyReceipt(receipt);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
  return receipt;
}

test("events: the example log gives the receipt the example producer gives for the same run", () => {
  assert.deepEqual(receiptFromLog(exampleLog), buildReceipt(sampleRun));
});

test("events: the lead's own commands are not checks", () => {
  const events = parseLog(readFileSync(exampleLog, "utf8"));
  assert.ok(events.some((e) => e.event === "command" && e.by === "Builder"), "the example has one");
  const r = receiptFromEvents(events);
  assert.equal(r.totals.ran, 4);
  assert.ok(r.checks.every((c) => c.by !== "Builder"));
});

test("events: a run nobody reviewed is unverified, and says why", () => {
  const r = receiptOf(log([]));
  assert.equal(r.verdict, null);
  assert.equal(r.grade, "unverified");
  assert.deepEqual(r.gaps, ["Nobody reviewed this run"]);
  assert.equal(r.durationMs, 60000, "taken from the two times");
  assert.equal(r.tokens, 500);
});

test("events: a reviewer given no stance is silent if it answered, unavailable if it never did", () => {
  const r = receiptOf(log(["Answered", "Absent"], [
    { event: "turn", seat: "Answered", durationMs: 10 },
    { event: "turn", seat: "Absent", failed: true, timeout: true },
  ]));
  const seat = (name) => r.seats.find((s) => s.name === name);
  assert.equal(seat("Answered").stance, "silent");
  assert.equal(seat("Absent").stance, "unavailable");
  assert.deepEqual([seat("Absent").turns, seat("Absent").errors, seat("Absent").timeouts], [0, 1, 1]);
  assert.equal(r.verdict.outcome, "none");
  assert.ok(r.gaps.includes("No reviewer ran a command to test the work"));
});

test("events: the last stance said is the one that counts, and a check still failing fails the run", () => {
  const r = receiptOf(log(["R"], [
    { event: "turn", seat: "R" },
    { event: "stance", seat: "R", stance: "agreed" },
    { event: "command", by: "R", command: "make test", exitCode: 2, result: "boom" },
    { event: "stance", seat: "R", stance: "objected" },
  ]));
  assert.equal(r.seats[1].stance, "objected");
  assert.equal(r.grade, "failed");
  assert.equal(r.checks[0].state, "reproduced");
});

test("events: agreeing while its own check is failing is counted as a contradiction", () => {
  const r = receiptOf(log(["R"], [
    { event: "turn", seat: "R" },
    { event: "command", by: "R", command: "make test", exitCode: 1 },
    { event: "stance", seat: "R", stance: "agreed" },
  ]));
  assert.equal(r.totals.contradicted, 1);
  assert.equal(r.grade, "failed");
});

test("events: a seat on a flat plan costs nothing, whatever the log says", () => {
  const events = log([]);
  events[1].costBasis = "subscription";
  const r = receiptOf(events);
  assert.equal(r.seats[0].costUsd, 0);
  assert.equal(r.costUsd, 0);
});

test("events: a blocked command, and one whose end was never seen", () => {
  const r = receiptOf(log(["R"], [
    { event: "turn", seat: "R" },
    { event: "command", by: "R", command: "psql -c 'select 1'", exitCode: null, missingSetup: "no database" },
    { event: "command", by: "R", command: "sleep 100", exitCode: null },
  ]));
  assert.deepEqual(r.checks.map((c) => c.state), ["blocked", "unknown"]);
});

test("events: a log that has to be guessed at is refused, and the line is named", () => {
  const broken = (edit, why) => {
    const events = log(["R"], [{ event: "turn", seat: "R" }]).map((e, i) => ({ ...e, line: i + 1 }));
    edit(events);
    assert.throws(() => runFromEvents(events), why);
  };
  broken((e) => e.pop(), /no end event/);
  broken((e) => e.shift(), /line 2: the log must begin with a start event/);
  broken((e) => { e[0].producer = {}; }, /line 1: start needs producer.name/);
  broken((e) => { e[2].name = "Lead"; }, /line 3: two seats are named "Lead"/);
  broken((e) => { e[2].role = "judge"; }, /line 3: a seat's role is lead or reviewer/);
  broken((e) => { e[4].seat = "Nobody"; }, /line 5: no seat named "Nobody"/);
  broken((e) => { e.splice(5, 0, { event: "stance", seat: "Lead", stance: "agreed", line: 9 }); }, /line 9: only a reviewer has a stance/);
  broken((e) => { e.splice(5, 0, { event: "stance", seat: "R", stance: "maybe", line: 9 }); }, /line 9: a stance is/);
  broken((e) => { e.splice(5, 0, { event: "command", by: "R", command: "x", where: "my-laptop", line: 9 }); }, /line 9: where is/);
  broken((e) => { e.splice(5, 0, { event: "hello", line: 9 }); }, /line 9: unknown event "hello"/);
  broken((e) => { delete e[e.length - 1].at; }, /end needs `at`/);
  broken((e) => { delete e[0].at; }, /end needs durationMs/);
  broken((e) => { e[1].role = "reviewer"; }, /no lead seat/);
  broken((e) => { e.push({ event: "gap", text: "late", line: 12 }); }, /line 12: the run has already ended/);
  assert.throws(() => parseLog('{"event":"start"}\nnot json\n'), /line 2: not JSON/);
  assert.throws(() => parseLog("[1]\n"), /line 1: not an event/);
});

test("record: a line is added with the time, and credentials are masked before it is written", () => {
  const file = join(scratch(), "run.jsonl");
  record(file, { event: "command", by: "R", command: "API_TOKEN=abc123 curl -H 'Authorization: Bearer abcdefghijkl' https://example.com", exitCode: 0, result: "/Users/someone/project ok" });
  const [line] = parseLog(readFileSync(file, "utf8"));
  assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(!readFileSync(file, "utf8").includes("abc123"));
  assert.ok(!readFileSync(file, "utf8").includes("abcdefghijkl"));
  assert.equal(line.result, "~/project ok");
});

test("command line: events prints a receipt that verifies, or writes it where asked", () => {
  const printed = run("events", exampleLog);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(verifyReceipt(JSON.parse(printed.stdout)).valid, true);
  const out = join(scratch(), "receipt.json");
  assert.equal(run("events", exampleLog, "--out", out).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), JSON.parse(printed.stdout));
});

test("command line: a bad log writes no receipt and says which line", () => {
  const dir = scratch();
  const file = join(dir, "run.jsonl");
  writeFileSync(file, '{"event":"start","producer":{"name":"t"}}\n{"event":"turn","seat":"Ghost"}\n');
  const out = join(dir, "receipt.json");
  const res = run("events", file, "--out", out);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /line 2: no seat named "Ghost"/);
  assert.equal(existsSync(out), false);
  assert.equal(run("events").status, 2);
  assert.equal(run("nonsense").status, 2);
});

test("command line: exec passes output and exit code through, and records how the command ended", () => {
  const file = join(scratch(), "run.jsonl");
  const note = (event) => assert.equal(run("note", "--log", file, JSON.stringify(event)).status, 0);
  note({ event: "start", producer: { name: "a-tool" } });
  note({ event: "seat", name: "Lead", role: "lead", model: "model-a" });
  note({ event: "seat", name: "R", role: "reviewer", model: "model-b" });
  note({ event: "turn", seat: "R" });

  const passed = run("exec", "--log", file, "--by", "R", "--purpose", "Say hello", "--", process.execPath, "-e", "console.log('first'); console.log('\\u001b[32mall good\\u001b[0m')");
  assert.equal(passed.status, 0);
  assert.match(passed.stdout, /first/);
  const failed = run("exec", "--log", file, "--by", "R", "--", process.execPath, "-e", "console.error('it broke'); process.exit(3)");
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /it broke/);
  const missing = run("exec", "--log", file, "--by", "R", "--", "a-command-nobody-has-installed");
  assert.equal(missing.status, 127);

  note({ event: "stance", seat: "R", stance: "objected" });
  note({ event: "end", durationMs: 5000 });
  const r = receiptOf(parseLog(readFileSync(file, "utf8")));
  assert.deepEqual(r.checks.map((c) => [c.exitCode, c.state, c.result]), [
    [0, "checked", "all good"],
    [3, "reproduced", "it broke"],
    [null, "blocked", ""],
  ]);
  assert.equal(r.checks[0].purpose, "Say hello");
  assert.equal(r.checks[2].missingSetup, "a-command-nobody-has-installed is not installed");
  assert.match(r.checks[1].command, /-e 'console\.error/, "written as a shell would need it");
  assert.equal(r.grade, "failed");
  assert.equal(run("exec", "--log", file, "--", "true").status, 2, "a seat must be named");
});

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["--version"]).status === 0);

test("python: a log written by run_log.py becomes a receipt that verifies", { skip: python ? false : "no python here" }, () => {
  const file = join(scratch(), "run.jsonl");
  const script = `
import sys
sys.path.insert(0, sys.argv[1])
from run_log import RunLog
log = RunLog(sys.argv[2], producer="py-tool", version="1.2.0", revision="abc1234")
log.seat("Builder", role="lead", model="model-a")
log.seat("Reviewer", role="reviewer", model="model-b", cost_basis="subscription")
log.seat("Hidden", role="reviewer", model="model-c", commands_visible=False)
log.turn("Builder", duration_ms=52000, cost_usd=0.21, tokens=30000)
log.turn("Reviewer", duration_ms=9000, cost_usd=0.5, tokens=4000)
log.turn("Hidden", timeout=True)
log.command("Reviewer", "DB_PASSWORD=hunter2 pytest -q", exit_code=0, result="18 passed", purpose="Run the tests")
log.stance("Reviewer", "agreed")
log.gap("Checked locally only")
log.end(files_changed=2, duration_ms=70000)
`;
  const made = spawnSync(python, ["-c", script, join(here, "adapters"), file], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  assert.ok(!readFileSync(file, "utf8").includes("hunter2"), "masked before it is written");
  const r = receiptOf(parseLog(readFileSync(file, "utf8")));
  assert.deepEqual(r.producer, { name: "py-tool", version: "1.2.0" });
  assert.equal(r.revision, "abc1234");
  assert.equal(r.costUsd, 0.21, "the seat on a flat plan added nothing");
  assert.equal(r.tokens, 34000);
  assert.deepEqual(r.verdict, { outcome: "agreed", agreed: 1, reviewers: 1, holdouts: [{ name: "Hidden", stance: "unavailable" }] });
  assert.equal(r.grade, "verified");
  assert.equal(r.checks[0].command, "DB_PASSWORD=*** pytest -q");
});

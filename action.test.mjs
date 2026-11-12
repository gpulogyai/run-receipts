import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReceipt, digestOf } from "./verify.mjs";
import { MARKER, MAX_RECEIPTS, text, code, findReceipts, checkFile, render, gradeList, decide, postComment, main, GRADE_WORDS } from "./action.mjs";
import { generateKey, signReceipt } from "./sign.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const example = (name) => JSON.parse(readFileSync(join(here, "examples", name), "utf8"));
const good = () => example("agreed-verified.json");
const split = () => example("not-unanimous-failing.json");
const changed = (base, edit) => { const r = base(); edit(r); if (r.digest) r.digest = digestOf(r); return r; };
const result = (receipt, name = "receipt.json") => { const v = verifyReceipt(receipt); return { name, ...v, receipt: v.valid ? receipt : null }; };

/** A workspace on disk holding the given files. */
function workspace(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rr-action-")));
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
}

/** A stand-in for fetch that answers from a list and remembers what it was asked. */
function fakeFetch(answers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const a = answers.shift() ?? { status: 500 };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json ?? [] };
  };
  return { impl, calls };
}

/* ── Inert text ──────────────────────────────────────────────────────── */

test("text: nothing a receipt says can become Markdown, HTML, a link or a mention", () => {
  const hostile = "</code><img src=x onerror=1> [click](https://evil.example) **bold** `tick` | pipe @octocat #1 <!-- x -->";
  const out = text(hostile, 500);
  const bare = out.replace(/&#\d+;/g, "");
  for (const raw of ["<", ">", "[", "]", "(", ")", "*", "`", "|", "#", "!", ":", "/", "&", ";"]) assert.ok(!bare.includes(raw), `left a raw ${raw}`);
  assert.ok(!/@[A-Za-z0-9]/.test(out), "a name after @ would notify that person");
  assert.match(out, /&#64;&#8203;octocat/);
  assert.equal(text("plain words 123"), "plain words 123");
});

test("text: line breaks and control characters cannot start a new line of the report", () => {
  const out = text("one\n| new | row |\r\n::error::x\u2028two\u0000three");
  assert.ok(!/[\r\n\u2028\u0000]/.test(out));
  assert.match(out, /^one /);
});

test("text: cut to length by character, before it is encoded", () => {
  assert.equal(text("abcdef", 4), "abc…");
  assert.equal(Array.from(text("é".repeat(10), 5)).length, 5);
  assert.equal(code("a<b"), "<code>a&#60;b</code>");
  assert.equal(text(null), "");
  assert.equal(text(0), "0");
});

/* ── The report ──────────────────────────────────────────────────────── */

test("render: a valid receipt shows its grade, verdict, seats, checks and gaps", () => {
  const body = render([result(good(), "examples/agreed-verified.json")]);
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /### Run receipt: Verified/);
  assert.match(body, /Agreed: 2 of 2 reviewers agreed\./);
  assert.match(body, /5 commands run, 4 passed, 1 failed, 0 failing at the end, 1 caught and fixed\./);
  assert.match(body, /\| <code>npm test<\/code> \| exit 0 \| Gemini, ChatGPT \| local \|/);
  assert.match(body, /local, deployed/);
  assert.match(body, /- Behaviour under production load/);
  assert.match(body, /Unchanged since its digest was taken\./);
  assert.match(body, /does not prove the commands were run/);
});

test("render: holdouts, a blocked check and a result nobody saw are each said in words", () => {
  const body = render([result(split())]);
  assert.match(body, /### Run receipt: Failed/);
  assert.match(body, /No majority: 1 of 3 reviewers agreed\. Did not agree: Claude \(objected\), Grok \(unavailable\)\./);
  assert.match(body, /\| blocked: a service it needs was not reachable \|/);
  assert.match(body, /\| not seen \| unknown \| ci \|/);
  assert.match(body, /1 of 2 reviewers ran commands \(1 not visible\)\./);
});

test("render: every grade has words of its own", () => {
  assert.deepEqual(Object.keys(GRADE_WORDS).sort(), ["failed", "not-visible", "partial", "reviewed", "unverified", "verified"]);
});

test("render: a receipt that does not verify shows the rules it broke and never a grade", () => {
  const r = good(); r.grade = "failed";
  const body = render([result(r, "edited.json")]);
  assert.match(body, /### Run receipt: not valid/);
  assert.match(body, /- G1&#58; /);
  assert.match(body, /- D1&#58; /);
  assert.ok(!/Run receipt: (Verified|Failed)/.test(body));
  assert.ok(!body.includes("| Seat |"), "an invalid receipt's contents are not shown as though they were checked");
});

test("render: a receipt without a digest says an edit would not show", () => {
  const r = good(); delete r.digest;
  const res = result(r);
  assert.equal(res.valid, true);
  assert.match(render([res]), /carries no digest/);
});

test("render: a valid receipt full of hostile text cannot break the table or reach anyone", () => {
  const r = changed(good, (x) => {
    x.checks[0].command = "echo `x` | tee </code><img src=x> [a](https://evil.example) @octocat";
    x.checks[0].result = "ok | fine";
    x.checks[0].purpose = "**loud**";
    x.gaps = ["@everyone look <script>alert(1)</script>", "[link](https://evil.example)"];
    x.producer.name = "<b>bold</b>";
    x.seats[0].model = "m|odel`";
  });
  const res = result(r);
  assert.deepEqual(res.errors, [], "the hostile receipt is itself valid: the format does not police prose");
  const body = render([res]);
  for (const raw of ["<img", "<script", "<b>", "](", "@octocat", "@everyone", "evil.example"]) assert.ok(!body.includes(raw), `left ${raw} live`);
  const rows = body.split("\n").filter((l) => l.startsWith("| <code>"));
  assert.equal(rows.length, r.checks.length + r.seats.length * 0, "one line per check");
  for (const row of body.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("|---"))) assert.equal(row.split("|").length, 6, `a row grew a column: ${row}`);
});

test("render: several receipts share one report, and long lists are cut with a count", () => {
  const many = changed(good, (x) => {
    x.gaps = Array.from({ length: 30 }, (_, i) => `gap ${i}`);
  });
  const body = render([result(many, "a.json"), result(split(), "b.json")], ["Found 40 files; only the first 20 are checked"]);
  assert.match(body, /### Run receipts: 2 checked\n/);
  assert.match(body, /#### Run receipt: Verified/);
  assert.match(body, /#### Run receipt: Failed/);
  assert.match(body, /- and 10 more/);
  assert.match(body, /Note: Found 40 files/);
  assert.match(render([result(good()), result((() => { const r = good(); r.grade = "partial"; return r; })())]), /2 checked, 1 not valid/);
});

test("render: the report stays under the size a comment may be", () => {
  const big = changed(good, (x) => {
    x.checks = Array.from({ length: 100 }, () => ({ ...x.checks[0], command: "x".repeat(300), result: "" }));
  });
  const res = result(big);
  const body = render(Array.from({ length: MAX_RECEIPTS }, () => res));
  assert.ok(body.length <= 60100);
  assert.match(body, /the report was cut here/);
});

/* ── Finding and reading files ───────────────────────────────────────── */

test("findReceipts: files, folders at any depth, each once, in a steady order", () => {
  const dir = workspace({ "receipts/b.json": good(), "receipts/a.json": split(), "receipts/deep/c.json": good(), "receipts/notes.txt": "x", "receipts/node_modules/p/package.json": {}, "single.json": good() });
  const { files, problems } = findReceipts("receipts\n\n  single.json  \nreceipts/a.json\nmissing.json", dir);
  assert.deepEqual(files.map((f) => f.name), ["receipts/a.json", "receipts/b.json", "receipts/deep/c.json", "single.json"]);
  assert.deepEqual(problems, []);
  assert.deepEqual(findReceipts("", dir).files, []);
  assert.deepEqual(findReceipts("nowhere", dir).files, []);
});

test("findReceipts: a path or a link that leaves the workspace is refused", () => {
  const outside = workspace({ "secret.json": good() });
  const dir = workspace({ "ok.json": good() });
  symlinkSync(join(outside, "secret.json"), join(dir, "link.json"));
  const { files, problems } = findReceipts(`../${outside.split("/").pop()}/secret.json\nlink.json\nok.json`, dir);
  assert.deepEqual(files.map((f) => f.name), ["ok.json"]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /outside the workspace/);
});

test("findReceipts: more files than the limit are counted and left", () => {
  const dir = workspace(Object.fromEntries(Array.from({ length: MAX_RECEIPTS + 3 }, (_, i) => [`r/${String(i).padStart(2, "0")}.json`, good()])));
  const { files, problems } = findReceipts("r", dir);
  assert.equal(files.length, MAX_RECEIPTS);
  assert.match(problems[0], new RegExp(`Found ${MAX_RECEIPTS + 3} files`));
});

test("checkFile: valid, invalid, not JSON and far too large each come back as a result", () => {
  const dir = workspace({ "good.json": good(), "edited.json": (() => { const r = good(); r.grade = "failed"; return r; })(), "broken.json": "{ not json", "list.json": "[1,2]", "huge.json": " ".repeat(1024 * 1024 + 10) });
  const at = (n) => checkFile({ file: join(dir, n), name: n });
  assert.equal(at("good.json").valid, true);
  assert.equal(at("good.json").receipt.grade, "verified");
  assert.equal(at("edited.json").valid, false);
  assert.equal(at("edited.json").receipt, null);
  assert.deepEqual(at("broken.json").errors, ["file: not readable as JSON (SyntaxError)"]);
  assert.equal(at("list.json").valid, false);
  assert.deepEqual(at("huge.json").errors, ["file: larger than a receipt can be"]);
});

/* ── Pass or fail ────────────────────────────────────────────────────── */

test("gradeList: commas or spaces, any case, unknown words named", () => {
  const { grades, unknown } = gradeList(" Failed, unverified  not-visible,bogus ");
  assert.deepEqual([...grades].sort(), ["failed", "not-visible", "unverified"]);
  assert.deepEqual(unknown, ["bogus"]);
  assert.equal(gradeList("").grades.size, 0);
  assert.equal(gradeList(undefined).grades.size, 0);
});

test("decide: an invalid receipt always fails; a grade fails only when the workflow says so", () => {
  const ok = result(good());
  const failed = result(split());
  const invalid = result((() => { const r = good(); r.grade = "failed"; return r; })());
  assert.equal(decide([ok, failed]).code, 0, "a failed grade is a finding, not a broken receipt");
  assert.equal(decide([ok, invalid]).code, 1);
  assert.match(decide([ok, invalid]).message, /1 receipt did not verify/);
  assert.equal(decide([ok, failed], { failGrades: new Set(["failed"]) }).code, 1);
  assert.match(decide([ok, failed], { failGrades: new Set(["failed"]) }).message, /graded failed/);
  assert.equal(decide([ok], { failGrades: new Set(["failed"]) }).code, 0);
});

test("decide: no receipt is a warning unless the workflow asks otherwise", () => {
  assert.deepEqual([decide([]).code, decide([]).level], [0, "warning"]);
  assert.deepEqual([decide([], { ifNone: "error" }).code, decide([], { ifNone: "error" }).level], [1, "error"]);
  assert.deepEqual([decide([], { ifNone: "ignore" }).code, decide([], { ifNone: "ignore" }).level], [0, "none"]);
});

/* ── The comment ─────────────────────────────────────────────────────── */

const where = { api: "https://api.example", repo: "o/r", number: 7, token: "tkn", body: `${MARKER}\nnew` };

test("postComment: adds a comment when there is none of ours", async () => {
  const f = fakeFetch([{ status: 200, json: [{ id: 1, body: "hello" }] }, { status: 201 }]);
  const out = await postComment({ ...where, fetchImpl: f.impl });
  assert.deepEqual(out, { done: true, status: 201, updated: false });
  assert.deepEqual(f.calls.map((c) => [c.method, c.url]), [["GET", "https://api.example/repos/o/r/issues/7/comments?per_page=100&page=1"], ["POST", "https://api.example/repos/o/r/issues/7/comments"]]);
  assert.equal(f.calls[1].body.body, where.body);
  assert.equal(f.calls[0].headers.authorization, "Bearer tkn");
});

test("postComment: updates ours, found on a later page", async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ id: i, body: "x" }));
  const f = fakeFetch([{ status: 200, json: page }, { status: 200, json: [{ id: 555, body: `${MARKER}\nold` }] }, { status: 200 }]);
  const out = await postComment({ ...where, fetchImpl: f.impl });
  assert.deepEqual(out, { done: true, status: 200, updated: true });
  assert.deepEqual([f.calls[2].method, f.calls[2].url], ["PATCH", "https://api.example/repos/o/r/issues/comments/555"]);
});

test("postComment: a marked comment that is not ours to edit is passed over", async () => {
  const f = fakeFetch([{ status: 200, json: [{ id: 9, body: `${MARKER}\nsomebody else's` }] }, { status: 403 }, { status: 201 }]);
  const out = await postComment({ ...where, fetchImpl: f.impl });
  assert.deepEqual(out, { done: true, status: 201, updated: false });
  assert.deepEqual(f.calls.map((c) => c.method), ["GET", "PATCH", "POST"]);
});

test("postComment: a token that cannot read or write is reported, not thrown", async () => {
  assert.deepEqual(await postComment({ ...where, fetchImpl: fakeFetch([{ status: 403 }]).impl }), { done: false, status: 403 });
  assert.deepEqual(await postComment({ ...where, fetchImpl: fakeFetch([{ status: 200, json: [] }, { status: 403 }]).impl }), { done: false, status: 403, updated: false });
});

/* ── The whole run ───────────────────────────────────────────────────── */

/** Run main() in a workspace as the runner would, and read back everything it wrote. */
async function run(files, env = {}, answers = []) {
  const dir = workspace({ ...files, "_event.json": env.event ?? { pull_request: { number: 12 } }, "_out": "", "_summary": "" });
  const lines = [];
  const f = fakeFetch(answers);
  const code = await main({
    GITHUB_WORKSPACE: dir, GITHUB_OUTPUT: join(dir, "_out"), GITHUB_STEP_SUMMARY: join(dir, "_summary"), GITHUB_EVENT_PATH: join(dir, "_event.json"),
    GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "https://api.example", RR_TOKEN: "secret-token", RR_COMMENT: "true", ...env,
  }, { log: (l) => lines.push(String(l)), fetchImpl: f.impl });
  const outputs = {};
  for (const m of readFileSync(join(dir, "_out"), "utf8").matchAll(/^(\w+)<<(rr_[\w-]+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
  return { code, lines, outputs, summary: readFileSync(join(dir, "_summary"), "utf8"), calls: f.calls };
}

test("main: a valid receipt passes, is summarised, sets outputs and is posted", async () => {
  const r = await run({ "receipts/run.json": good() }, { RR_PATH: "receipts" }, [{ status: 200, json: [] }, { status: 201 }]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.outputs, { count: "1", valid: "true", grade: "verified", grades: "verified", signed: "false" });
  assert.match(r.summary, /### Run receipt: Verified/);
  assert.equal(r.calls[1].method, "POST");
  assert.equal(r.calls[1].body.body + "\n", r.summary);
  assert.ok(r.lines.includes("VALID    receipts/run.json  verified"));
  assert.ok(r.lines.includes("Report posted on pull request 12."));
  assert.ok(!r.lines.join("\n").includes("secret-token"));
});

test("main: an edited receipt fails the job and names the rules", async () => {
  const edited = good(); edited.grade = "failed";
  const r = await run({ "run.json": edited }, { RR_PATH: "run.json", RR_COMMENT: "false" });
  assert.equal(r.code, 1);
  assert.deepEqual(r.outputs, { count: "1", valid: "false", grade: "", grades: "", signed: "false" });
  assert.ok(r.lines.some((l) => /^ {2}error {4}G1: /.test(l)));
  assert.ok(r.lines.includes("::error title=Run receipt::1 receipt did not verify."));
  assert.equal(r.calls.length, 0, "comment: false posts nothing");
});

test("main: a failed grade fails the job only when asked to", async () => {
  const files = { "run.json": split() };
  assert.equal((await run(files, { RR_PATH: "run.json", RR_COMMENT: "false" })).code, 0);
  const strict = await run(files, { RR_PATH: "run.json", RR_COMMENT: "false", RR_FAIL_ON_GRADE: "failed, unverified" });
  assert.equal(strict.code, 1);
  assert.equal(strict.outputs.grade, "failed");
  const typo = await run(files, { RR_PATH: "run.json", RR_COMMENT: "false", RR_FAIL_ON_GRADE: "faild" });
  assert.equal(typo.code, 0);
  assert.ok(typo.lines.some((l) => l.startsWith("::warning title=Run receipt::fail-on-grade names \"faild\"")));
});

test("main: no receipt warns by default, and nothing is posted or summarised", async () => {
  const quiet = await run({}, { RR_PATH: "receipts" });
  assert.equal(quiet.code, 0);
  assert.deepEqual(quiet.outputs, { count: "0", valid: "false", grade: "", grades: "", signed: "false" });
  assert.equal(quiet.summary, "");
  assert.equal(quiet.calls.length, 0);
  assert.ok(quiet.lines.includes("::warning title=Run receipt::No run receipt was found at the path given."));
  assert.equal((await run({}, { RR_PATH: "receipts", RR_IF_NO_RECEIPT: "error" })).code, 1);
  const ignored = await run({}, { RR_PATH: "receipts", RR_IF_NO_RECEIPT: "ignore" });
  assert.ok(!ignored.lines.some((l) => l.startsWith("::warning")));
});

test("main: a fork's read-only token is a warning, and the job still passes", async () => {
  const r = await run({ "run.json": good() }, { RR_PATH: "run.json" }, [{ status: 200, json: [] }, { status: 403 }]);
  assert.equal(r.code, 0);
  assert.ok(r.lines.some((l) => l.startsWith("::warning title=Run receipt::The report could not be posted on the pull request (HTTP 403).")));
  assert.match(r.summary, /Run receipt: Verified/);
});

test("main: outside a pull request the report goes to the summary only", async () => {
  const r = await run({ "run.json": good() }, { RR_PATH: "run.json", event: { ref: "refs/heads/main" } });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 0);
  assert.match(r.summary, /Run receipt: Verified/);
});

test("main: what a receipt says cannot be read by the runner as a command", async () => {
  const hostile = good();
  hostile.surprise = "\n::error::owned\n::add-mask::x";
  const r = await run({ "run.json": hostile, "bad.json": "::set-env name=X::1" }, { RR_PATH: "run.json\nbad.json", RR_COMMENT: "false" });
  assert.equal(r.code, 1);
  const stop = r.lines[0].match(/^::stop-commands::(rr_[\w-]+)$/);
  assert.ok(stop, "the first line switches workflow commands off");
  const resume = r.lines.indexOf(`::${stop[1]}::`);
  assert.ok(resume > 0);
  const inside = r.lines.slice(1, resume);
  const after = r.lines.slice(resume + 1);
  assert.ok(inside.some((l) => l.includes("run.json")));
  for (const l of after) assert.match(l, /^::(error|warning) title=Run receipt::[^\n]*$/, "only our own annotations are printed with commands on");
  for (const l of after) assert.ok(!/owned|add-mask|set-env/.test(l));
});

test("main: each run keeps its own guard word and output fences", async () => {
  const a = await run({ "run.json": good() }, { RR_PATH: "run.json", RR_COMMENT: "false" });
  const b = await run({ "run.json": good() }, { RR_PATH: "run.json", RR_COMMENT: "false" });
  assert.notEqual(a.lines[0], b.lines[0]);
});

/* ── Signatures ──────────────────────────────────────────────────────── */

const signer = generateKey();
const stranger = generateKey();
const signedGood = () => signReceipt(good(), signer);

test("render: says who signed, in the workflow's words, or that nobody it trusts did", () => {
  const dir = workspace({ "s.json": signedGood(), "u.json": good() });
  const at = (n, keys) => checkFile({ file: join(dir, n), name: n }, { trustedKeys: keys });
  const listed = [{ key: signer.key, name: "Release <b>builds</b> @team" }];
  const named = render([at("s.json", listed)]);
  assert.match(named, /Signed by Release &#60;b&#62;builds&#60;&#47;b&#62; &#64;&#8203;team \(<code>ed25519&#58;/);
  assert.ok(!named.includes(signer.key), "the report shows enough of a key to tell two apart, not all of it");
  assert.match(render([at("s.json", [{ key: stranger.key, name: "Somebody else" }])]), /which this workflow does not list as trusted/);
  assert.match(render([at("s.json", [])]), /which this workflow does not list as trusted/);
  assert.match(render([at("u.json", listed)]), /Not signed\./);
});

test("decide: a required signature must come from a listed key", () => {
  const dir = workspace({ "s.json": signedGood(), "u.json": good() });
  const at = (n, keys) => checkFile({ file: join(dir, n), name: n }, { trustedKeys: keys });
  const listed = [{ key: signer.key, name: "" }];
  assert.equal(decide([at("s.json", listed)], { requireSignature: true }).code, 0);
  assert.equal(decide([at("s.json", [{ key: stranger.key, name: "" }])], { requireSignature: true }).code, 1);
  const mixed = decide([at("s.json", listed), at("u.json", listed)], { requireSignature: true });
  assert.equal(mixed.code, 1);
  assert.match(mixed.message, /1 receipt is not signed by a trusted key/);
  assert.equal(decide([at("u.json", listed)]).code, 0, "unsigned is fine unless the workflow requires otherwise");
});

test("main: trusted keys come from the workflow, and a required signature is enforced", async () => {
  const files = { "s.json": signedGood() };
  const keys = `# release\n${signer.key} Release builds\n`;
  const ok = await run(files, { RR_PATH: "s.json", RR_COMMENT: "false", RR_TRUSTED_KEYS: keys, RR_REQUIRE_SIGNATURE: "true" });
  assert.equal(ok.code, 0);
  assert.equal(ok.outputs.signed, "true");
  assert.match(ok.summary, /Signed by Release builds/);
  const wrong = await run(files, { RR_PATH: "s.json", RR_COMMENT: "false", RR_TRUSTED_KEYS: `${stranger.key} Other`, RR_REQUIRE_SIGNATURE: "true" });
  assert.equal(wrong.code, 1);
  assert.equal(wrong.outputs.signed, "false");
  assert.ok(wrong.lines.includes("::error title=Run receipt::1 receipt is not signed by a trusted key, which this workflow requires."));
  const unsigned = await run({ "u.json": good() }, { RR_PATH: "u.json", RR_COMMENT: "false", RR_TRUSTED_KEYS: keys, RR_REQUIRE_SIGNATURE: "true" });
  assert.equal(unsigned.code, 1);
});

test("main: requiring a signature with no keys to trust is a mistake in the workflow, said plainly", async () => {
  const r = await run({ "s.json": signedGood() }, { RR_PATH: "s.json", RR_COMMENT: "false", RR_REQUIRE_SIGNATURE: "true" });
  assert.equal(r.code, 1);
  assert.ok(r.lines.some((l) => l.startsWith("::error title=Run receipt::require-signature needs trusted-keys")));
  const typo = await run({ "s.json": signedGood() }, { RR_PATH: "s.json", RR_COMMENT: "false", RR_TRUSTED_KEYS: "ed25519:short Oops" });
  assert.equal(typo.code, 0);
  assert.ok(typo.lines.some((l) => l.startsWith("::warning title=Run receipt::trusted-keys, line 1: not a key")));
});

test("main: a signed receipt edited afterwards fails, whoever signed it", async () => {
  const edited = signedGood(); edited.gaps = [];
  const r = await run({ "s.json": edited }, { RR_PATH: "s.json", RR_COMMENT: "false", RR_TRUSTED_KEYS: signer.key });
  assert.equal(r.code, 1);
  assert.ok(r.lines.some((l) => /^ {2}error {4}K1: /.test(l)));
  assert.equal(r.outputs.signed, "false");
});

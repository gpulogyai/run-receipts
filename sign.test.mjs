import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReceipt, validateSchema, loadSchema, digestOf, parseKeys, signersOf, signatureHolds, publicKeyOf, signedBytes, SIGNATURE_CONTEXT } from "./verify.mjs";
import { generateKey, signReceipt } from "./sign.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const good = () => JSON.parse(readFileSync(join(here, "examples", "agreed-verified.json"), "utf8"));
const rules = (res) => res.errors.map((e) => e.split(":")[0]);
const tmp = () => mkdtempSync(join(tmpdir(), "rr-sign-"));
const cli = (file, args, env = {}) => spawnSync(process.execPath, [join(here, file), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

const alice = generateKey();
const bob = generateKey();

test("keys: a new key is 32 bytes each way, and no two are alike", () => {
  assert.match(alice.key, /^ed25519:[A-Za-z0-9_-]{43}$/);
  assert.match(alice.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(alice.key, bob.key);
  assert.ok(publicKeyOf(alice.key));
  for (const bad of ["", "ed25519:short", "rsa:" + "A".repeat(43), null, alice.key + "A"]) assert.equal(publicKeyOf(bad), null);
});

test("sign: a signed receipt is valid, names its signer, and its digest is unchanged by signing", () => {
  const signed = signReceipt(good(), alice);
  const res = verifyReceipt(signed);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.signers, [{ key: alice.key, trusted: false, name: "" }]);
  assert.equal(signed.digest, good().digest, "signatures are left out of the digest");
  assert.equal(digestOf(signed), signed.digest);
  assert.deepEqual(validateSchema(signed, loadSchema()), []);
  assert.match(signed.signatures[0].sig, /^[A-Za-z0-9_-]{86}$/);
});

test("sign: the signature is over the stated words and the digest, and nothing else", () => {
  assert.equal(SIGNATURE_CONTEXT, "run-receipt-signature-v1\n");
  assert.equal(signedBytes("sha256:abc").toString("utf8"), "run-receipt-signature-v1\nsha256:abc");
});

test("sign: any edit after signing breaks the signature, and retaking the digest does not mend it", () => {
  const edited = signReceipt(good(), alice);
  edited.gaps = [];
  assert.deepEqual(rules(verifyReceipt(edited)).sort(), ["D1", "K1"]);
  edited.digest = digestOf(edited);
  assert.deepEqual(rules(verifyReceipt(edited)), ["K1"]);
  assert.deepEqual(verifyReceipt(edited).signers, [], "an invalid receipt has no signers");
});

test("sign: a signature cannot be moved to another receipt or claimed by another key", () => {
  const a = signReceipt(good(), alice);
  const other = good(); other.gaps = ["Something else"]; other.digest = digestOf(other);
  other.signatures = a.signatures;
  assert.deepEqual(rules(verifyReceipt(other)), ["K1"]);
  const claimed = signReceipt(good(), alice);
  claimed.signatures[0].key = bob.key;
  assert.deepEqual(rules(verifyReceipt(claimed)), ["K1"]);
  assert.equal(signatureHolds(a, a.signatures[0]), true);
  assert.equal(signatureHolds(a, { key: alice.key, sig: "A".repeat(86) }), false);
  assert.equal(signatureHolds(a, {}), false);
});

test("sign: two keys can sign one receipt; signing again with one replaces its own signature only", () => {
  const both = signReceipt(signReceipt(good(), alice), bob);
  assert.deepEqual(verifyReceipt(both).signers.map((s) => s.key), [alice.key, bob.key]);
  const again = signReceipt(both, alice);
  assert.deepEqual(again.signatures.map((s) => s.key).sort(), [alice.key, bob.key].sort());
  const twice = structuredClone(both); twice.signatures.push(twice.signatures[0]);
  assert.ok(rules(verifyReceipt(twice)).includes("K2"));
});

test("sign: signing a changed receipt drops signatures that no longer hold", () => {
  const first = signReceipt(good(), alice);
  first.gaps = ["A new gap"];
  const resigned = signReceipt(first, bob);
  assert.deepEqual(resigned.signatures.map((s) => s.key), [bob.key], "Alice signed the old contents, not these");
  assert.deepEqual(verifyReceipt(resigned).errors, []);
});

test("sign: a receipt that does not verify is not signed, and a broken key is refused", () => {
  const bad = good(); bad.grade = "failed";
  assert.throws(() => signReceipt(bad, alice), /does not verify/);
  assert.throws(() => signReceipt(good(), { key: alice.key, secret: bob.secret }), /signing key|belong together/);
  assert.throws(() => signReceipt(good(), { key: alice.key }), /not a signing key/);
  assert.throws(() => signReceipt(good(), null), /not a signing key/);
});

test("sign: a receipt without a digest gains one when signed", () => {
  const bare = good(); delete bare.digest;
  const signed = signReceipt(bare, alice);
  assert.equal(signed.digest, good().digest);
  assert.deepEqual(verifyReceipt(signed).warnings, []);
});

test("trust: a signer is trusted only when the reader listed its key, under the reader's name for it", () => {
  const signed = signReceipt(good(), alice);
  const listed = [{ key: alice.key, name: "Release builds" }];
  assert.deepEqual(signersOf(signed, listed), [{ key: alice.key, trusted: true, name: "Release builds" }]);
  assert.deepEqual(verifyReceipt(signed, { trustedKeys: [{ key: bob.key, name: "Bob" }] }).signers, [{ key: alice.key, trusted: false, name: "" }]);
  assert.equal(verifyReceipt(signed, { trustedKeys: listed, requireSignature: true }).valid, true);
  assert.deepEqual(rules(verifyReceipt(signed, { trustedKeys: [{ key: bob.key, name: "" }], requireSignature: true })), ["K3"]);
  assert.deepEqual(rules(verifyReceipt(good(), { trustedKeys: listed, requireSignature: true })), ["K3"]);
  assert.deepEqual(rules(verifyReceipt(signed, { requireSignature: true })), ["K3"], "with nobody listed, nobody is trusted");
});

test("trust: a key list is read from lines or from JSON, and what is not a key is named", () => {
  const lines = parseKeys(`# who we trust\n\n${alice.key} Release builds\n${bob.key}\n${alice.key} again\nnot-a-key Mallory\n`);
  assert.deepEqual(lines.keys, [{ key: alice.key, name: "Release builds" }, { key: bob.key, name: "" }]);
  assert.deepEqual(lines.problems, ["line 6: not a key"]);
  const json = parseKeys(JSON.stringify({ keys: [{ key: alice.key, name: "A" }, { key: "x" }] }));
  assert.deepEqual(json.keys, [{ key: alice.key, name: "A" }]);
  assert.deepEqual(json.problems, ["keys[1]: not a key"]);
  assert.deepEqual(parseKeys("{ nope").problems, ["the key list is not readable as JSON"]);
  assert.deepEqual(parseKeys("{}").problems, ["the key list has no keys"]);
  assert.deepEqual(parseKeys(""), { keys: [], problems: [] });
  assert.deepEqual(parseKeys(undefined), { keys: [], problems: [] });
});

test("schema: signatures have one shape, at most eight, and nothing extra", () => {
  const schema = loadSchema();
  const with_ = (sigs) => validateSchema({ ...good(), signatures: sigs }, schema);
  const one = signReceipt(good(), alice).signatures[0];
  assert.deepEqual(with_([one]), []);
  assert.ok(with_([]).length > 0);
  assert.ok(with_([{ ...one, name: "Alice" }]).some((e) => /is not part of the format/.test(e)), "a receipt cannot name its own signer");
  assert.ok(with_([{ key: one.key }]).length > 0);
  assert.ok(with_([{ key: "ed25519:x", sig: one.sig }]).length > 0);
  assert.ok(with_(Array.from({ length: 9 }, () => one)).length > 0);
});

test("command line: make a key, sign in place, verify against a list", () => {
  const dir = tmp();
  const keyFile = join(dir, "signing-key.json");
  const made = cli("sign.mjs", ["keygen", keyFile]);
  assert.equal(made.status, 0);
  const pub = made.stdout.trim();
  assert.match(pub, /^ed25519:[A-Za-z0-9_-]{43}$/);
  if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600, "the signing key is readable by its owner only");
  assert.equal(cli("sign.mjs", ["keygen", keyFile]).status, 2, "a key is never overwritten");

  const receipt = join(dir, "receipt.json");
  writeFileSync(receipt, JSON.stringify(good()));
  const printed = cli("sign.mjs", ["sign", "--key", keyFile, receipt]);
  assert.equal(printed.status, 0);
  assert.equal(JSON.parse(printed.stdout).signatures[0].key, pub);
  assert.ok(!("signatures" in JSON.parse(readFileSync(receipt, "utf8"))), "without --write the file is left alone");
  assert.equal(cli("sign.mjs", ["sign", "--key", keyFile, "--write", receipt]).status, 0);
  assert.equal(JSON.parse(readFileSync(receipt, "utf8")).signatures[0].key, pub);

  const keys = join(dir, "keys.txt");
  writeFileSync(keys, `${pub} Release builds\n`);
  const ok = cli("verify.mjs", ["--keys", keys, "--require-signature", receipt]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /signed {3}Release builds \(ed25519:/);
  const asJson = JSON.parse(cli("verify.mjs", ["--json", "--keys", keys, receipt]).stdout);
  assert.deepEqual(asJson.signers, [{ key: pub, trusted: true, name: "Release builds" }]);
  assert.match(cli("verify.mjs", [receipt]).stdout, /nothing here vouches for/);

  writeFileSync(keys, `${bob.key} Somebody else\n`);
  const no = cli("verify.mjs", ["--keys", keys, "--require-signature", receipt]);
  assert.equal(no.status, 1);
  assert.match(no.stdout, /K3: signed, but by no key on the trusted list/);
  assert.match(cli("verify.mjs", ["--keys", keys, receipt]).stdout, /is not on your list/);
});

test("command line: the key can come from the environment; mistakes are refused with a reason", () => {
  const dir = tmp();
  const receipt = join(dir, "receipt.json");
  writeFileSync(receipt, JSON.stringify(good()));
  const fromEnv = cli("sign.mjs", ["sign", receipt], { RUN_RECEIPT_SIGNING_KEY: JSON.stringify(alice) });
  assert.equal(fromEnv.status, 0);
  assert.equal(JSON.parse(fromEnv.stdout).signatures[0].key, alice.key);
  assert.ok(!fromEnv.stdout.includes(alice.secret) && !fromEnv.stderr.includes(alice.secret));
  assert.equal(cli("sign.mjs", ["sign", receipt], { RUN_RECEIPT_SIGNING_KEY: "" }).status, 2);
  assert.equal(cli("sign.mjs", ["sign", "--key", join(dir, "missing.json"), receipt]).status, 2);
  assert.equal(cli("sign.mjs", []).status, 2);
  assert.equal(cli("sign.mjs", ["sign", "--key"]).status, 2);
  const bad = join(dir, "bad.json");
  const edited = good(); edited.grade = "failed";
  writeFileSync(bad, JSON.stringify(edited));
  const refused = cli("sign.mjs", ["sign", receipt.replace("receipt", "bad")], { RUN_RECEIPT_SIGNING_KEY: JSON.stringify(alice) });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not verify, so it is not signed/);
  assert.equal(cli("verify.mjs", ["--require-signature", receipt]).status, 2, "requiring a signature without a list to check it against is a mistake");
  assert.equal(cli("verify.mjs", ["--keys"]).status, 2);
  writeFileSync(join(dir, "k.txt"), "garbage\n");
  assert.equal(cli("verify.mjs", ["--keys", join(dir, "k.txt"), receipt]).status, 2);
});

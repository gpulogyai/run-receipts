#!/usr/bin/env node
// Copyright 2026 GPULogy AI LLC
// SPDX-License-Identifier: Apache-2.0
/**
 * Sign a run receipt, and make the key to sign with.
 *
 * A signature says one thing: whoever holds this key put their name to this
 * receipt, and it has not changed since. It does not say the commands were
 * run. What a signature is worth is what the key is worth: who holds it, and
 * how hard it is for anyone else to.
 *
 * No dependencies: Node 18 or later, and verify.mjs beside this file.
 */
import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { generateKeyPairSync, createPrivateKey, sign as signBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { digestOf, signedBytes, verifyReceipt, publicKeyOf } from "./verify.mjs";

/** A new key pair: `key` is public and goes in receipts and trust lists; `secret` signs and goes nowhere. */
export function generateKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { key: `ed25519:${jwk.x}`, secret: jwk.d };
}

/** The signing key Node needs, from a { key, secret } pair. Throws when they are not a pair. */
function privateKeyOf(pair) {
  const x = /^ed25519:([A-Za-z0-9_-]{43})$/.exec(String(pair?.key ?? ""))?.[1];
  if (!x || !/^[A-Za-z0-9_-]{43}$/.test(String(pair?.secret ?? ""))) throw new Error("not a signing key");
  if (!publicKeyOf(pair.key)) throw new Error("not a signing key");
  try { return createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x, d: pair.secret }, format: "jwk" }); }
  catch { throw new Error("not a signing key"); }
}

/**
 * The receipt, signed: its digest retaken, and this key's signature added in
 * place of any earlier one from the same key. Other keys' signatures are kept
 * only while they still hold. Refuses a receipt that does not verify: a
 * signature on a broken receipt would put a name to nothing.
 */
export function signReceipt(receipt, pair) {
  const key = privateKeyOf(pair);
  const { signatures: before = [], ...rest } = receipt;
  const unsigned = { ...rest, digest: digestOf(rest) };
  const check = verifyReceipt(unsigned);
  if (!check.valid) throw new Error(`the receipt does not verify, so it is not signed:\n${check.errors.join("\n")}`);
  const sig = signBytes(null, signedBytes(unsigned.digest), key).toString("base64url");
  const kept = before.filter((s) => s.key !== pair.key && verifyReceipt({ ...unsigned, signatures: [s] }).valid);
  const signed = { ...unsigned, signatures: [...kept, { key: pair.key, sig }] };
  const after = verifyReceipt(signed);
  if (!after.valid) throw new Error("the key's two halves do not belong together");
  return signed;
}

/* ── Command line ────────────────────────────────────────────────────── */

const USAGE = `Usage:
  sign.mjs keygen <key-file>                  make a signing key; prints the public half
  sign.mjs sign --key <key-file> <receipt>    print the receipt, signed
  sign.mjs sign --key <key-file> --write <receipt>   sign it where it is

The key can also come from the environment, for a build server:
  RUN_RECEIPT_SIGNING_KEY   the contents of a key file`;

function readPair(file, env) {
  const text = file ? readFileSync(file, "utf8") : env.RUN_RECEIPT_SIGNING_KEY;
  if (!text) throw new Error("no signing key: pass --key <key-file> or set RUN_RECEIPT_SIGNING_KEY");
  return JSON.parse(text);
}

export function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (command === "keygen") {
    if (rest.length !== 1 || rest[0].startsWith("--")) { console.error(USAGE); return 2; }
    if (existsSync(rest[0])) { console.error(`${rest[0]} exists. A key is not overwritten: receipts signed with it would have nobody to answer for them.`); return 2; }
    const pair = generateKey();
    writeFileSync(rest[0], JSON.stringify(pair, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(pair.key);
    console.error(`The signing key is in ${rest[0]}. Keep it out of your repository. Give readers the line above.`);
    return 0;
  }
  if (command === "sign") {
    const args = [...rest];
    let keyFile = null;
    const at = args.indexOf("--key");
    if (at !== -1) { keyFile = args[at + 1] ?? null; args.splice(at, 2); if (!keyFile) { console.error(USAGE); return 2; } }
    const write = args.includes("--write");
    const files = args.filter((a) => !a.startsWith("--"));
    if (files.length !== 1 || args.some((a) => a.startsWith("--") && a !== "--write")) { console.error(USAGE); return 2; }
    let receipt, pair;
    try { receipt = JSON.parse(readFileSync(files[0], "utf8")); }
    catch (e) { console.error(`Cannot read ${files[0]}: ${e.message}`); return 2; }
    try { pair = readPair(keyFile, env); }
    catch (e) { console.error(`Cannot read the signing key: ${e.message}`); return 2; }
    let signed;
    try { signed = signReceipt(receipt, pair); }
    catch (e) { console.error(e.message); return 1; }
    const text = JSON.stringify(signed, null, 2) + "\n";
    if (write) { writeFileSync(files[0], text); console.error(`Signed ${files[0]} as ${pair.key}`); }
    else process.stdout.write(text);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) process.exit(main(process.argv.slice(2)));

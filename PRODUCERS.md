# Writing receipts from your own tool

This guide is for anyone whose tool runs a model to do work and other models to review it, and who wants that tool to write a run receipt when a run ends. [SPEC.md](SPEC.md) is the definition; this is the practical route through it.

If you would rather not build receipts yourself, the [adapters](adapters/README.md) make one from a log of what happened: your tool writes a line as each thing happens, and the counting is done for you.

You do not need any code from this repository to write a receipt. A receipt is one JSON file. You do need the verifier to check what you wrote, and you should never write a receipt that does not verify.

## The smallest valid receipt

One seat did some work, nobody reviewed it and nothing was run:

```json
{
  "receiptVersion": "0.1",
  "producer": { "name": "your-tool" },
  "endedAt": "2026-11-12T09:30:00Z",
  "durationMs": 4200,
  "tokens": 1800,
  "costUsd": 0.01,
  "seats": [
    { "name": "Builder", "role": "lead", "model": "model-a", "turns": 1, "errors": 0, "timeouts": 0, "durationMs": 4200, "costUsd": 0.01 }
  ],
  "verdict": null,
  "checks": [],
  "totals": { "reviewers": 0, "verifiers": 0, "ran": 0, "passed": 0, "failed": 0, "failingNow": 0, "contradicted": 0 },
  "grade": "unverified",
  "gaps": ["Nobody reviewed this run"]
}
```

It is valid, and its grade is the honest one: `unverified`. Everything below is about earning a better grade truthfully.

## What to record while the run is going

A receipt is written at the end, from things you can only know during the run. Collect these as they happen:

| Record | When | Becomes |
|---|---|---|
| Each seat's name, role and model | When the run starts | `seats` |
| For each seat: answers completed, attempts that failed, how many of those were timeouts, time spent, metered cost | As each attempt ends | `turns`, `errors`, `timeouts`, `durationMs`, `costUsd` |
| For each reviewer: where it ended | When the run ends | `stance` |
| Every command a reviewer ran to test the work: who ran it, the command, its exit code, one line of output | As each command exits | `checks` and `totals` |
| Whether you could see a reviewer's commands at all | When the run starts | `commandsVisible` |
| How many files the lead changed, if you can measure it | When the run ends | `totals.filesChanged` |
| What nobody verified | When the run ends | `gaps` |

If you cannot observe something, say so in the receipt and do not guess. A reviewer working inside a tool whose commands you cannot see gets `commandsVisible: false`, not a made-up list of checks. An exit code you did not see is `null` with state `unknown`, not `0`.

## A worked example

[examples/produce.mjs](examples/produce.mjs) is a complete producer, short enough to read in one sitting. It takes a run as a tool might hold it (seats, the commands reviewers ran in order, and the gaps) and returns a receipt. Run it:

```bash
node examples/produce.mjs
```

Read it alongside the sections below. It is written to be adapted, in any language; nothing in it is specific to JavaScript except the two helpers it borrows from the verifier, `gradeOf` and `digestOf`, both of which are a few lines you can re-implement from SPEC.md.

## Counting: the rules that catch people out

Most invalid receipts come from totals that do not match the seats. These are the ones to get right.

**Totals count reviewers' commands, not the lead's.** `ran`, `passed` and `failed` are the commands run *to test the work*, by reviewers that answered. The lead running its own tests while building is not a check of the work by somebody else. Rule T5 holds you to this: `ran` is above 0 exactly when at least one reviewer is counted in `verifiers`.

**Each run of a command counts.** A command run twice is two in `ran`. If it failed and then passed, that is one in `failed`, one in `passed`, zero in `failingNow` and one in `resolved`. In `checks` it appears once, as it stood at the end.

**`totals.reviewers` is the reviewers that answered.** A reviewer whose stance is `unavailable` is a seat, appears in `seats` and in the verdict's holdouts, and is not counted in `totals.reviewers`.

**The verdict counts differently depending on its outcome.** When the outcome is `agreed`, `verdict.reviewers` is the reviewers that answered. Otherwise it is all reviewers, including unavailable ones. An absent reviewer cannot block agreement among those who answered, but it also cannot be left out of a count that fell short.

**`agreed` has a condition when somebody was missing.** If any reviewer was unavailable, the outcome may be `agreed` only when nothing is failing at the end. You may always record less agreement than the rules allow; you may never record more.

**A reviewer that agreed while its own check was failing is `contradicted`.** Its stance stays `agreed`, it is counted in `totals.contradicted`, and that alone makes the grade `failed`.

**Do not choose the grade. Work it out.** The grade is the first of these that applies to your totals:

| Grade | When |
|---|---|
| `failed` | `failingNow` or `contradicted` is above 0 |
| `verified` | `ran` is above 0 and every reviewer that answered ran something |
| `partial` | `ran` is above 0 and some reviewer that answered ran nothing |
| `reviewed` | nothing was run and `filesChanged` is 0 |
| `not-visible` | nothing was run and every reviewer that answered worked out of view |
| `unverified` | anything else |

Leave `filesChanged` out when you did not measure it. Writing `0` claims you measured and found none, and turns an unverified change into `reviewed`.

## Each check

| Situation | `exitCode` | `state` | `missingSetup` |
|---|---|---|---|
| Ran and exited 0 | `0` | `checked` | `null` |
| Ran and exited non-zero | the code | `reproduced` | `null` |
| Could not run for want of something (a service, a credential, a tool) | the code, or `null` | `blocked` | what was missing, in a few words |
| Ran, and you never saw how it ended | `null` | `unknown` | `null` |
| Named by a seat and never run | `null` | `untested` | `null` |

`where` is one of `local`, `ci`, `cloud` or `other`. It is a category on purpose: never write a machine name there. `deployed` is true only when the command reached the place the work actually runs, such as a request to the live service; a test suite on a laptop is `false`.

## What must stay out

A tool that runs models holds prompts, replies, file contents, account details and full command output. None of it belongs in a receipt, and the schema rejects unknown fields so that none can be added by accident. Three places still take free text from the run, and they are yours to make safe:

- **`command`**: mask credentials (`API_TOKEN=***`), and replace home folders with `~`. At most 300 characters, one line.
- **`result`**: one line of output, at most 200 characters, masked the same way. Never the whole output.
- **`gaps` and `purpose`**: short statements you compose. Do not paste a model's reply into them.

Also: make `id` opaque. A random identifier is right; your internal conversation or job id, or anything derived from it, links a public file to a private record.

The masking in the example is a starting point. You know what your users' secrets look like better than a generic pattern does.

## Digest, verify, sign if you can, then write

1. Build the whole receipt without `digest`.
2. Take the digest: SHA-256 over the receipt serialised as JSON with object keys sorted at every level and no whitespace, written as `sha256:` and lower-case hex. Add it as `digest`.
3. Verify the result. If it does not verify, do not write it: fix the producer.
4. Sign it, if your tool has a key worth signing with. See "Signing" below.

In JavaScript, with the package:

```js
import { verifyReceipt, digestOf } from "@letthembuild/run-receipts";

receipt.digest = digestOf(receipt);
const { valid, errors } = verifyReceipt(receipt);
if (!valid) throw new Error(errors.join("\n"));
```

In any other language, write the file and check it in your own tests with the command line:

```bash
npx @letthembuild/run-receipts receipt.json
```

Number formatting is where digests written in other languages go wrong: the canonical form writes numbers as JavaScript's `JSON.stringify` does, so `0.10` is `0.1` and `2.0` is `2`. Test your digest against the two receipts in [examples/](examples), which carry theirs.

## Signing

Signing is optional, and an unsigned receipt is a complete receipt. Sign when a reader needs to know that a receipt came from you and was not rewritten on the way.

```js
import { signReceipt } from "@letthembuild/run-receipts/sign";

const signed = signReceipt(receipt, signingKey); // { key, secret }, as `sign.mjs keygen` writes it
```

In another language: sign the UTF-8 bytes of `run-receipt-signature-v1`, a line feed, and the digest string, with Ed25519, and add `{ "key": "ed25519:<public key, base64url>", "sig": "<signature, base64url>" }` to `signatures`. Both are unpadded.

Before you add signing, decide where the key lives, because that decides what your signature is worth:

| Where the key is | What a signature from it shows |
|---|---|
| On a build server or service you run, never given out | The receipt came from your service. The strongest claim you can make. |
| Made on each user's machine, one key per installation | The receipt came from that installation and was not edited since. The user publishes their own key to whoever needs to trust it. |
| One key built into the application you ship | Only that the receipt came from some copy of your application. Anyone with the application can extract the key, so do not present this as your signature. |

Publish your public key somewhere readers already trust, such as your documentation over HTTPS, and say which of the three it is. Never put a name in a receipt to say who signed: the format has no field for it, on purpose.

## Where the file goes

The format does not say. Two conventions work well:

- **Beside the work.** Write it into the project, in a folder of its own such as `receipts/`, named so that files sort by time: `run-receipt-20261112-093000-verified.json`. Whether it is committed is the person's choice; do not commit it for them.
- **On the pull request.** A receipt committed with a change can be verified and shown to reviewers by the GitHub Action in this repository. See [README.md](README.md#verify-receipts-on-pull-requests).

Write a receipt for every run, including the ones that went badly. A tool that only writes receipts for good runs has made the grade meaningless.

## When the verifier says no

| Rule | Usual cause |
|---|---|
| `schema: ... is not part of the format` | You added a field. Unknown fields are not allowed, by design. |
| S4 | A reviewer has no `stance`, or the lead has one. |
| S5 | A seat on a flat subscription carries a cost. Its `costUsd` is 0. |
| V3 | `holdouts` is missing a reviewer that did not agree, or lists one with the wrong stance. |
| V4, V5 | The verdict was chosen instead of worked out from the stances. |
| T1 | `totals.reviewers` counts an unavailable reviewer. |
| T5 | The lead's commands were counted, or commands were counted from a reviewer that is not counted as answering. |
| G1 | The grade was chosen instead of worked out from the totals. |
| C2 | A check exited 0 with a state other than `checked`. |
| C3 | `blocked` without `missingSetup`, or `missingSetup` on a check that is not blocked. |
| D1 | The receipt was changed after its digest was taken, or the canonical form is not quite right. |
| K1 | The receipt was changed after it was signed, or the signature was made over something other than the context line and the digest. |

## Before you ship

- [ ] Every receipt your tool writes is verified first, and an invalid one is never written.
- [ ] Your tests build a receipt for a run that agreed, one that did not, one with a failing check, one where nothing was run, and one with a reviewer that never answered.
- [ ] No prompt, reply, file content or account detail can reach a receipt. Test it with a run that contains a recognisable secret and search the receipt for it.
- [ ] `producer.name` is your tool's own name, and `producer.version` its version.
- [ ] Receipts are written for bad runs as well as good ones.

If something in the format stops you from describing a run truthfully, that is a problem with the format. Please open an issue.

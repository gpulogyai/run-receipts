# Run receipt, version 0.1 (draft)

Status: draft. Field names and rules may change before 1.0.

## What a receipt is

Several models agreeing on an answer is not evidence that the answer is right. A run receipt is the short, machine-readable account of what a multi-model run actually did to check its own work: who took part, which commands were run and how they exited, where each reviewer ended up, and what nobody verified.

A receipt holds figures, names and commands. It never holds a prompt, a model's reply, a file's contents or a command's full output.

A receipt is the producer's account of the run. A verifier can prove that the account is well-formed, consistent with itself and unchanged since its digest was taken. It cannot prove the run happened as described. See "What a verifier cannot tell you".

## Vocabulary

- **Run**: one request worked on by one lead and zero or more reviewers until it ends.
- **Seat**: one participant in the run, with a display name and the model behind it.
- **Lead**: the seat that does the work. **Reviewer**: a seat that examines it.
- **Check**: a command a seat ran to test the work.
- **Stance**: where a reviewer ended the run. `agreed`, `objected`, `silent` (answered without saying either way) or `unavailable` (could not answer at all).
- **Gap**: something that was not verified, stated in words.

## The document

A receipt is one JSON object, UTF-8. `receipt.schema.json` is the normative shape; unknown fields are not allowed.

### Top level

| Field | Required | Meaning |
|---|---|---|
| `receiptVersion` | yes | `"0.1"`. |
| `id` | no | Opaque id chosen by the producer. |
| `producer` | yes | `name` and optional `version` of the tool that wrote the receipt. |
| `endedAt` | yes | When the run ended, UTC, `YYYY-MM-DDTHH:MM:SSZ`. |
| `revision` | no | The commit the work ended on, or null outside a repository. May say that uncommitted changes were present. |
| `durationMs` | yes | Wall-clock length of the run. |
| `firstReplyMs` | no | Time until the first seat began answering. |
| `tokens` | yes | Tokens used by all seats, in and out. |
| `costUsd` | yes | Metered cost of the run in US dollars. Seats on a flat subscription add nothing. |
| `seats` | yes | One entry per seat, 1 to 32. |
| `verdict` | yes | How the reviewers ended, or null when nobody reviewed. |
| `checks` | yes | The commands run to test the work. May be empty. |
| `totals` | yes | The counts the grade is worked out from. |
| `grade` | yes | One word for how well the result was checked. |
| `gaps` | yes | What was not verified. May be empty, and is listed even when everyone agreed. |
| `digest` | no | `sha256:` and 64 hex characters over the canonical form. |

### Seat

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name, unique within the run. Checks and holdouts refer to it. |
| `role` | yes | `lead` or `reviewer`. |
| `model` | yes | The model identifier the seat ran. |
| `family` | no | The model's vendor family, lower case. |
| `turns` | yes | Answers the seat completed. |
| `errors` | yes | Attempts that failed. |
| `timeouts` | yes | How many of those errors were the seat going quiet. |
| `durationMs` | yes | Time the seat spent answering. Seats may run in parallel, so these do not add up to the run's length. |
| `costUsd` | yes | Metered cost of this seat. |
| `costBasis` | no | `metered`, `subscription` (a flat plan bought elsewhere) or `unpriced` (no published price). |
| `stance` | reviewers only | Where the reviewer ended. |
| `commandsVisible` | no | False when the seat worked inside a tool whose commands the producer could not observe. Such a seat is not counted as having run nothing; it is counted as not visible. |

### Verdict

| Field | Meaning |
|---|---|
| `outcome` | `agreed`, `majority` (more than half agree) or `none` (half or fewer; a tie is not a majority). |
| `agreed` | How many reviewers agreed. |
| `reviewers` | How many reviewers the outcome is counted over. |
| `holdouts` | Every reviewer that did not agree, by name, with its stance. |

A reviewer that could not answer is not a reviewer that disagreed. When every reviewer that answered agreed and no check is still failing, the outcome is `agreed`, counted over those that answered, and the missing seats stay named in `holdouts`.

### Check

| Field | Required | Meaning |
|---|---|---|
| `by` | yes | The seat that ran it, or null when unknown. |
| `alsoBy` | no | Up to four other seats that re-ran it with the same result. |
| `purpose` | no | What the seat said the command was for. |
| `command` | yes | The command as run, at most 300 characters. |
| `exitCode` | yes | Its exit code, or null when none was seen. |
| `result` | no | One line of its output, at most 200 characters. |
| `revision` | no | The commit it ran against. |
| `where` | yes | `local`, `ci`, `cloud` or `other`. A category, never a machine name. |
| `deployed` | yes | True when the command reached the place the work actually runs. |
| `missingSetup` | yes | What the command needed and did not have, in words, or null. |
| `state` | yes | `checked` (ran and answered), `reproduced` (a failure was shown), `blocked` (could not run for want of setup), `unknown` (ran, result not seen) or `untested` (named but never run). |
| `durationMs` | no | How long it took. |

`checks` is a readable list, not a ledger: identical re-runs are merged into one entry with `alsoBy`, and a producer may cap the list. `totals` holds the full counts.

### Totals

| Field | Required | Meaning |
|---|---|---|
| `reviewers` | yes | Reviewers that answered. |
| `verifiers` | yes | Reviewers that ran at least one command. |
| `notVisible` | no | Reviewers whose commands could not be observed. |
| `contradicted` | yes | Reviewers that said they agreed while their own checks failed. Their agreement does not count. |
| `ran` | yes | Commands run to test the work. |
| `passed` | yes | Of those, how many passed. |
| `failed` | yes | How many failed at any point in the run. |
| `failingNow` | yes | How many were still failing when the run ended. |
| `expected` | no | Failed as intended: a probe answering "not installed", or the failure the person asked to see. Neither passed nor failing. |
| `resolved` | no | Failed earlier and passing at the end: caught and fixed. |
| `filesChanged` | no | Files the lead changed. Absent means not measured; 0 means measured and none. |

### Grade

One of six words, decided by the first rule that applies:

1. `failed`: a check is still failing, or a reviewer contradicted its own checks.
2. `verified`: commands were run, and every reviewer ran some.
3. `partial`: commands were run, by some reviewers only.
4. `reviewed`: nothing was run and no file was changed. A question was answered and read.
5. `not-visible`: nothing was run where it could be seen, and every reviewer worked out of view.
6. `unverified`: none of the above.

The grade is a word and not a score on purpose. A failed check is a different answer from an unrun one, not fewer points.

## What a verifier must check

A receipt is valid when it satisfies the schema and every rule below. Rule ids are stable, so tools can report them.

**Seats**
- S1. Seat names are unique.
- S2. At least one seat is the lead.
- S3. `timeouts` does not exceed `errors`.
- S4. Every reviewer has a `stance`; the lead has none.
- S5. A seat whose `costBasis` is `subscription` or `unpriced` has `costUsd` 0.

**Verdict**
- V1. `verdict` is null exactly when the run has no reviewers.
- V2. `verdict.agreed` equals the number of reviewers whose stance is `agreed`.
- V3. `holdouts` is exactly the reviewers whose stance is not `agreed`, each with that stance.
- V4. `outcome` is `agreed` only if at least one reviewer answered and every reviewer that answered agreed; and, if any reviewer was `unavailable`, only if `totals.failingNow` is 0. Otherwise `outcome` is `majority` when more than half of all reviewers agreed, else `none`.
- V5. `verdict.reviewers` is the number of reviewers that answered when the outcome is `agreed`, and the number of all reviewers otherwise.

A producer may record `majority` or `none` where V4 would allow `agreed`: a run can withhold agreement for reasons of its own. It may never record `agreed` where V4 forbids it.

**Totals**
- T1. `reviewers` equals the number of reviewers whose stance is not `unavailable`.
- T2. `verifiers`, `notVisible` and `contradicted` do not exceed `reviewers`; `notVisible` does not exceed the reviewers marked `commandsVisible: false`.
- T3. `passed + failed + expected` does not exceed `ran`.
- T4. `failingNow` does not exceed `failed`; `resolved` does not exceed `failed - failingNow`.
- T5. `ran` is above 0 exactly when `verifiers` is above 0.

**Grade**
- G1. `grade` is the word the totals earn under the six rules above.

**Checks**
- C1. `by` and every name in `alsoBy` is a seat in the run.
- C2. A check that exited 0 has state `checked`.
- C3. State `blocked` and a non-null `missingSetup` go together.
- C4. States `unknown` and `untested` have a null `exitCode`.
- C5 (warning). More checks are listed as run than `totals.ran` counts.

**Money and time**
- M1 (warning). Seat costs differ from `costUsd` by more than one cent.
- M2. `firstReplyMs` does not exceed `durationMs`.
- M3. `endedAt` is a real date.

**Digest**
- D1. If `digest` is present it equals the digest of the receipt.
- D2 (warning). No digest is present.

Warnings do not make a receipt invalid.

## Digest

The digest is SHA-256 over the receipt's canonical form, written `sha256:` followed by lower-case hex. The canonical form is the receipt without its top-level `digest` field, serialised as JSON with object keys sorted by code unit at every level, no whitespace, and numbers and strings as `JSON.stringify` writes them, encoded as UTF-8.

A digest lets a copy of a receipt, such as one quoted in a pull-request comment, be matched against the file it came from. It is not a signature: anyone who edits a receipt can retake its digest.

## What a verifier cannot tell you

- That the commands were really run, or exited as stated.
- That the seats were the models named.
- That the receipt belongs to the change it is attached to, beyond the `revision` it names.

Closing those gaps needs a signature from the producer and a way to check the key, which this version leaves out. See the roadmap in README.md.

## What a receipt must not carry

A tool that runs models holds far more about a run than a receipt should. A producer must keep all of the following out of a receipt, and the schema rejects unknown fields so that none of it can be added by accident.

| Left out | Why |
|---|---|
| Prompts, replies, conversation titles, file contents | A receipt is figures, not the work. |
| Full command output | Output carries paths, tokens and data. One line (`result`) is the limit, and the producer must mask secrets in it and in `command`. |
| Account email, user id, team or organisation id | Personal and customer data. |
| The id of the conversation or job the run belonged to, or anything derived from it | Links a public file to a private record. `id` must be opaque. |
| Machine names and host names for where a check ran | `where` is a four-word category for this reason. |
| How a seat was paid for beyond `costBasis` | Billing detail. |
| Network destinations blocked or allowed, browser permissions, sandbox decisions | Describe the person's machine and browsing, not the result. |
| Team policy and configuration | Belongs to the team, not to the run. |
| Free-text narrative: why a seat was silent, what failed, notes for later | Free text can quote the work. `gaps` and `purpose` are the only prose, and both are short. |

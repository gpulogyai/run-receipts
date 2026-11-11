# Contributing

Thank you for looking. This project is a specification and a small verifier, so most contributions are one of three kinds.

## A problem with the format

Open an issue that says what a receipt cannot express, or expresses wrongly, with a small example. Changes to field names, meanings or rules are changes to the specification: they need an issue and agreement before a pull request.

## A bug in the verifier

Open a pull request with:

1. A test in `verify.test.mjs` that fails before your change.
2. The fix in `verify.mjs`.

The verifier has no dependencies and should stay that way. It must keep running on Node 18.

## A new rule

Every rule has an id in SPEC.md (`V4`, `G1`). A new rule needs its id and wording in SPEC.md, its check in `verify.mjs`, and tests for a receipt that passes and one that fails. Both examples must still verify with no errors and no warnings.

## Before you open a pull request

```bash
npm test
```

## What never belongs in a receipt, an example or a test

Prompts, model replies, file contents, real host names, email addresses, account ids or secrets. Examples use invented names and `example.com`.

## Sign your work

Commits must carry a `Signed-off-by` line (`git commit -s`). By adding it you state that you wrote the change or have the right to submit it under the Apache-2.0 licence, as set out in the Developer Certificate of Origin (https://developercertificate.org).

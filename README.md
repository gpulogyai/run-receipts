# Run receipts

A run receipt is a short, machine-readable account of how well an AI run checked its own work.

Several models agreeing on an answer is not evidence that the answer is right. What matters is what was actually run: which commands, by whom, how they exited, and what nobody verified. A receipt records exactly that, in one JSON file that a person can read and a tool can check.

This repository holds:

- **[SPEC.md](SPEC.md)**: the format, version 0.1 (draft), and the rules a valid receipt obeys.
- **[receipt.schema.json](receipt.schema.json)**: the JSON Schema.
- **[verify.mjs](verify.mjs)**: a verifier with no dependencies.
- **[examples/](examples)**: two receipts to read and test against.

The format is not tied to any one product. Any tool that runs one model to do work and others to review it can write a receipt.

## What a receipt looks like

```json
{
  "receiptVersion": "0.1",
  "producer": { "name": "example-producer" },
  "endedAt": "2026-11-10T16:42:07Z",
  "seats": [
    { "name": "Claude", "role": "lead", "model": "claude-sonnet-5-5", "...": "..." },
    { "name": "Gemini", "role": "reviewer", "model": "gemini-3-pro", "stance": "agreed", "...": "..." }
  ],
  "verdict": { "outcome": "agreed", "agreed": 2, "reviewers": 2, "holdouts": [] },
  "checks": [
    { "by": "Gemini", "command": "npm test", "exitCode": 0, "where": "local", "deployed": false, "state": "checked", "...": "..." }
  ],
  "totals": { "reviewers": 2, "verifiers": 2, "ran": 5, "passed": 4, "failed": 1, "failingNow": 0, "...": "..." },
  "grade": "verified",
  "gaps": ["Behaviour under production load"]
}
```

The full versions are in [examples/](examples). A receipt holds figures, names and commands. It never holds a prompt, a model's reply or a file's contents.

## Verify a receipt

You need Node 18 or later. Nothing else.

```bash
git clone <this repository> run-receipts
```

```bash
node run-receipts/verify.mjs run-receipts/examples/agreed-verified.json
```

```
VALID    run-receipts/examples/agreed-verified.json
```

A receipt that does not hold together is rejected, with the rule it broke:

```
INVALID  edited.json
  error    G1: grade is failed; the totals earn verified
  error    D1: digest does not match the receipt's contents
```

| Command | What it does |
|---|---|
| `verify.mjs <file>` | Check a receipt. Exits 0 when valid, 1 when invalid, 2 when the file cannot be read. |
| `verify.mjs --json <file>` | The same, with the result as JSON. |
| `verify.mjs --digest <file>` | Print the digest the receipt should carry. |

The verifier is also a module:

```js
import { verifyReceipt } from "./verify.mjs";

const { valid, errors, warnings } = verifyReceipt(receipt);
```

## What verifying proves, and what it does not

A valid receipt is well-formed, consistent with itself, and unchanged since its digest was taken. Its grade follows from its totals, its verdict follows from where each reviewer ended, and each check's state matches its exit code.

Verifying does **not** prove that the commands were really run or that they exited as stated. A receipt is the producer's own account. Trusting a receipt you did not produce needs a signature, which version 0.1 leaves out.

## Roadmap

Not in 0.1:

- **Signing**, so a reader can tell who produced a receipt.
- **A GitHub Action** that verifies a receipt on a pull request and posts its grade, checks and gaps as a comment.
- **A guide for producers**: how to write a receipt from your own tool.

## Run the tests

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go to the address in [SECURITY.md](SECURITY.md), not to public issues.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The licence covers the code and the specification; it does not grant use of any names or logos, as [TRADEMARKS.md](TRADEMARKS.md) explains.

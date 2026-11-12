# Run receipts

A run receipt is a short, machine-readable account of how well an AI run checked its own work.

Several models agreeing on an answer is not evidence that the answer is right. What matters is what was actually run: which commands, by whom, how they exited, and what nobody verified. A receipt records exactly that, in one JSON file that a person can read and a tool can check.

This repository holds:

- **[SPEC.md](SPEC.md)**: the format, version 0.1 (draft), and the rules a valid receipt obeys.
- **[receipt.schema.json](receipt.schema.json)**: the JSON Schema.
- **[verify.mjs](verify.mjs)**: a verifier with no dependencies.
- **[sign.mjs](sign.mjs)**: makes a signing key and signs a receipt with it.
- **[PRODUCERS.md](PRODUCERS.md)**: how to write receipts from your own tool, with a worked example.
- **[action.yml](action.yml)**: a GitHub Action that verifies the receipts a pull request carries and reports them.
- **[examples/](examples)**: two receipts to read and test against.

The format is not tied to any one product. Any tool that runs one model to do work and others to review it can write a receipt.

Maintained by GPULogy AI LLC, the makers of [LetThemBuild](https://letthembuild.com), an app where several AI models do the work and review each other. Run receipts began as its record of what a run actually checked.

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

With npm, no clone is needed:

```bash
npx @letthembuild/run-receipts receipt.json
```

Or from a clone of this repository:

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
| `verify.mjs --keys <list> <file>` | Also say whether each signature is from a key on your list. |
| `verify.mjs --keys <list> --require-signature <file>` | Not valid unless a key on your list signed it. |

The verifier is also a module:

```js
import { verifyReceipt } from "./verify.mjs";

const { valid, errors, warnings } = verifyReceipt(receipt);
```

## Sign a receipt, and check who signed

A digest shows that a receipt was not edited by accident. Anyone who edits one on purpose can retake the digest. A signature closes that: it shows that the holder of a particular key signed exactly this receipt.

Make a key once. The file it writes is the signing key; keep it out of your repository. The line it prints is the public key, which is what you give to readers:

```bash
node sign.mjs keygen signing-key.json
```

```
ed25519:Qm3v...
```

Sign a receipt where it is:

```bash
node sign.mjs sign --key signing-key.json --write receipt.json
```

A reader keeps a list of the keys they trust, one to a line, each with their own name for it:

```
ed25519:Qm3v... Release builds
```

```bash
node verify.mjs --keys trusted-keys.txt --require-signature receipt.json
```

```
VALID    receipt.json
  signed   Release builds (ed25519:Qm3v...)
```

On a build server, put the contents of the key file in a secret and pass it as `RUN_RECEIPT_SIGNING_KEY` instead of `--key`.

A receipt carries keys, never names: the name shown is always the reader's own. A signature from a key that is not on your list tells you somebody signed, and nothing about who. And a key is only as good as its keeping. One that lives on a build server supports a strong claim; one shipped inside an app on its users' machines can be extracted by any of them. [SPEC.md](SPEC.md#signatures) says exactly what a signature does and does not mean.

## Verify receipts on pull requests

The GitHub Action checks every receipt a pull request carries, and puts the grade, the checks that were run and what nobody verified where a reviewer will see them: in a comment on the pull request and in the job summary.

```yaml
name: run receipts

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  receipts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: letthembuild/run-receipts@v0
        with:
          path: receipts
```

The job fails when a receipt does not verify. A receipt that verifies and is graded `failed` is an honest report of a bad result, so by default it is shown and the job passes; name the grades you will not accept to change that.

| Input | Default | What it does |
|---|---|---|
| `path` | required | Files or folders, one per line. A folder stands for every `.json` file inside it. |
| `comment` | `true` | Post the report on the pull request. One comment, updated on each run. |
| `fail-on-grade` | none | Grades that fail the job, separated by commas: `failed`, `unverified`, `not-visible`, `reviewed`, `partial`, `verified`. |
| `if-no-receipt` | `warn` | What to do when the path holds no receipt: `error`, `warn` or `ignore`. |
| `trusted-keys` | none | The keys this workflow trusts to sign receipts, one to a line, each followed by your name for it. |
| `require-signature` | `false` | Fail the job unless every receipt is signed by a trusted key. |
| `token` | the job's token | The token the comment is posted with. |

| Output | What it holds |
|---|---|
| `count` | How many receipts were checked. |
| `valid` | `true` when at least one was checked and every one verified. |
| `grade` | The grade, when exactly one receipt was checked and it verified. |
| `grades` | The grades of the receipts that verified, separated by commas. |
| `signed` | `true` when every receipt verified and was signed by a trusted key. |

To accept only receipts signed by keys you trust, list the keys in the workflow or in a repository variable. Do not read them from a file in the pull request: the pull request could change it.

```yaml
      - uses: letthembuild/run-receipts@v0
        with:
          path: receipts
          require-signature: true
          trusted-keys: |
            ed25519:Qm3v... Release builds
```

Three things to know:

- **Pull requests from forks.** Their token cannot write, so the comment is skipped with a warning and the report is in the job summary. Keep the trigger as `pull_request`. Do not switch to `pull_request_target` to get the comment: that runs with your repository's permissions on a stranger's files.
- **A receipt's text is treated as untrusted.** Names, commands and results are shown as plain text: they cannot add formatting, links or mentions to the comment, and they cannot issue commands to the runner.
- **Requirements.** Node 18 or later on the runner, which GitHub's hosted runners have. The action installs nothing and makes no network call other than posting its comment.

## What verifying proves, and what it does not

A valid receipt is well-formed, consistent with itself, and unchanged since its digest was taken. Its grade follows from its totals, its verdict follows from where each reviewer ended, and each check's state matches its exit code. When it is signed, verifying also says which keys signed it and whether they are keys you listed.

Verifying does **not** prove that the commands were really run or that they exited as stated. A receipt is the producer's own account. A signature from a key you trust tells you whose account it is, not that the account is true.

## Roadmap

Not yet:

- **A published list of well-known producers' keys**, so a reader does not have to collect them by hand.
- **Signing by identity instead of a kept key**, for build servers that can prove who they are.

## Run the tests

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go to the address in [SECURITY.md](SECURITY.md), not to public issues.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The licence covers the code and the specification; it does not grant use of any names or logos, as [TRADEMARKS.md](TRADEMARKS.md) explains.

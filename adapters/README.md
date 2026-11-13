# Adapters: a receipt without writing a producer

[PRODUCERS.md](../PRODUCERS.md) is for a tool that builds its own receipts. These are for a tool that would rather not: it writes down what happens during a run, and the receipt is made from that record when the run is over.

There are three, and they share one file.

| Adapter | For | What you do |
|---|---|---|
| [Run log](#the-run-log) | Any tool, any language | Append one line of JSON as each thing happens. |
| [Command wrapper](#the-command-wrapper) | A tool that gives its reviewers a shell and keeps no record of it | Have reviewers run their checks through one command. |
| [Python recorder](#the-python-recorder) | Tools written in Python | Copy one file and call it. |

None of them decides a verdict or a grade. Those are worked out from the record by the rules in [SPEC.md](../SPEC.md), and a record whose receipt would not verify produces an error and no receipt.

## The run log

A run log is a text file with one JSON object on each line. Write a line when something happens; make the receipt at the end:

```bash
npx -p @letthembuild/run-receipts run-receipt-from events run.jsonl --out receipt.json
```

[example-run.jsonl](example-run.jsonl) is a whole run: a lead, two reviewers, a test that failed and was fixed.

| Event | Fields | When |
|---|---|---|
| `start` | `producer` (`name`, and `version` if you have one), `revision` | Once, first. |
| `seat` | `name`, `role` (`lead` or `reviewer`), `model`; optional `family`, `costBasis`, `commandsVisible` | Once for each seat, before anything it does. |
| `turn` | `seat`; optional `durationMs`, `costUsd`, `tokens`; `failed: true` for an attempt that failed, with `timeout: true` if it failed by going quiet | Each time a seat finishes an attempt. |
| `command` | `by`, `command`, `exitCode` (or `null` if you never saw it end); optional `result`, `purpose`, `where`, `deployed`, `missingSetup` | Each time a reviewer runs a command to test the work. |
| `stance` | `seat`, `stance` (`agreed`, `objected`, `silent` or `unavailable`) | Whenever a reviewer says where it stands. The last one counts. |
| `gap` | `text` | Whenever you know something was not verified. |
| `end` | optional `filesChanged`, `durationMs`, `tokens`, `revision` | Once, last. |

Every line may carry `at`, the time in UTC. `end` must, and the run's length is taken from `start` to `end` unless `end` gives `durationMs`.

What the log does for you:

- **Counts.** Turns, errors, timeouts, time and cost are added up for each seat. A seat whose `costBasis` is `subscription` or `unpriced` is given a cost of 0.
- **Leaves the lead's commands out.** You may log them; only what a reviewer ran is a check of the work.
- **Fills in a stance you never gave.** A reviewer that completed a turn and has no stance is `silent`. One that never completed a turn is `unavailable`.
- **Names two gaps it can see for itself:** that nobody reviewed the run, or that no reviewer ran a command.
- **Masks** credentials in commands and output when the receipt is built. The masking is a starting point; mask what your own secrets look like before you write the line.

What it will not do is guess. A command from a seat that was never declared, a stance for the lead, a log with no `end`: each is an error that names the line.

From JavaScript, without the command line:

```js
import { record, receiptFromLog } from "@letthembuild/run-receipts/events";

record("run.jsonl", { event: "command", by: "Reviewer", command: "npm test", exitCode: 0, result: "18 passing" });
const receipt = receiptFromLog("run.jsonl"); // throws if the receipt would not verify
```

## The command wrapper

Many tools hand a model a shell and never learn what it ran. Tell each reviewer to run its checks through the wrapper, and every one becomes a `command` line in the run log:

```bash
run-receipt-from exec --log run.jsonl --by "Reviewer" --purpose "Run the unit tests" -- npm test
```

The command's output and exit code pass through unchanged, so the reviewer sees what it would have seen. The log gets the command, its exit code and the last line it printed. A command that could not be started is recorded as blocked, not as failed.

The other events can be written the same way, from a script or a hook:

```bash
run-receipt-from note --log run.jsonl '{"event":"stance","seat":"Reviewer","stance":"agreed"}'
```

A reviewer that runs a check outside the wrapper leaves no record, and the receipt will say it ran nothing. That is the honest result: the wrapper records what it saw.

## The Python recorder

[run_log.py](run_log.py) is one file with no dependencies. Copy it into your project.

```python
from run_log import RunLog

log = RunLog("run.jsonl", producer="your-tool", version="1.2.0")
log.seat("Builder", role="lead", model="model-a")
log.seat("Reviewer", role="reviewer", model="model-b")
log.turn("Builder", duration_ms=52000, cost_usd=0.21, tokens=30000)
log.command("Reviewer", "pytest -q", exit_code=0, result="18 passed")
log.stance("Reviewer", "agreed")
log.end(files_changed=2)
```

Then make the receipt with the command at the top of this page. Call the recorder from wherever your framework already tells you these things: a callback when a model replies, the function that runs a tool, the place a reviewer's answer is parsed.

## Which stance to record

This is the one judgement the adapters leave to you, because only your tool knows what a reviewer said.

- `agreed` only when the reviewer endorsed the final version in so many words. A reply that raises nothing is `silent`.
- `objected` when it said what is wrong or missing.
- `unavailable` when it never answered. You can leave this one out: a reviewer with no completed turn gets it.

Record a reviewer's agreement even when its own check is failing. The receipt counts that as a contradiction and grades the run `failed`, which is what happened.

## After the receipt

Verify it, sign it if you have a key worth signing with, and put it beside the work. [PRODUCERS.md](../PRODUCERS.md) covers each.

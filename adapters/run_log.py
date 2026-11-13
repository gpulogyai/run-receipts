# Copyright 2026 GPULogy AI LLC
# SPDX-License-Identifier: Apache-2.0
"""Write a run log from Python, to be turned into a run receipt.

One file, standard library only: copy it into your project. Call it where
your own code already knows what happened (a seat was added, a reply came
back, a reviewer ran a command), then make the receipt when the run is over:

    npx -p @letthembuild/run-receipts run-receipt-from events run.jsonl --out receipt.json

    log = RunLog("run.jsonl", producer="your-tool", version="1.2.0")
    log.seat("Builder", role="lead", model="model-a")
    log.seat("Reviewer", role="reviewer", model="model-b")
    log.turn("Builder", duration_ms=52000, cost_usd=0.21, tokens=30000)
    log.command("Reviewer", "pytest -q", exit_code=0, result="18 passed")
    log.stance("Reviewer", "agreed")
    log.end(files_changed=2)

Nothing here decides a verdict or a grade. Those are worked out from the log
by the rules in SPEC.md when the receipt is made.
"""

import json
import re
from datetime import datetime, timezone

_SECRET = re.compile(r"\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=\S+")
_BEARER = re.compile(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}")
_HOME = re.compile(r"(?:/Users|/home)/[^/\s]+")


def mask(text):
    """A starting point for masking. Your tool knows what its own secrets look like: mask those too."""
    text = _SECRET.sub(r"\1=***", str(text))
    text = _BEARER.sub(r"\1 ***", text)
    return _HOME.sub("~", text)


class RunLog:
    """One run's log. Every call appends one line, so a run that dies half-way leaves what it had."""

    def __init__(self, path, producer, version=None, revision=None):
        self.path = path
        start = {"event": "start", "producer": {"name": producer}}
        if version:
            start["producer"]["version"] = version
        if revision:
            start["revision"] = revision
        self._write(start)

    def _write(self, event):
        event = {k: v for k, v in event.items() if v is not None}
        event["at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with open(self.path, "a", encoding="utf-8") as out:
            out.write(json.dumps(event, ensure_ascii=False) + "\n")

    def seat(self, name, role, model, family=None, cost_basis=None, commands_visible=None):
        """A seat in the run. role is "lead" or "reviewer"; cost_basis is "metered", "subscription" or "unpriced"."""
        self._write({"event": "seat", "name": name, "role": role, "model": model, "family": family,
                     "costBasis": cost_basis, "commandsVisible": commands_visible})

    def turn(self, seat, duration_ms=0, cost_usd=0, tokens=0, failed=False, timeout=False):
        """One attempt by a seat: an answer it completed, or one that failed (and whether by going quiet)."""
        self._write({"event": "turn", "seat": seat, "durationMs": duration_ms, "costUsd": cost_usd, "tokens": tokens,
                     "failed": True if failed or timeout else None, "timeout": True if timeout else None})

    def command(self, by, command, exit_code, result="", purpose=None, where=None, deployed=None, missing_setup=None):
        """A command a reviewer ran to test the work. exit_code is None when you never saw how it ended."""
        self._write({"event": "command", "by": by, "command": mask(command), "exitCode": exit_code,
                     "result": mask(result), "purpose": purpose, "where": where,
                     "deployed": True if deployed else None, "missingSetup": missing_setup})

    def stance(self, seat, stance):
        """Where a reviewer stands now: "agreed", "objected", "silent" or "unavailable". The last one said counts."""
        self._write({"event": "stance", "seat": seat, "stance": stance})

    def gap(self, text):
        """Something nobody verified, in your own words. Never a model's reply."""
        self._write({"event": "gap", "text": text})

    def end(self, files_changed=None, duration_ms=None, tokens=None, revision=None):
        """The run is over. Leave files_changed out when you did not measure it: 0 claims you measured and found none."""
        self._write({"event": "end", "filesChanged": files_changed, "durationMs": duration_ms, "tokens": tokens,
                     "revision": revision})

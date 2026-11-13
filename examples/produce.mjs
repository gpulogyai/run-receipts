#!/usr/bin/env node
// Copyright 2026 GPULogy AI LLC
// SPDX-License-Identifier: Apache-2.0
//
// An example producer: the least a tool needs to turn what it saw during a
// run into a valid receipt. PRODUCERS.md walks through it. It is an example
// to read and adapt; the rules it follows are SPEC.md's. The adapters in
// ../adapters build their receipts with it, so it is also kept correct.
//
//   node examples/produce.mjs            print a receipt for the sample run below

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gradeOf, digestOf, verifyReceipt } from "../verify.mjs";

/** One line, cut to length: `command` and `result` never carry more. */
const line = (s, max) => Array.from(String(s ?? "").replace(/\s+/g, " ").trim()).slice(0, max).join("");

/**
 * A starting point for masking, and no more than that. A real producer knows
 * what its own secrets look like and must mask those too.
 */
export const mask = (s) => String(s ?? "")
  .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=\S+/g, "$1=***")
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 ***")
  .replace(/(?:\/Users|\/home)\/[^/\s]+/g, "~");

/**
 * Build a receipt from a run.
 *
 *   run.seats     every seat, the lead and the reviewers, with its figures and,
 *                 for a reviewer, where it ended (stance)
 *   run.commands  every command a reviewer ran to test the work, in the order
 *                 they were run: { by, command, exitCode, purpose?, result?,
 *                 where?, deployed?, missingSetup? }
 *   run.gaps      what nobody verified, in words
 */
export function buildReceipt(run) {
  const reviewers = run.seats.filter((s) => s.role === "reviewer");
  const answered = reviewers.filter((s) => s.stance !== "unavailable");
  const agreed = reviewers.filter((s) => s.stance === "agreed");
  const counted = new Set(answered.map((s) => s.name));

  // Totals count what reviewers that answered ran. Each run of a command is
  // counted; a command run twice is two.
  const runs = run.commands.filter((c) => counted.has(c.by));
  const failedRun = (c) => typeof c.exitCode === "number" && c.exitCode !== 0;
  const last = new Map();        // command -> its last run
  const everFailed = new Set();  // commands that failed at any point
  const lastBySeat = new Map();  // "seat command" -> that seat's last run of it
  for (const c of runs) {
    last.set(c.command, c);
    lastBySeat.set(`${c.by}\n${c.command}`, c);
    if (failedRun(c)) everFailed.add(c.command);
  }
  const failingNow = [...last.values()].filter(failedRun).length;
  const verifiers = answered.filter((s) => runs.some((c) => c.by === s.name));

  const totals = {
    reviewers: answered.length,
    verifiers: verifiers.length,
    notVisible: answered.filter((s) => s.commandsVisible === false && !verifiers.includes(s)).length,
    // Agreed while a command of its own was still failing: that agreement does not count.
    contradicted: agreed.filter((s) => [...lastBySeat.entries()].some(([k, c]) => k.startsWith(`${s.name}\n`) && failedRun(c))).length,
    ran: runs.length,
    passed: runs.filter((c) => c.exitCode === 0).length,
    failed: runs.filter(failedRun).length,
    failingNow,
    resolved: [...everFailed].filter((cmd) => last.get(cmd).exitCode === 0).length,
    ...(Number.isInteger(run.filesChanged) ? { filesChanged: run.filesChanged } : {}),
  };

  // The verdict follows from the stances (rules V1 to V5).
  let verdict = null;
  if (reviewers.length) {
    const everyAnswerAgreed = answered.length > 0 && answered.every((s) => s.stance === "agreed");
    const isAgreed = everyAnswerAgreed && (answered.length === reviewers.length || failingNow === 0);
    verdict = {
      outcome: isAgreed ? "agreed" : agreed.length * 2 > reviewers.length ? "majority" : "none",
      agreed: agreed.length,
      reviewers: isAgreed ? answered.length : reviewers.length,
      holdouts: reviewers.filter((s) => s.stance !== "agreed").map((s) => ({ name: s.name, stance: s.stance })),
    };
  }

  // One check per command, as it stood at the end.
  const checks = [...last.values()].map((c) => {
    const others = [...new Set(runs.filter((o) => o.command === c.command && o.by !== c.by && o.exitCode === c.exitCode).map((o) => o.by))].slice(0, 4);
    const blocked = Boolean(c.missingSetup);
    return {
      by: c.by,
      ...(others.length ? { alsoBy: others } : {}),
      ...(c.purpose ? { purpose: line(c.purpose, 100) } : {}),
      command: line(mask(c.command), 300),
      exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
      result: line(mask(c.result), 200),
      where: c.where ?? "local",
      deployed: c.deployed === true,
      missingSetup: blocked ? line(c.missingSetup, 120) : null,
      state: blocked ? "blocked" : typeof c.exitCode !== "number" ? "unknown" : c.exitCode === 0 ? "checked" : "reproduced",
    };
  });

  const receipt = {
    receiptVersion: "0.1",
    producer: run.producer,
    endedAt: new Date(run.endedAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(run.revision ? { revision: run.revision } : {}),
    durationMs: run.durationMs,
    tokens: run.tokens,
    costUsd: Number(run.seats.reduce((n, s) => n + s.costUsd, 0).toFixed(4)),
    seats: run.seats,
    verdict,
    checks,
    totals,
    grade: gradeOf(totals),
    gaps: run.gaps.map((g) => line(g, 200)),
  };
  // The digest is taken last, over everything else.
  receipt.digest = digestOf(receipt);
  return receipt;
}

/** A run as a tool might hold it when the run ends. */
export const sampleRun = {
  producer: { name: "example-producer", version: "0.0.1" },
  endedAt: "2026-11-12T09:30:00Z",
  revision: "4f1c2ab90d3e",
  durationMs: 95000,
  tokens: 41800,
  filesChanged: 2,
  seats: [
    { name: "Builder", role: "lead", model: "model-a", turns: 2, errors: 0, timeouts: 0, durationMs: 52000, costUsd: 0.21, costBasis: "metered" },
    { name: "First reviewer", role: "reviewer", model: "model-b", turns: 2, errors: 0, timeouts: 0, durationMs: 30000, costUsd: 0.08, costBasis: "metered", stance: "agreed" },
    { name: "Second reviewer", role: "reviewer", model: "model-c", turns: 1, errors: 0, timeouts: 0, durationMs: 21000, costUsd: 0, costBasis: "subscription", stance: "agreed" },
  ],
  commands: [
    { by: "First reviewer", command: "npm test", exitCode: 1, purpose: "Run the unit tests", result: "1 failing" },
    { by: "First reviewer", command: "npm test", exitCode: 0, purpose: "Run the unit tests", result: "18 passing" },
    { by: "Second reviewer", command: "npm test", exitCode: 0, result: "18 passing" },
    { by: "Second reviewer", command: "API_TOKEN=abc123 npm run smoke", exitCode: 0, purpose: "Smoke test", result: "ok" },
  ],
  gaps: ["Checked locally only; deployed behaviour not verified"],
};

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  const receipt = buildReceipt(sampleRun);
  // Never write a receipt that does not verify.
  const { valid, errors } = verifyReceipt(receipt);
  if (!valid) { console.error(errors.join("\n")); process.exit(1); }
  console.log(JSON.stringify(receipt, null, 2));
}

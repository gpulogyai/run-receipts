// Copyright 2026 GPULogy AI LLC
// SPDX-License-Identifier: Apache-2.0
//
// From a run log to a receipt.
//
// A tool that cannot build a receipt itself can write down what happens as it
// happens, one JSON object per line, in any language, and have the receipt
// made from that file when the run is over. adapters/README.md lists the
// events. The counting is not repeated here: this turns the log into a run as
// examples/produce.mjs takes one, and that builds the receipt by SPEC.md.

import { appendFileSync, readFileSync } from "node:fs";
import { buildReceipt, mask } from "../examples/produce.mjs";
import { verifyReceipt } from "../verify.mjs";

const STANCES = ["agreed", "objected", "silent", "unavailable"];
const ROLES = ["lead", "reviewer"];
const BASES = ["metered", "subscription", "unpriced"];
const PLACES = ["local", "ci", "cloud", "other"];
const KINDS = ["start", "seat", "turn", "command", "stance", "gap", "end"];

const text = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const count = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const whole = (v) => Math.round(count(v));

/** A log's lines as events. A line that is not a JSON object is an error that names the line. */
export function parseLog(source) {
  const events = [];
  String(source).split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`line ${i + 1}: not JSON`); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error(`line ${i + 1}: not an event`);
    events.push({ ...event, line: i + 1 });
  });
  return events;
}

/**
 * The run a log describes, in the shape examples/produce.mjs builds a receipt
 * from. Anything the log gets wrong is an error that names the line: a
 * receipt is not made from a log that has to be guessed at.
 */
export function runFromEvents(events) {
  const fail = (e, why) => { throw new Error(`${e?.line ? `line ${e.line}: ` : ""}${why}`); };
  const seats = new Map();
  const commands = [];
  const gaps = [];
  let start = null, end = null, tokens = 0;

  const seatOf = (e, name) => seats.get(text(name)) ?? fail(e, `no seat named "${text(name)}"; a seat event must come first`);

  for (const e of events) {
    if (!KINDS.includes(e.event)) fail(e, `unknown event "${e.event}"`);
    if (end) fail(e, "the run has already ended");
    if (e.event !== "start" && !start) fail(e, "the log must begin with a start event");

    if (e.event === "start") {
      if (start) fail(e, "the run has already started");
      if (!text(e.producer?.name)) fail(e, "start needs producer.name, your tool's own name");
      start = e;
    } else if (e.event === "seat") {
      const name = text(e.name);
      if (!name) fail(e, "a seat needs a name");
      if (seats.has(name)) fail(e, `two seats are named "${name}"`);
      if (!ROLES.includes(e.role)) fail(e, `a seat's role is lead or reviewer, not "${e.role}"`);
      if (!text(e.model)) fail(e, "a seat needs the model it runs");
      if (e.costBasis !== undefined && !BASES.includes(e.costBasis)) fail(e, `costBasis is ${BASES.join(", ")}, not "${e.costBasis}"`);
      seats.set(name, {
        name, role: e.role, model: text(e.model),
        ...(text(e.family) ? { family: text(e.family).toLowerCase() } : {}),
        turns: 0, errors: 0, timeouts: 0, durationMs: 0, costUsd: 0,
        ...(e.costBasis ? { costBasis: e.costBasis } : {}),
        ...(e.commandsVisible === false ? { commandsVisible: false } : {}),
      });
    } else if (e.event === "turn") {
      const seat = seatOf(e, e.seat);
      if (e.failed === true) { seat.errors += 1; if (e.timeout === true) seat.timeouts += 1; }
      else seat.turns += 1;
      seat.durationMs += whole(e.durationMs);
      // A seat on a flat plan, or with no published price, adds nothing (rule S5).
      if (seat.costBasis !== "subscription" && seat.costBasis !== "unpriced") seat.costUsd += count(e.costUsd);
      tokens += whole(e.tokens);
    } else if (e.event === "command") {
      seatOf(e, e.by);
      if (!text(e.command)) fail(e, "a command event needs the command");
      if (e.where !== undefined && !PLACES.includes(e.where)) fail(e, `where is ${PLACES.join(", ")}, not "${e.where}"`);
      commands.push({
        by: text(e.by), command: text(e.command),
        exitCode: Number.isInteger(e.exitCode) ? e.exitCode : null,
        ...(text(e.purpose) ? { purpose: text(e.purpose) } : {}),
        result: text(e.result),
        ...(e.where ? { where: e.where } : {}),
        deployed: e.deployed === true,
        ...(text(e.missingSetup) ? { missingSetup: text(e.missingSetup) } : {}),
      });
    } else if (e.event === "stance") {
      const seat = seatOf(e, e.seat);
      if (seat.role !== "reviewer") fail(e, "only a reviewer has a stance");
      if (!STANCES.includes(e.stance)) fail(e, `a stance is ${STANCES.join(", ")}, not "${e.stance}"`);
      seat.stance = e.stance;
    } else if (e.event === "gap") {
      if (!text(e.text)) fail(e, "a gap needs its text");
      gaps.push(text(e.text));
    } else if (e.event === "end") {
      end = e;
    }
  }

  if (!start) throw new Error("the log is empty");
  if (!end) throw new Error("the log has no end event: the run has not ended, or the tool stopped before saying so");
  const endedAt = new Date(end.at);
  if (!text(end.at) || Number.isNaN(endedAt.getTime())) fail(end, "end needs `at`, the time the run ended");
  const startedAt = new Date(start.at);
  const durationMs = Number.isFinite(end.durationMs) ? whole(end.durationMs)
    : text(start.at) && !Number.isNaN(startedAt.getTime()) ? Math.max(0, endedAt - startedAt)
    : fail(end, "end needs durationMs, or start and end each need `at`");

  const all = [...seats.values()];
  if (!all.some((s) => s.role === "lead")) throw new Error("the run has no lead seat");
  for (const seat of all) {
    seat.costUsd = Number(seat.costUsd.toFixed(4));
    // A reviewer the log never gave a stance: one that answered said neither
    // yes nor no, and one that never answered could not.
    if (seat.role === "reviewer" && !seat.stance) seat.stance = seat.turns > 0 ? "silent" : "unavailable";
  }

  // Two things the log itself shows were not done. The tool adds the rest.
  const reviewers = all.filter((s) => s.role === "reviewer");
  const reviewerNames = new Set(reviewers.map((s) => s.name));
  const said = (gap) => { if (!gaps.includes(gap)) gaps.push(gap); };
  if (reviewers.length === 0) said("Nobody reviewed this run");
  else if (!commands.some((c) => reviewerNames.has(c.by))) said("No reviewer ran a command to test the work");

  return {
    producer: { name: text(start.producer.name), ...(text(start.producer.version) ? { version: text(start.producer.version) } : {}) },
    endedAt: endedAt.toISOString(),
    ...(text(start.revision) || text(end.revision) ? { revision: text(end.revision) || text(start.revision) } : {}),
    durationMs,
    tokens: Number.isFinite(end.tokens) ? whole(end.tokens) : tokens,
    ...(Number.isInteger(end.filesChanged) && end.filesChanged >= 0 ? { filesChanged: end.filesChanged } : {}),
    seats: all,
    // Only what a reviewer ran is a check of the work. The lead's own commands are part of doing it.
    commands: commands.filter((c) => reviewerNames.has(c.by)),
    gaps,
  };
}

/** The receipt for a log, verified. A log whose receipt would not verify throws, with the rules it broke. */
export function receiptFromEvents(events) {
  const receipt = buildReceipt(runFromEvents(events));
  const { valid, errors } = verifyReceipt(receipt);
  if (!valid) throw new Error(`the receipt for this log does not verify:\n${errors.join("\n")}`);
  return receipt;
}

/** The receipt for the log in `file`. */
export const receiptFromLog = (file) => receiptFromEvents(parseLog(readFileSync(file, "utf8")));

/**
 * Add one event to the log in `file`, with the time when it has none.
 * Credentials are masked before the line is written, so the log is no worse
 * to leave lying about than the receipt made from it.
 */
export function record(file, event) {
  const safe = { ...event };
  for (const key of ["command", "result", "purpose", "missingSetup", "text"]) if (typeof safe[key] === "string") safe[key] = mask(safe[key]);
  const at = typeof safe.at === "string" ? safe.at : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  appendFileSync(file, `${JSON.stringify({ ...safe, at })}\n`);
}

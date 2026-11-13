#!/usr/bin/env node
// Copyright 2026 GPULogy AI LLC
// SPDX-License-Identifier: Apache-2.0
//
//   run-receipt-from events <log> [--out <file>]
//       the receipt for a run log, printed or written to <file>
//
//   run-receipt-from exec --log <log> --by <seat> [--purpose <words>]
//                         [--where local|ci|cloud|other] [--deployed] -- <command...>
//       run a command for a reviewer and record how it ended in the log
//
//   run-receipt-from note --log <log> '<event as JSON>'
//       add one event to the log, for a tool that can only run a command

import { writeFileSync } from "node:fs";
import { receiptFromLog, record } from "./events.mjs";
import { runAndRecord } from "./exec.mjs";

const USAGE = `usage:
  run-receipt-from events <log> [--out <file>]
  run-receipt-from exec --log <log> --by <seat> [--purpose <words>] [--where <place>] [--deployed] -- <command...>
  run-receipt-from note --log <log> '<event as JSON>'`;

/** Options before `--`, and everything else in order. */
function parse(args, takesValue) {
  const options = {}, rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") { rest.push(...args.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (takesValue.includes(name)) { options[name] = args[i + 1]; i += 1; } else options[name] = true;
    } else rest.push(arg);
  }
  return { options, rest };
}

async function main([what, ...args]) {
  if (what === "events") {
    const { options, rest } = parse(args, ["out"]);
    if (rest.length !== 1) return usage();
    const json = `${JSON.stringify(receiptFromLog(rest[0]), null, 2)}\n`;
    if (typeof options.out === "string") writeFileSync(options.out, json); else process.stdout.write(json);
    return 0;
  }
  if (what === "exec") {
    const { options, rest } = parse(args, ["log", "by", "purpose", "where"]);
    if (typeof options.log !== "string" || typeof options.by !== "string" || rest.length === 0) return usage();
    return runAndRecord(rest, { log: options.log, by: options.by, purpose: options.purpose, where: options.where, deployed: options.deployed === true });
  }
  if (what === "note") {
    const { options, rest } = parse(args, ["log"]);
    if (typeof options.log !== "string" || rest.length !== 1) return usage();
    const event = JSON.parse(rest[0]);
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.event !== "string") throw new Error("not an event");
    record(options.log, event);
    return 0;
  }
  return usage();
}

function usage() { console.error(USAGE); return 2; }

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 1; });

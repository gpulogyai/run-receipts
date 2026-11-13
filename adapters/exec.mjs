// Copyright 2026 GPULogy AI LLC
// SPDX-License-Identifier: Apache-2.0
//
// Run a command for a reviewer and write down how it ended.
//
// Many tools that drive a model give it a shell and keep no record of what it
// ran. Tell the reviewer to run its checks through this instead, and each one
// lands in the run log as a command event: who ran it, the command, its exit
// code and the last line it printed. The command's output and exit code pass
// through unchanged, so the reviewer sees exactly what it would have seen.

import { spawn } from "node:child_process";
import { record } from "./events.mjs";

/** An argument as a shell would need it written, so the recorded command can be read and run again. */
const quoted = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`);

/** The last line with something on it, without the colour codes a terminal would have swallowed. */
function lastLine(output) {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

/**
 * Run `argv` and record it in `log` as run by the seat `by`.
 * Resolves to the exit code to leave with: the command's own, 127 when it
 * could not be started, 1 when a signal ended it.
 */
export function runAndRecord(argv, { log, by, purpose, where, deployed, stdout = process.stdout, stderr = process.stderr } = {}) {
  const command = argv.map(quoted).join(" ");
  const base = { event: "command", by, command, ...(purpose ? { purpose } : {}), ...(where ? { where } : {}), ...(deployed ? { deployed: true } : {}) };
  return new Promise((resolve) => {
    let tail = "", settled = false;
    const keep = (chunk) => { tail = (tail + chunk.toString("utf8")).slice(-4096); };
    const child = spawn(argv[0], argv.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (c) => { keep(c); stdout.write(c); });
    child.stderr.on("data", (c) => { keep(c); stderr.write(c); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      // Never started: the check was blocked, which is not the same as failing.
      record(log, { ...base, exitCode: null, result: "", missingSetup: err.code === "ENOENT" ? `${argv[0]} is not installed` : `could not start ${argv[0]}` });
      stderr.write(`${argv[0]}: ${err.code === "ENOENT" ? "command not found" : err.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) => {
      if (settled) return; // it never started, and that has been recorded
      settled = true;
      // Ended by a signal: it ran, and how it ended was not seen.
      record(log, { ...base, exitCode: code, result: signal ? `ended by ${signal}` : lastLine(tail) });
      resolve(code ?? 1);
    });
  });
}

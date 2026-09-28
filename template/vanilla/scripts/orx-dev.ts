#!/usr/bin/env bun
// `bun run orx -- <args>`: orx from source, the way a person or agent runs it while working
// here. Adds what the installed binary doesn't do:
//   - LOG_LEVEL defaults to info (the binary's default is warn), so each run logs its
//     `command` line and any `llm call` line.
//   - JSON log lines go to logs/orx.jsonl (ORX_LOG_FILE), appended across runs.
//   - stderr is copied to logs/orx.log. Both files move to *.prev.* past 5 MB.
//   - The data dir is .orx/data (ORX_DATA_DIR), not your real ~/.local/share/orx.
// Everything else (stdin, stdout, the exit code, Ctrl+C) passes straight through.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const logs = join(root, "logs");
mkdirSync(logs, { recursive: true });

const rotate = (file: string, prev: string) => {
  if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, prev);
};
rotate(join(logs, "orx.jsonl"), join(logs, "orx.prev.jsonl"));
rotate(join(logs, "orx.log"), join(logs, "orx.prev.log"));

const args = process.argv.slice(2);
// The TUI owns the terminal: its stderr stays a terminal (piping it would change what orx
// detects), and its logs still reach logs/orx.jsonl.
const interactive = args[0] === "ui" && process.stdin.isTTY && process.stdout.isTTY;

const child = Bun.spawn([process.execPath, join(root, "src/bin.ts"), ...args], {
  env: {
    ...process.env,
    LOG_LEVEL: process.env.LOG_LEVEL || "info",
    ORX_LOG_FILE: process.env.ORX_LOG_FILE ?? join(logs, "orx.jsonl"),
    ORX_DATA_DIR: process.env.ORX_DATA_DIR || join(root, ".orx", "data"),
    // Colors survive the pipe when the real stderr is a terminal.
    ...(process.stderr.isTTY && !process.env.NO_COLOR ? { FORCE_COLOR: "1" } : {}),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: interactive ? "inherit" : "pipe",
});

// Ctrl+C reaches the child through the terminal's process group; wait for its exit code.
process.on("SIGINT", () => {});

if (child.stderr) {
  const logFile = join(logs, "orx.log");
  const decoder = new TextDecoder();
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  for await (const chunk of child.stderr) {
    process.stderr.write(chunk);
    // Plain text in the file, like logs/orx.jsonl's fields.
    appendFileSync(logFile, decoder.decode(chunk, { stream: true }).replace(ansi, ""));
  }
}
process.exit(await child.exited);

// PostToolUse (Edit|Write): lint the file that was just written with biome and hand any
// diagnostics back to the agent as additionalContext, so it fixes them now instead of finding out
// at `bun run lint` time or in CI. Covers JS/TS, JSON, and CSS, when a biome config is present.
//
// Advisory and read-only: never blocks, never rewrites the file. It also records the path in this
// session's list (see sessionFileList in _lib.ts), which format-changed.ts formats at the end of
// the turn. Biome not installed, file outside the project, or biome crashed or timed out: no
// output. A broken linter must not turn into fake diagnostics.
import { appendFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  addContext,
  findUp,
  isFile,
  projectRoot,
  readPayload,
  run,
  sessionFileList,
  stripControl,
  text,
  which,
} from "./_lib";

const LINTED = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".css",
];
// Dependencies, build output, and VCS internals are not ours to lint.
const SKIPPED_DIRS = [
  "/node_modules/",
  "/.venv/",
  "/venv/",
  "/vendor/",
  "/dist/",
  "/build/",
  "/.git/",
  "/target/",
];
const MAX_LINES = 60;

const realpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

async function main(): Promise<void> {
  const payload = readPayload();
  if (!payload) return;
  const given = text(payload.tool_input?.file_path);
  if (!given || !isFile(given)) return;

  // Compare physical paths: the project dir, the cwd, and the file path can reach the same place
  // through different symlinks (on macOS /tmp is /private/tmp).
  const fileDir = realpath(dirname(given));
  const root = realpath(projectRoot());
  if (!fileDir || !root) return;
  const file = join(fileDir, basename(given));
  const cwd = text(payload.cwd) ? (realpath(text(payload.cwd)) ?? "") : "";

  // Only files in this project (or the worktree the agent is working in).
  if (!file.startsWith(`${root}/`) && !(cwd && file.startsWith(`${cwd}/`))) return;
  if (SKIPPED_DIRS.some((dir) => file.includes(dir))) return;

  // Record the path for format-changed.ts, which formats only what this session wrote so it
  // never rewrites a file another agent in the same checkout is editing.
  // Best effort: a list that can't be written must not stop the lint.
  if (!file.includes("\n")) {
    try {
      const list = sessionFileList(payload);
      if (list) appendFileSync(list, `${file}\n`);
    } catch {}
  }

  if (!LINTED.some((ext) => file.endsWith(ext))) return;
  const config = findUp(fileDir, "biome.json", "biome.jsonc");
  if (!config) return;
  const localBin = findUp(fileDir, "node_modules/.bin/biome");
  const biome = localBin ? join(localBin, "node_modules/.bin/biome") : which("biome");
  if (!biome) return;

  const { code, output } = await run(biome, ["check", "--colors=off", file], {
    cwd: config,
    timeoutSec: 20,
  });
  // Clean, timed out, or the file is outside biome's configured includes.
  if (code === 0 || code >= 124 || output.includes("No files were processed")) return;

  // Project-relative paths read better and cost fewer tokens.
  let out = stripControl(output).replaceAll(`${root}/`, "").replace(/\n+$/, "");
  if (out.trim() === "") return;
  // Keep the payload small. Cut by line, not byte, so multi-byte characters survive.
  const lines = out.split("\n");
  if (lines.length > MAX_LINES) {
    out = `${lines.slice(0, MAX_LINES).join("\n")}\n... (truncated; run the linter on this file for the rest)`;
  }
  const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  addContext(`biome check found issues in ${rel}. Fix them before moving on:\n${out}`);
}

await main();

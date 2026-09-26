// Stop: format the files this session wrote (Edit/Write) at the end of each turn, so what the
// agent leaves behind is formatted even if nobody runs the formatter by hand. lint-on-write.ts
// records each written path in a per-session list outside the repo (see sessionFileList in
// _lib.ts); this hook formats the ones that still exist inside the project with biome, then
// clears the list. Files other agents or you are editing in the same checkout are left alone. No
// session_id or no list: nothing is formatted.
//
// Silent by design: no output. A Stop hook that prints errors can trap the session in a feedback
// loop, so a formatter failure is ignored (the lint-on-write diagnostics already covered it).
import { readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  findUp,
  isExecutable,
  isFile,
  projectRoot,
  readPayload,
  run,
  sessionFileList,
  text,
} from "./_lib";

const FORMATTED = [
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
const SKIPPED_DIRS = [
  "/node_modules/",
  "/.venv/",
  "/venv/",
  "/vendor/",
  "/dist/",
  "/build/",
  "/target/",
];

const realpath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/** The directory to run biome from (its config, with biome installed there), if it formats `file`. */
function biomeDirFor(file: string): string | undefined {
  if (SKIPPED_DIRS.some((dir) => file.includes(dir))) return undefined;
  if (!FORMATTED.some((ext) => file.endsWith(ext))) return undefined;
  const config = findUp(dirname(file), "biome.json", "biome.jsonc");
  return config && isExecutable(join(config, "node_modules/.bin/biome")) ? config : undefined;
}

async function main(): Promise<void> {
  const payload = readPayload();
  if (!payload) return;
  const list = sessionFileList(payload);
  if (!list || !isFile(list) || statSync(list).size === 0) return;
  const cwd = text(payload.cwd) ? (realpath(text(payload.cwd)) ?? "") : "";
  const root = realpath(projectRoot());
  if (!root) return;

  // Claim the list before reading it (rename is atomic), so a path recorded while this hook runs
  // lands in a fresh list for the next Stop instead of being dropped.
  const claimed = `${list}.claimed-${process.pid}`;
  renameSync(list, claimed);
  try {
    // lint-on-write recorded physical paths, one per line, repeats possible.
    const files = [...new Set(readFileSync(claimed, "utf8").split("\n"))];
    const groups = new Map<string, string[]>();
    for (const file of files) {
      if (!file || !isFile(file)) continue;
      // Inside the project, or a worktree the agent works in, as lint-on-write allows.
      if (!file.startsWith(`${root}/`) && !(cwd && file.startsWith(`${cwd}/`))) continue;
      const dir = biomeDirFor(file);
      if (dir) groups.set(dir, [...(groups.get(dir) ?? []), file]);
    }
    // One biome run per config directory, with all of that group's files.
    for (const [dir, group] of groups) {
      await run(join(dir, "node_modules/.bin/biome"), ["check", "--write", ...group], {
        cwd: dir,
        timeoutSec: 30,
      });
    }
  } finally {
    rmSync(claimed, { force: true });
  }
}

// Stay silent on any failure too (a list claimed by a concurrent Stop, an unwritable TMPDIR).
await main().catch(() => {});

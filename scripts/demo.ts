#!/usr/bin/env bun
// `bun run demo [dir]`: a small TypeScript project in a fresh git repo, for trying the coding
// agent on something real. It's the workspace of the `rename-across-files` eval (evals/cases.ts):
// `fmtPrice` in src/money.ts, used by src/cart.ts, src/receipt.ts, and the README. Without a
// dir it goes in a new temp dir. Prints the commands to point orx at it.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SHOP_FILES } from "../evals/cases";

const given = process.argv[2];
if (
  given !== undefined &&
  existsSync(given) &&
  (!statSync(given).isDirectory() || readdirSync(given).length > 0)
) {
  console.error(
    `${given} isn't an empty directory; pick a new directory or leave it out for a temp one.`,
  );
  process.exit(2);
}
const dir = given === undefined ? mkdtempSync(join(tmpdir(), "orx-demo-")) : resolve(given);
mkdirSync(dir, { recursive: true });
for (const [path, text] of Object.entries(SHOP_FILES)) {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

// A commit, so `git diff` shows exactly what the agent changed.
const git = (...args: string[]) => {
  const run = spawnSync(
    "git",
    [
      ...["-c", "user.name=orx demo", "-c", "user.email=demo@orx.invalid"],
      // A global signing key or hooks path would prompt or run hooks on the demo commit.
      ...["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"],
      ...args,
    ],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
  if (run.status !== 0) {
    console.error(`git ${args[0]} failed: ${run.stderr.trim()}`);
    process.exit(1);
  }
};
git("init", "-q");
git("add", ".");
git("commit", "-q", "-m", "shop: prices in cents");

const root = realpathSync(dir);
console.log(`Demo workspace: ${root}

Try (from the repo root):
  bun run orx -- --cwd ${root}
      then ask: rename fmtPrice to formatPrice everywhere, and approve the edits
  bun run orx -- ask --agent --cwd ${root} --permission-mode acceptEdits "rename fmtPrice to formatPrice everywhere"
  git -C ${root} diff`);

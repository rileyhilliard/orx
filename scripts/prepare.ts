#!/usr/bin/env bun
// `prepare`, which bun runs after every `bun install`: installs the git hooks. CI sets CI and
// does its own setup, so this does nothing there.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

process.chdir(join(import.meta.dirname, ".."));

if (!process.env.CI) {
  const lefthook = spawnSync("lefthook", ["install"], { stdio: "inherit" });
  if ((lefthook.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    console.log(
      "lefthook not found: git hooks not installed (brew install lefthook, then bun install)",
    );
  } else if (lefthook.error) {
    throw lefthook.error;
  } else if (lefthook.status !== 0) {
    process.exit(lefthook.status ?? 1);
  }
}

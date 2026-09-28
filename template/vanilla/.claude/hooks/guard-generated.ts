// PreToolUse (Edit|Write): deny hand edits to files a tool generates. Editing them by hand is
// lost on the next run and hides the real fix.
//
//   dist/                        compiled binaries and SHA256SUMS (bun run build / build:all)
//   coverage/                    coverage reports (bun run coverage)
//   bun.lock                     bun's lockfile (bun add / bun remove / bun install)
import { spawnSync } from "node:child_process";
import { deny, readPayload, text } from "./_lib";

function root(): string {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : process.cwd();
}

function reasonFor(filePath: string): string | undefined {
  // Compared as given, not symlink-resolved: Claude Code sends paths under the same project dir
  // it puts in CLAUDE_PROJECT_DIR.
  const dir = root();
  let rel = filePath;
  if (filePath.startsWith(`${dir}/`)) rel = filePath.slice(dir.length + 1);
  else if (filePath.startsWith("/")) return undefined;

  if (rel.startsWith("dist/")) {
    return `${rel} is build output. Change the source and run bun run build (or bun run build:all for every target and SHA256SUMS).`;
  }
  if (rel.startsWith("coverage/")) {
    return `${rel} is a coverage report. Run bun run coverage to regenerate it.`;
  }
  if (rel === "bun.lock") {
    return "bun.lock is written by bun. Change package.json with bun add / bun remove, or run bun install.";
  }
  return undefined;
}

const filePath = text(readPayload()?.tool_input?.file_path);
const reason = filePath ? reasonFor(filePath) : undefined;
if (reason) deny(`BLOCKED: ${reason}`);

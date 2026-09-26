// PreToolUse (Bash): deny commands that destroy work or data without a way back (rm of /, ~ or .,
// git reset --hard on a dirty tree, force push, DROP TABLE, publishing...). The rules live in
// _destructive-patterns.ts.
//
// Git commands that discard uncommitted work (reset --hard, checkout ., restore ., clean -f) are
// denied only when git reports something they would discard, so they stay usable on a clean tree.
// If git can't answer (not a repo, a directory the command cd's into that can't be resolved), the
// command is denied.
//
// A deny is returned as JSON with exit 0, which the hooks contract honors, and the reason is
// shown to the agent so it can ask the user instead. Commands that don't match produce no output,
// and the normal permission flow applies. The worst of these are also listed under
// permissions.deny in settings.json, so they stay blocked if this hook can't run.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { findings, type Loss } from "./_destructive-patterns";
import { deny, readPayload, text } from "./_lib";

/** True when git reports nothing that `loss` describes. */
function nothingToLose(loss: Loss, cwd: string): boolean {
  // --no-optional-locks: don't take index.lock, which could collide with git in another session.
  const args = [
    "--no-optional-locks",
    "status",
    "--porcelain",
    loss.kind === "tracked" ? "--untracked-files=no" : "--untracked-files=all",
    ...(loss.ignored ? ["--ignored"] : []),
    "--",
    ...loss.paths,
  ];
  const status = spawnSync("git", args, {
    cwd: resolve(cwd, loss.dir ?? "."),
    encoding: "utf8",
    timeout: 3000,
  });
  if (status.status !== 0) return false;
  const lines = status.stdout.split("\n").filter(Boolean);
  return loss.kind === "untracked"
    ? !lines.some((line) => line.startsWith("??") || line.startsWith("!!"))
    : lines.length === 0;
}

const payload = readPayload();
const command = text(payload?.tool_input?.command);
const cwd = text(payload?.cwd) || process.cwd();
const found = command
  ? findings(command).find((f) => !(f.loss && nothingToLose(f.loss, cwd)))
  : undefined;
if (found) deny(`BLOCKED: ${found.reason}\n\n${found.suggestion}`);

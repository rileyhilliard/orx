---
paths:
  - "src/tools/**"
  - "src/services/permissions.ts"
  - "src/services/workspace.ts"
  - "src/services/file-state.ts"
  - "src/core/session.ts"
---

# Agent tools: the approval gate and the workspace

`AgentTools` (`src/tools/agent.ts`: `read`, `glob`, `grep`, `write`, `edit`, `bash`, plus `currentTime`) and `SkillTools` make up the session's toolkit (`SessionTools` in `src/core/session.ts`), which bare `orx` and `ask --agent` both use. These tools touch the user's files and run their shell, so the invariants below are safety properties, not style. A change that breaks one is a blocker even if every test passes.

## Invariants

- **Mutating tools ask first.** `write`, `edit`, and `bash` call `permit` (`src/tools/permit.ts`) before they change anything; `permit` asks `Permissions`, and a refusal comes back to the model as a `ToolFailure` marked `denied`. `read` calls `permit` too, so a credential-shaped path asks. `glob` and `grep` don't call `permit`: they only list names and search contents inside the workspace, which every mode allows, and they apply the path and secret rules themselves (below). A new tool that writes, deletes, runs a process, or reaches the network calls `permit` with a `PermissionRequest`, and `decide` in `src/services/permissions.ts` gets a case for it.
- **Every path goes through the Workspace.** A path from the model is resolved with `Workspace.resolve` (realpathed through its nearest existing ancestor, symlinks included, and refused outside the root) before any file operation: `glob`, `grep`, `write`, and `edit` do this. `read` uses `resolveReadable`, which also accepts a loaded skill's directory (`addReadRoot`); nothing that writes may use it. Show paths to the model with `Workspace.display`. `bash` takes no path: it runs with the workspace root as its cwd and the key scrubbed from its env, and the approval is its only boundary (it isn't sandboxed).
- **Secrets stay out of the model's context.** `isSecretPath` (`.env*`, `*.pem`, `*.key`, `id_*`) decides it. `read`, `write`, and `edit` pass the displayed path to `permit`, and `decide` asks for a secret path in every mode but `yolo` (headless, that's a denial). `grep` never searches a secret file's contents: it checks `isSecretPath` on each file (and its real path) and excludes them from `rg` with globs, then says how many it skipped. `glob` lists names only, so it may list them.
- **No write over a file the model hasn't seen.** `write` and `edit` run inside `FileState.withLock(path)`: check `FileState.checkFresh` (refuse `not-read` and `stale`), build the diff, `permit` with the diff, then check again after the answer (`ensureResolvesTo` for a symlink swapped in while the panel was open, `checkFresh` for a file edited meanwhile), write, and `FileState.record` the new bytes. `write` creating a new file skips the freshness check but fails if the file appeared during the approval. Parallel edits to one file serialize on the lock.
- **AgentTools never joins ChatTools or McpTools.** `orx mcp` serves `McpTools` (`ChatTools` plus `extractContact`) with no approval gate: there's no one to ask, and `Permissions` isn't in its layer. A file or shell tool there would run whatever an MCP client sends. `tests/mcp.test.ts` pins `tools/list` to exactly `currentTime` and `extractContact`; `tests/agent-tools.test.ts` pins `AgentTools`'s tool names.
- **A handler defect is a tool failure, not a crashed turn.** Each handler in `FileToolsLive` is wrapped with `catchToolDefect` (the `guard` in `agent.ts`), which logs the defect once and returns a `ToolFailure` the model can route around.

## Tests

Tool behavior goes in `tests/agent-*.test.ts`: `agent-tools.test.ts` (read, glob, grep, the toolkit), `agent-write-tools.test.ts` (write, edit, bash), `agent-guards.test.ts` (permission rules through the real tools), `agent-approval.test.ts` and `agent-interrupt.test.ts` (approvals in a turn), `permissions.test.ts` (`decide` and the service), `workspace.test.ts`. A new tool or a new path rule gets a test that feeds it a path outside the root, a symlink out of the root, a secret-shaped file, and a denial, and asserts each is refused. The `rg` path of `grep` only runs where `rg` is installed; in CI (`CI` set) a missing `rg` fails the suite instead of skipping it.

---
description: Add a tool to the coding agent (AgentTools), with its schema, approval rule, and tests
argument-hint: "<what the tool does>"
---

Add a tool: $ARGUMENTS

Follow `.claude/rules/src/effect-ai.md` and `.claude/rules/src/agent-tools.md`. Every tool orx has is a workspace tool: it goes in `AgentTools` (`src/tools/agent.ts`), which only the coding agent's session sends (bare `orx`, `ask --agent`); plain `ask` sends no tools. `read`, `write`, and `bash` in `src/tools/` are the models.

## Steps

1. **Schema** in `src/schemas/tools.ts`: the parameters as a `Schema.Struct` and the success value, with `description` (and `examples`) annotations on the fields (the model reads these to decide when and how to call the tool). Annotate before any `.check(...)`; a custom `Schema.makeFilter` contributes nothing to the JSON Schema, so put what the model should know in the description. No `identifier` annotation.
2. **Tool**: `Tool.make("<name>", { description, parameters, success })`. Add `failureMode: "return"` if the model should see a failure and carry on, rather than the turn failing, plus a `failure` schema if the handler can fail (`ToolFailure`). Print `Tool.getJsonSchema(tool)` and read it before a model sees it: objects are open (`additionalProperties: true`), and `Tool.Strict` only sets the `strict` flag in the request, not the schema.
3. **Display**: `orx ask` prints tool calls as a note and emits `tool-call`/`tool-result` events with `--json`. The TUI's one-line summary of a finished call is `summarizeTool` in `src/tui/tool-summary.ts` (tested in `tests/tool-summary.test.ts`), which the bridge in `launch.tsx` calls; for a tool it has no case for it returns `undefined` and the message list falls back to its plain tool line. Give it a case if that says too little, and update `DESIGN.md` if the display changes.

4. **Handler** in its own file under `src/tools/`, as an Effect that takes the decoded input and gets `Workspace`, `FileState`, `Permissions`, and platform services from the context:
   - resolve every path from the model with `Workspace.resolve` (never `resolveReadable`, which is for `read` alone) and show it with `Workspace.display`
   - call `permit({ tool, summary, path, diff?, command? })` from `src/tools/permit.ts` before changing anything, and add a case for the tool to `decide` in `src/services/permissions.ts`: without one the tool fails closed (every call asks, plan mode denies it, and "always" isn't offered), so the case is what lets a read-only tool through or lets acceptEdits allow it
   - a tool that writes a file holds `FileState.withLock(path)` and checks `checkFresh` before and after the approval, then `ensureResolvesTo`, as `write` and `edit` do; a tool that reads contents respects `isSecretPath`
   - turn platform errors into `ToolFailure`s the model can act on (`platformFailure`)
5. **Register it** in `AgentTools` and its handler in `AgentToolsLive` in `src/tools/agent.ts`, wrapped with `guard("<name>")` like the others. Update the pinned tool names in `tests/agent-tools.test.ts`. If the model needs guidance on when to use it, add it to the agent's system prompt in `src/core/prompt.ts`.
6. **Approval panel**: check the summary (and diff or command) reads well in the TUI's approval panel and in the `permission-denied` event of `ask --agent --json`.
7. **Tests** in `tests/agent-*.test.ts` (tools in `agent-tools.test.ts` or `agent-write-tools.test.ts`, permission rules in `agent-guards.test.ts` and `permissions.test.ts`):
   - valid input, invalid input, and each failure it can hit
   - refusal of a path outside the root, a symlink out of the root, and a secret-shaped path
   - `decide` for the tool in each permission mode, and a denial reaching the model as a failure
   - a stale or unread file refused, if it writes
   - its JSON Schema, pinned exactly

## Finally

`/check`. If the tool calls a third-party API, add its base URL to Config (with an unreachable default in `tests/isolation.ts`) and point tests at a local stub server. Tests never hit the network.

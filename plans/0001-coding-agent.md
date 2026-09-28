# RFC 0001: orx as a coding agent

Status: draft, revised after devils-advocate review · 2026-09-28

## Why

orx is a chat client with a tool loop that can call one tool (`currentTime`). The goal is a Claude Code-style agent on OpenRouter: it reads and edits files in the folder it was started in, runs commands, takes slash commands, skills, and `@file` mentions, and later delegates to subagents, with any tool-capable OpenRouter model. Most of the chassis exists: the streaming step loop (`src/core/chat.ts`), Effect AI toolkits (`src/tools/`), the TUI, its bridge and an overlay picker (`src/tui/`), chat persistence, a stub OpenRouter that scripts tool calls, and evals.

## Scope

Phase 1: workspace root, file and shell tools, a permission gate with modes and an approval UI, a coding system prompt with AGENTS.md/CLAUDE.md, full tool history across turns, context management, slash commands (built-ins and markdown custom commands), skills, and the `@` file picker. Phase 2: subagents, TodoWrite, summarizing compaction. Phase 3: listed under Phases.

Out: auth beyond the API key, TUI animations, an OS sandbox, MCP client, hooks, LSP, Windows.

## Design

### Entry point

A bare `orx` launches the agent session, like `claude`: the TUI with `--cwd`, `--model`, `--resume`, and `--dangerously-skip-permissions`. `orx chat` goes away; its TUI becomes the session. The other subcommands (`ask`, `models`, `chats`, `export`, `mcp`, `update`, `doctor`) stay. Today a bare `orx` prints help; the root command gains a handler, and `orx --help` still prints help. Check early in 1a that `effect/unstable/cli` routes a root handler and subcommands without treating a subcommand name as a positional.

### Workspace

The root is the process cwd at launch, or `--cwd <dir>` on `orx` and `ask`, realpathed once. orx refuses to start the agent with the root at `$HOME` or `/` unless `--cwd` names it explicitly (a bad `--cwd` is `BadInput`). A `Workspace` service (`src/services/workspace.ts`, `layer` and `layerTest(root)`) exposes `root` and `resolve(path)`: absolute or root-relative paths, realpath of the nearest existing ancestor, and a tool failure (not an `AppError`, so no new exit code) for anything outside the root, symlinks included. File tools never touch a path that didn't go through `resolve`. `bash` is not confined: it runs with the root as cwd and can reach anything the user can. The RFC says that plainly and the permission model is built on it. `StoredChat` gains `cwd`; `--resume` warns when it differs, and starts with an empty `FileState`, so edits need a fresh read.

### Tools

A new `AgentTools` toolkit in `src/tools/` holds the agent's tools, one file each, schemas in `src/schemas/tools.ts`. It is separate from `ChatTools` because `McpTools` merges `ChatTools` (`src/tools/mcp.ts:20`), and file and shell tools over MCP would bypass the approval gate; `orx mcp` keeps serving `currentTime` and `extractContact` only. Tools use `failureMode: "return"` with a failure schema, so bad input and errors reach the model as tool results. Handlers get `FileSystem`, `Path`, `Workspace`, `FileState`, and `Permissions` by capturing `Effect.context` inside `toLayer(Effect.gen(...))`, as `src/tools/mcp.ts` does. Output limits are constants in one file.

- `read {path, offset?, limit?}`: numbered lines (`cat -n` style), 2000 lines default, lines over 2000 chars cut, notes for empty, binary, or offset past the end. Records `{mtimeMs, size, hash}` in `FileState`.
- `write {path, content}`: creates parent dirs; an existing file must be in `FileState` and unchanged on disk, or the tool says "read it first" / "changed since you read it".
- `edit {path, old_string, new_string, replace_all?}`: same read and staleness checks. Before matching it strips `cat -n` prefixes the model pasted into `old_string` and normalizes CRLF (writing back with the file's original line endings). Exact match first; on zero matches, one fallback matching lines with trailing whitespace and leading indentation normalized, re-indenting `new_string` by the indent delta of the matched block. Zero or several matches return an error with the count. The unified diff is computed before approval, shown in the prompt, and returned as the result.
- `glob {pattern, path?}`: walks the root through `FileSystem`, skips `.git` and `.gitignore` matches (`ignore` package), matches with `picomatch`, sorts by mtime, caps at 100.
- `grep {pattern, path?, glob?, output_mode?, head_limit?}`: `rg --json` through Effect `ChildProcess` when `rg` is on PATH, else a JS fallback over the glob walker with a 5 MB per-file cap. Default `files_with_matches`, 100 results.
- `bash {command, timeout_ms?, description?}`: Effect `ChildProcess` (`effect/unstable/process`, platform-free, so the boundary holds) running `/bin/bash -c` in the root, never `$SHELL` (fish and nushell break the syntax models write). Stdin closed; env is a scrubbed copy built in `src/config.ts` (no `OPENROUTER_API_KEY` or other orx secrets) plus `GIT_EDITOR=true`, `GIT_TERMINAL_PROMPT=0`, `PAGER=cat`. No persistent shell: cwd and env reset each call and the prompt says so. Timeout 2 min default, 10 max. Merged output truncated to 30k chars keeping head and tail, exit code in the result. Interrupting kills the process group.

No LS, no WebFetch in phase 1.

### Permissions

A `Permissions` service decides allow, deny, or ask per call. `read`, `glob`, and `grep` inside the workspace are allowed, except secret-shaped paths (`.env*`, `*.pem`, `*.key`, `id_*`), which ask in every mode, the `@` picker included. `write`, `edit`, and `bash` depend on the mode:

- `default`: ask for every write, edit, and bash.
- `acceptEdits`: writes and edits allowed, bash asks. Writes to `.git/`, `package.json`, `lefthook.yml`, `AGENTS.md`/`CLAUDE.md`, and `.orx/commands/` still ask, since a later approved command would run them.
- `plan`: write, edit, and bash denied with "plan mode: describe the change instead".
- `yolo` (`--dangerously-skip-permissions`): everything allowed. File tools stay confined; bash doesn't, and the flag's help text says so.

Shift+Tab cycles `default → acceptEdits → plan`; the footer shows the mode. An answer is yes once, "always this session", or no with an optional note returned to the model. For edits, "always" switches to `acceptEdits`. For bash, "always" matches the exact command string, and isn't offered when the command contains `;`, `&`, `|`, `$`, backticks, `>`, or `<`. Prefix rules like `Bash(bun run *)` wait for phase 3.

Mechanism: the gate lives in the tool handler. Effect AI forks handlers after the step's tool calls arrive and holds the step's finish until they complete (`LanguageModel.ts` around 1561-1697), so a handler waiting on a `Deferred` pauses the step cleanly, and interrupting the turn interrupts the wait. The request is not a side channel: `runTurn` merges the permission queue into the `TurnEvent` stream as `approval-request {id, tool, summary, diff?}` and `approval-cancelled {id}` (on interrupt, so the UI closes the panel), and the bridge exposes `answer(id, decision)`. Effect AI's native `needsApproval` flow was rejected: it ends the step and costs a model round trip per approval.

Tool calls in one step run concurrently (Effect AI's default). A per-path lock inside the tools covers the whole mutating sequence (compute diff, ask, recheck staleness, write, update `FileState`), and a global semaphore keeps one approval panel open at a time, so parallel edits to one file serialize instead of racing or failing as "changed since read".

Headless `ask` gets tools only with `--agent` (opt-in, so the pipe-friendly Q&A command doesn't change). With `--agent` it takes `--permission-mode default|acceptEdits|plan|yolo`; in `default`, anything that would ask is denied with a note that it needs an interactive session, and `ask --json` emits a `permission-denied` event.

### The turn loop

Changes to `src/core/chat.ts`:

- History replay. `ToolStep` (`src/schemas/chat.ts:22`) has no call ids, one flat text per reply, and drops part metadata such as the `reasoningDetails` `@effect/ai-openrouter` attaches to tool calls and sends back as `reasoning_details`; reasoning models can reject replayed tool calls without them. So `AssistantMessage` gains `steps`: each step's `Prompt.fromResponseParts(parts)` encoded with the Prompt schema, replayed verbatim by `toPrompt`. `ToolStep` stays for display and export. Chats saved earlier replay as text. On interrupt, every tool call without a result gets a synthetic "interrupted by user" result, or the next request fails on an unanswered `tool_call_id`.
- Context management. The models list gives `context_length` (the wire schema gains it and `supported_parameters`). Before each step, if the estimated prompt passes 60% of the window, tool outputs over 2k chars are replaced with a stub ("[read src/x.ts elided, re-read if needed]"), oldest first, including earlier steps of the current turn; the last 2 steps are never elided. A context-length error from the provider triggers one elide-harder-and-retry. Anthropic models get `cache_control` breakpoints on the system prompt and the latest step (the provider supports it), so long turns don't resend the full prefix at full price.
- Limits: `MAX_TOOL_STEPS` default 5 → 50 for the agent, `MAX_OUTPUT_TOKENS` 1024 → 8192. Hitting the step cap ends the turn with a visible note.
- The whole-turn `Stream.interruptWhen(maxStreamDuration)` (`chat.ts:306`) is replaced by an idle timeout between model chunks (`MAX_STREAM_SECONDS` keeps its name and meaning shifts; README and `.env.example` updated). Tools keep their own timeouts; an approval wait has none.
- Repeated-call guard: the same tool with identical input three times in a row ends the turn with a note.
- `tool-result` reaches the UI (`toUiEvent` drops it today).

### System prompt and memory

`src/core/prompt.ts` (pure, unit tested) builds the agent prompt: tool rules (read before edit, prefer edit over write, glob/grep over bash for search, no persistent shell), an environment block (root, platform, date, git repo or not, branch), then memory: `~/.config/orx/AGENTS.md`, then each directory's `AGENTS.md` from the git root (or the root) down to the workspace root, with `CLAUDE.md` used where there's no `AGENTS.md`. No `@path` import expansion in phase 1. Memory capped at 32 KiB with a truncation note. `SYSTEM_PROMPT` still replaces the base prompt; memory is appended either way. Built once per session so the prefix stays stable for caching.

### Models

The picker lists only models whose `supported_parameters` include `tools`; requests set `provider.require_parameters: true`. A default model without tools is a usage error with the reason. When the models list is unavailable, orx starts and trusts the configured model. Switching models mid-chat is allowed; replayed `reasoning_details` from another provider are dropped on switch.

### Slash commands

Input starting with `/` parses in `src/tui/commands.ts` (pure, no `effect`) into `{name, args}`. Typing `/` opens a completion list; the model picker's overlay (`src/tui/model-picker.tsx`: bordered box, filter input, `<select>`) is generalized into `src/tui/picker.tsx` and shared by the model, command, and file pickers.

Built-ins: `/help`, `/clear`, `/model`, `/mode <name>`, `/export`, `/quit`. Custom commands (saved prompts): `.orx/commands/*.md` in the workspace and `~/.config/orx/commands/*.md`, subdirectories namespaced as `dir:name`, frontmatter `description` and optional `model` (decoded with an open schema so unknown keys are ignored), body with `$ARGUMENTS` replaced, or `ARGUMENTS: …` appended when absent. Custom commands grant nothing: no `allowed-tools`, no `` !`cmd` `` expansion, so everything they cause still goes through the gate. `.claude/commands/` compatibility waits for phase 2, since those commands lean on `allowed-tools`, shell expansion, and Task. Loading lives in `src/core/commands.ts`, reached through the bridge as `listCommands()` and `expandCommand(name, args)`. An unknown command shows an inline error and sends nothing.

### Skills

A skill is a directory with a `SKILL.md`: frontmatter `name` and `description` (open schema, unknown keys such as `allowed-tools` ignored and granting nothing), then a Markdown body, plus any supporting files the body points to. Skills load from `.orx/skills/*/SKILL.md` in the workspace and `~/.config/orx/skills/*/SKILL.md`, through the same loader as custom commands; a workspace skill wins a name clash, and a skill and a command with one name is a load warning with the command winning. Only names and descriptions go in the system prompt (built once per session, so the prefix stays stable); a skill over 500 lines or with a description over 1024 chars loads with a warning.

The model loads a skill with a `skill {name}` tool, which returns the body as its result, with a note giving the skill's directory. The user loads one with `/name args`: the body becomes the user message, with args appended as `ARGUMENTS: …`. Either way the body stays in history like any other message; skill results are exempt from context elision. Supporting files are read with `read`, which treats each loaded skill's directory as an extra read-only root, so a user-level skill under `~/.config/orx/skills/` works without widening the workspace. Skills never run anything on load; scripts they mention go through `bash` and the gate. `.claude/skills/` compatibility is phase 2.

### The @ file picker

Typing `@` opens the shared picker over the workspace file list (the glob walker, cached per session, refreshed on open), ranked by fuzzy subsequence with basename hits first. Selecting inserts `@relative/path`. On submit, each `@path` token that resolves inside the workspace is read through the `read` implementation, subject to the same permission rules (a secret-shaped path asks), and attached to the user message as a `<file path="...">` block with line numbers, recorded in `FileState`. Over 2000 lines attaches the first 2000 with a note; `@dir/` attaches a listing. Typed `@path` tokens work without the picker, so the picker is the last step of phase 1 and can slip without blocking the rest. The input is uncontrolled today (`app.tsx` remounts it to clear; see Build workarounds in `AGENTS.md`); inserting text needs either a remount with a new default value or a fix for controlled input. Try the fix first, since the command picker needs the same thing.

### TUI

One line per tool call with a status (`running`, `ok`, `error`, `denied`) and a summary (`read src/x.ts · 120 lines`, `bash bun test · exit 1`); edit and write show the diff, collapsed past 20 lines. The approval panel sits above the input with the diff or command and `y / a / n`; the input is unfocused while it's open. Esc interrupts the step, kills a running bash, and closes an open panel. Colors from `theme.ts`, following `DESIGN.md` and the tui-design-slop skill.

### Repo conventions this touches

`scripts/vanilla.ts` deletes an explicit `REMOVE` list; every new product file (`services/workspace.ts`, `core/prompt.ts`, `core/commands.ts`, `core/skills.ts`, `tui/commands.ts`, `tui/picker.tsx`, the new tools) is added to it in the PR that creates it, and shared files edited here (`src/config.ts` and others under `template/vanilla/`) are mirrored there, or the vanilla workflow fails. New env vars go in `config.ts`, `.env.example`, and the README. The stub OpenRouter sends one tool call per request (`tests/helpers/stub-openrouter.ts:257`); it gains scripted steps with several tool calls and text plus tool calls in one step before the parallel-call and locking tests can be written.

## Phases

Phase 1, "it edits code", in PR-sized steps, each leaving `bun run check` green:

- 1a: stub upgrades, Workspace, FileState, `AgentTools` with read/glob/grep, `steps` history replay, models schema (`context_length`, `supported_parameters`), context elision, idle timeout, prompt and memory, limits.
- 1b: write/edit/bash, Permissions, approval events and panel, modes, `ask --agent`, Anthropic cache breakpoints.
- 1c: slash commands and skills: parser, shared picker, built-ins, the command and skill loader, custom commands, the `skill` tool.
- 1d: `@path` expansion on submit, then the `@` picker.

Phase 2, "it delegates": a `task` tool running a subagent as a nested `runTurn` with a fresh prompt (task, memory, env block), a restricted toolkit, no `task` of its own, its own step cap, returning only its final text with usage added to the parent's cost; approvals from a subagent surface in the parent's panel. Agent files in `.orx/agents/*.md` (`name`, `description`, `tools`, `model`), built-in `explore` (read-only) and `general`; agent files may list skills to preload. `.claude/commands`, `.claude/agents`, `.claude/skills` compatibility. `todo` tool with a TUI list. `/compact` and automatic summarization.

Phase 3: allow/deny rules in the config file, persistent shell, checkpoints and `/rewind`, `` !`cmd` `` in commands behind the gate, WebFetch, per-model edit formats (`apply_patch` for codex models), MCP client, hooks, an OS sandbox for bash.

## Open questions

- `.orx/` is already `bun run orx`'s data dir in this checkout (`.orx/data`); project commands at `.orx/commands/` share it. Fine unless another name is wanted.
- The 60% elision threshold and the 2-step protected window are guesses; the coding eval should tune them.

## Verification

Unit (vitest, `runCli` and direct program tests): `Workspace.resolve` rejects `..`, outside absolutes, and symlink escapes; root at `$HOME` refused; edit's exact, prefix-stripped, CRLF, indent-fallback, ambiguous, and stale cases; read numbering and truncation; bash timeout, truncation, scrubbed env (`env` doesn't show the key), and kill on interrupt; permission decisions per mode, protected paths, secret paths, and "always" refusal for compound commands; parallel edits to one file serialize; memory order and cap; command parsing and `$ARGUMENTS`; skill loading, name clashes, descriptions in the prompt, the `skill` tool returning the body, `/name` expansion, reading a supporting file from a user-level skill dir, and skill results surviving elision; a stub-scripted read → edit turn asserting the file changed and the next request carries the tool result with its call id; replay across two turns; synthetic results after an interrupted tool call; elision under a small `context_length`; `ask --agent --permission-mode default` denying an edit; `orx mcp` tools/list unchanged. TUI (bun test, fake bridge): approval panel keys and cancel, `/` completion, `@` picker insertion, tool line statuses. Closed loop: the real bridge against the stub editing a file in a temp workspace. `tui:capture` smoke per step. Evals: a coding case in `evals/cases.ts` (temp repo, a rename across files, scored by file contents and a test command) against 2-3 real models before phase 1 is called done.

## Review notes

The devils-advocate review changed the draft in these ways:

- Tool history replay needed a new stored shape (`steps` with encoded Prompt parts and reasoning details), not just call ids, plus synthetic results for interrupted calls.
- Context overflow could permanently break a chat, since a context-length error is not retryable and replay resends it: elision now runs within a turn against `context_length`, with one retry, and Anthropic cache breakpoints moved from phase 3 to 1b.
- The confinement claims were wrong for bash. Now: bash is stated as unconfined, "always" means the exact command and is refused for compound commands, the child env is scrubbed, root at `$HOME` or `/` is refused, secret paths always ask, and `acceptEdits` still asks for hooks, scripts, and memory files. `ask` gets tools only with `--agent`.
- `McpTools` merges `ChatTools`, so the agent tools live in a separate `AgentTools` toolkit.
- The per-step timeout would have included bash runs; it's an idle timeout between chunks now. The approval queue joined the `TurnEvent` stream with an `approval-cancelled` event instead of being a side channel. The lock covers the whole diff, approve, write, `FileState` sequence.
- Edit robustness: CRLF, pasted line-number prefixes, re-indentation after a fuzzy match, diff before approval. bash uses `/bin/bash` with closed stdin and non-interactive git and pager settings.
- `OutsideWorkspace` became a tool failure instead of an `AppError`; new files go on vanilla's `REMOVE` list; the stub and models schema work is budgeted in 1a.
- The reviewer recommended moving custom commands to phase 2 and dropping the `@` picker UI. The user kept both in phase 1; custom commands grant nothing and `.claude/commands` compatibility moved to phase 2, and the picker is the last step so it can slip.

## What changed during execution

`ask` stays a plain Q&A command: it gets the workspace tools only with `--agent`, and `--cwd` and `--permission-mode` without `--agent` are usage errors rather than silently ignored. With `--agent`, a call the headless gate denies emits a `permission-denied` event (`{type, id, tool, message}`) right before that call's `tool-result`, so a script can tell "the model's tool failed" from "orx wouldn't let it run". `MAX_OUTPUT_TOKENS` is 8192 for every command, not only the agent; OpenRouter checks credit against input plus `max_tokens` before a call, so the README tells a user who sees a 402 "can only afford" error to lower it.

`yolo` allows secret-shaped reads. The design had them asking in every mode; the user decided that `--dangerously-skip-permissions` should mean nothing asks, and the flag's name already carries the warning. `grep` never searches secret-shaped files in any mode and says how many it skipped, since a match line would leak the value without anyone approving a read. Protected paths grew `.orx/skills/` (a skill's body becomes instructions the model follows) and are compared case-insensitively, so `.GIT/config` on a case-insensitive filesystem is still `.git/config`. "Always" is narrower than designed: it isn't offered for reads, for compound commands (newlines now count), or for secret and protected paths, where accepting it would promise more than the resulting mode allows.

Anthropic cache breakpoints sit only on the system prompt and the last user message. The design wanted one on the latest tool step, but `@effect/ai-openrouter` sends `cache_control` only on system and user messages, so a long tool loop re-reads its own steps uncached until the next user message.

`AssistantMessage.steps` is an array of `Prompt`s, one per model step (`Prompt.fromResponseParts`), encoded with the Prompt schema, rather than a flat list of parts: a step boundary is where an interrupted step gets its synthetic results, and replay needs the boundaries intact. Replies also store `requestedModel`, the model the turn asked for, and replay drops another model's reasoning by comparing it with the next turn's requested model. The served `model` can differ from the requested one (a fallback from `OPENROUTER_FALLBACK_MODELS`, or an id OpenRouter reports differently), so comparing against it would treat staying on the same model as a switch and throw away reasoning that model needs.

The footer shows only the keys that fit in 80 columns; `/help` lists every key and built-in. The design's footer carried all of them and wrapped on a normal terminal.

`@` attachments are stored beside the message, not in it. The first version appended the `<file>` blocks to the user's text, so `--resume`, exports, and `orx chats` titles showed whole files, and the blocks could never be elided. `UserMessage.attachments` now holds them, `toPrompt` sends them as a second text part marked for eliding, and older messages' attachments are elided like old tool outputs (the latest message's never are). Attaching moved from the TUI component into the bridge's `send`, so a component can't store the expanded text by mistake.

Chats remember their workspace (`StoredChat.cwd`). `--resume` from a different directory exits 2 naming both paths, and an explicit `--cwd` chooses where to continue. A note on stderr was the alternative, but the TUI takes over the alternate screen immediately, so nobody would read it, and a chat whose history names files in another tree can point the model at the wrong files.

A review reported that approval events published after a turn's stream closes would show a stale approval request in the next turn. A test that stops a turn with an approval open (two parallel calls, one waiting its turn to ask) found only a leftover `approval-cancelled` in the queue, which the next turn already drops because it only passes cancellations for requests it showed. The test stays as a pin; nothing else changed.

The coding eval landed as `rename-across-files` in `evals/cases.ts`: a small TypeScript project in a temp directory, the prompt asks to rename a function everywhere, and the run goes through the real CLI (`ask --agent --permission-mode acceptEdits --json`). It's scored on the files (no old name left, the new name wherever the old one was, no files added or removed) and a script that imports the renamed function and checks the outputs. Its scoring is unit-tested, including that the script fails before the rename and passes after; it hasn't been run against real models yet.

`bun run vanilla` also drops `diff`, `ignore`, and `picomatch` (and `@types/picomatch`), which only the agent's file tools import.

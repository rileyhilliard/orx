# Phase 1: it edits code

Status: EXECUTED 2026-09-28, verification step still open (the coding eval has not run against real models) | Size: XL | Depends on: none

This was RFC 0001 (`plans/0001-coding-agent.md`, drafted, reviewed, and executed 2026-09-27 to 2026-09-28). It is now the record of what phase 1 designed and what it built. Where the design and the code disagree, the code wins and the disagreement is written down under "What changed during execution" or "Corrections to the design". Symbols are cited instead of line numbers, per `plans/README.md`.

## Why

Before phase 1, orx was a chat client with a tool loop that could call one tool (`currentTime`). The goal was a Claude Code-style agent on OpenRouter: it reads and edits files in the folder it was started in, runs commands, takes slash commands, skills, and `@file` mentions, and later delegates to subagents, with any tool-capable OpenRouter model. Most of the chassis already existed: the streaming step loop (`src/core/chat.ts`), Effect AI toolkits (`src/tools/`), the TUI with its bridge and an overlay picker (`src/tui/`), chat persistence, a stub OpenRouter that scripts tool calls, and evals.

## Scope

In: a workspace root, file and shell tools, a permission gate with modes and an approval UI, a coding system prompt with AGENTS.md/CLAUDE.md memory, full tool history across turns, context management, slash commands (built-ins and Markdown custom commands), skills, and the `@` file picker.

Out, and now tracked in [phase 2](phase-2-delegates.md), [phase 3](phase-3-runs-unattended.md), or [follow-ups](follow-ups.md): subagents, a todo tool, summarizing compaction, auth beyond the API key, TUI animations, an OS sandbox, an MCP client, hooks, LSP, Windows.

## What shipped

| Step | Commits | What it added |
| --- | --- | --- |
| 1a | `730285e`, `2d5f147`, `8ddf34f` | `Workspace` and `FileState` services, `AgentTools` with `read`/`glob`/`grep`, `steps` history replay, the models schema's `context_length` and `supported_parameters`, context elision, the idle timeout, the agent prompt and memory, the step and repeat guards, scripted multi-call stub steps |
| 1b | `ea4ca43`, `11667ea`, `5c1b0b0`, `cfb3046`, `b2f736a`, `127dff6`, `c7118dd` | `write`/`edit`/`bash`, the `Permissions` service, approval events and the approval panel, modes and Shift+Tab, `ask --agent`, Anthropic cache breakpoints, refusing models without tool calling, `permission-denied` events |
| 1c | `a5f3d74`, `bbe19d4` | Slash command parsing, the shared picker, built-ins, the command and skill loader, custom commands, the `skill` tool, bare `orx` as the session |
| 1d | `fbd6245`, `b6c7334`, `be690cb`, `8ece2be` | `@path` attachments and the `@` picker, attachments stored beside the message, chats tied to their workspace, grep and glob hardening |
| Eval | `53611cf` | The `rename-across-files` case in `evals/cases.ts` |
| Docs | `a1b39e5` | README, AGENTS.md architecture map, DESIGN.md for the approval panel and pickers |

Everything in scope shipped. The one thing the RFC made a condition of calling phase 1 done, running the coding eval against two or three real models, has not happened (see "Still open").

## Design, as built

### Entry point

A bare `orx` launches the agent session, like `claude`: the TUI with `--cwd`, `--model`, `--resume`, and `--dangerously-skip-permissions` (`src/commands/session.ts`, wired as the root handler in `src/cli.ts`). `orx chat` is gone; its TUI became the session. The other subcommands (`ask`, `models`, `extract`, `chats`, `export`, `mcp`, `update`, `doctor`) stay, and `orx --help` still prints help.

### Workspace

The root is the process cwd at launch, or `--cwd <dir>` on `orx` and `ask --agent`, realpathed once (`Workspace.resolveRoot`). orx refuses to start with the root at `$HOME` or `/` unless `--cwd` names it explicitly; a bad `--cwd` is `BadInput`. The `Workspace` service (`src/services/workspace.ts`, `Workspace.layer(root)` and `Workspace.layerTest(root)`) exposes `root` and `resolve(path)`: absolute or root-relative paths, realpath of the nearest existing ancestor, and a tool failure (not an `AppError`, so no new exit code) for anything outside the root, symlinks included. File tools never touch a path that didn't go through `resolve`. Loaded skills' directories are extra read-only roots (`addReadRoot`).

`bash` is not confined: it runs with the root as cwd and can reach anything the user can. The README says so, and the permission model is built on it.

`StoredChat` has `cwd`. `--resume` from a different directory exits 2 naming both paths, and an explicit `--cwd` chooses where to continue. A resumed session starts with an empty `FileState`, so edits need a fresh read.

### Tools

`AgentTools` (`src/tools/agent.ts`) holds the agent's tools, one file each, with schemas in `src/schemas/tools.ts`. It is separate from `ChatTools` because `orx mcp` serves `ChatTools` (`McpTools` in `src/tools/mcp.ts` merges them), and file and shell tools over MCP would bypass the approval gate; `orx mcp` still serves `currentTime` and `extractContact` only. `SessionTools` in `src/core/session.ts` merges `AgentTools` with `SkillTools`. Tools use `failureMode: "return"` with a `ToolFailure` schema, so bad input and errors reach the model as tool results. Handlers get `FileSystem`, `Path`, `ChildProcessSpawner`, `Workspace`, `FileState`, and `Permissions` by capturing `Effect.context` inside `toLayer(Effect.gen(...))`. Output limits are constants in `src/tools/limits.ts`.

- `read {path, offset?, limit?}`: numbered lines (`cat -n` style), 2000 lines by default, lines over 2000 chars cut, notes for empty, binary, or offset past the end; refuses files over 10 MB. Records `{mtimeMs, size, hash}` in `FileState`.
- `write {path, content}`: creates parent dirs; an existing file must be in `FileState` and unchanged on disk, or the tool says "read it first" or "changed since you read it". UTF-8 only; a byte order mark is kept.
- `edit {path, old_string, new_string, replace_all?}`: the same read and staleness checks. Before matching it strips `cat -n` prefixes the model pasted into `old_string` (`stripLineNumbers`) and normalizes CRLF, writing back with the file's original line endings. Exact match first; on zero matches, one fallback that compares lines with leading and trailing whitespace trimmed and re-indents `new_string` by the matched block's indentation (`replaceIn`). Zero or several matches return an error with the count. The unified diff is computed before approval, shown in the panel, and returned as the result.
- `glob {pattern, path?}`: walks the root through `FileSystem`, skips `.git` and `.gitignore` matches (`ignore`), matches with `picomatch`, sorts by mtime, caps at 100.
- `grep {pattern, path?, glob?, output_mode?, head_limit?}`: `rg --json` through Effect `ChildProcess` when `rg` is on PATH (checked once per session), else a JS fallback over the glob walker with a 5 MB per-file cap. Default `files_with_matches`, 100 results. Never searches secret-shaped files, and says how many it skipped.
- `bash {command, timeout_ms?, description?}`: Effect `ChildProcess` (`effect/unstable/process`, platform-free, so the boundary holds) running `/bin/bash -c` in the root, never `$SHELL`. Stdin closed; the env is `agentShellEnv()` from `src/config.ts`: the user's environment minus every `OPENROUTER_*` and `ORX_*` variable, plus `GIT_EDITOR=true`, `GIT_TERMINAL_PROMPT=0`, `PAGER=cat`. No persistent shell: cwd and env reset each call, and the tool description and prompt say so. Timeout 2 minutes by default, 10 at most. Merged output keeps the first and last 15k characters of 30k, with the exit code in the result. Interrupting closes the scope, which kills the process group.

There is no LS tool and no WebFetch.

### Permissions

The `Permissions` service (`src/services/permissions.ts`) decides allow, deny, or ask per call; `decide` is the pure rule table, and `permit` in `src/tools/permit.ts` turns a denial into a `ToolFailure` marked `denied`. `read`, `glob`, and `grep` inside the workspace are allowed, except secret-shaped paths (`isSecretPath`: `.env*`, `*.pem`, `*.key`, `id_*`), which ask in every mode but `yolo`. `write`, `edit`, and `bash` depend on the mode:

| Mode | Writes and edits | bash |
| --- | --- | --- |
| `default` | ask | ask |
| `acceptEdits` | allowed, except protected paths | ask |
| `plan` | denied: "plan mode: describe the change instead" | denied |
| `yolo` (`--dangerously-skip-permissions`) | allowed | allowed |

Protected paths (`isProtectedPath`, compared case-insensitively) are anything under `.git/`, `.orx/commands/`, or `.orx/skills/`, and any `package.json`, `lefthook.yml`, `AGENTS.md`, or `CLAUDE.md`: a later approved command would run or load them.

Shift+Tab and `/mode` cycle `default`, `acceptEdits`, `plan`; the footer shows a non-default mode. An answer is yes once, "always this session", or no with an optional note returned to the model. For writes and edits, "always" switches `default` to `acceptEdits`. For bash, "always" matches the exact command string. "Always" isn't offered for reads, for compound commands (`;`, `&`, `|`, `$`, backticks, `<`, `>`, or a newline), or for secret and protected paths.

Mechanism: the gate lives in the tool handler. Effect AI forks handlers after a step's tool calls arrive and holds the step's finish until they complete, so a handler waiting on a `Deferred` pauses the step cleanly, and interrupting the turn interrupts the wait. `runTurn` merges `Permissions.events` into its `TurnEvent` stream as `approval-request {id, tool, summary, diff?, canAlways}` and `approval-cancelled {id}`, and passes only cancellations for requests it showed. The bridge exposes `answer(id, decision)`. Effect AI's native `needsApproval` flow was rejected: it ends the step and costs a model round trip per approval.

Tool calls in one step run concurrently (Effect AI's default). `FileState.withLock(path)` covers the whole mutating sequence in `write` and `edit` (compute the diff, ask, recheck staleness and that the path still resolves to the same file, write, update `FileState`), and a semaphore in `Permissions` keeps one approval panel open at a time. A call that waited for the panel decides again before asking, since an "always" answer or a mode switch may have settled it.

Headless `ask` gets tools only with `--agent`. With `--agent` it takes `--permission-mode default|acceptEdits|plan|yolo` (`Permissions.layerHeadless`); anything that would ask is denied with a note that it needs an interactive session, and `ask --json` emits a `permission-denied` event right before that call's `tool-result`.

### The turn loop

Changes to `src/core/chat.ts`:

- History replay. `AssistantMessage.steps` holds one `Prompt` per model step (`Prompt.fromResponseParts`), encoded with the Prompt schema and replayed verbatim by `toPrompt`, so tool calls keep their ids and the `reasoning_details` `@effect/ai-openrouter` attaches. `ToolStep` stays for display and export. Chats saved before `steps` existed replay as text. On interrupt, `stepPrompt` closes open text and reasoning parts and gives every tool call without a result a synthetic "interrupted" failure, or the next request would fail on an unanswered `tool_call_id`. A reply stores `requestedModel`, and replay drops another model's reasoning by comparing it with the next turn's requested model.
- Context management (`src/core/context.ts`). The models list gives `contextLength`. Before each step, if the estimated prompt (characters / 4) passes `ELIDE_AT` (60%) of the window, tool outputs and older messages' `@` attachments over `ELIDE_MIN_CHARS` (2000) are replaced with a stub, oldest first, including earlier steps of the current turn. The last `PROTECTED_STEPS` (2) steps, `skill` results, and the latest message's attachments are never elided. A context-length error from the provider triggers one retry with every candidate elided. Anthropic models (`anthropic/` ids) get `cache_control` breakpoints on the system prompt and the last user message.
- Limits: `MAX_TOOL_STEPS` defaults to 50 and `MAX_OUTPUT_TOKENS` to 8192, for every command. Hitting the step cap ends the turn with a visible note.
- The whole-turn stream deadline became an idle timeout: `MAX_STREAM_SECONDS` (120) is how long the model may send nothing while no tool runs. Tools keep their own timeouts; an approval wait has none.
- Repeated-call guard: the same tool with identical input `MAX_REPEATED_CALLS` (3) times in a row ends the turn with a note.
- `tool-result` reaches the UI as a one-line summary (`summarizeTool` in `src/tui/tool-summary.ts`).

### System prompt and memory

`src/core/prompt.ts` builds the agent prompt (`buildSystemPrompt`, pure and unit tested): tool rules, an `<env>` block (root, platform, date, git repo or not, branch), the loaded skills' names and descriptions, then memory. Memory is `~/.config/orx/AGENTS.md` (`$XDG_CONFIG_HOME/orx`), then each directory's `AGENTS.md` from the git root (or the workspace root outside git) down to the workspace root, with `CLAUDE.md` where there's no `AGENTS.md`. There is no `@path` import expansion. Memory is capped at 32 KiB with a truncation note. `SYSTEM_PROMPT` replaces the base prompt only; the environment, skills, and memory follow either way. `prepareSession` builds it once per session so the prefix stays stable for caching.

### Models

The picker lists only models whose `supported_parameters` include `tools`, and every request sets `provider.require_parameters: true` (`openRouterSettings` in `src/services/Llm.ts`). `resolveToolModel` makes a model without tool calling a usage error (exit 2) with the reason, the default model included. When the models list is unavailable, orx starts and trusts the configured model. Switching models mid-chat is allowed.

### Slash commands and skills

Input starting with `/` parses in `src/tui/commands.ts` (pure, no `effect`) into `{name, args}`. Typing `/` in an empty composer opens a completion list in the shared overlay (`src/tui/picker.tsx`), which the model and file pickers also use.

Built-ins: `/help`, `/clear`, `/model`, `/mode <name>`, `/export`, `/quit`. Custom commands are saved prompts in `.orx/commands/**.md` in the workspace and `~/.config/orx/commands/**.md`, subdirectories namespaced as `dir:name`, frontmatter `description` and an optional `model` for that turn (decoded with an open schema, so unknown keys are ignored), and a body with `$ARGUMENTS` replaced, or `ARGUMENTS: …` appended when it's absent (`withArguments` in `src/core/commands.ts`). Custom commands grant nothing: no `allowed-tools` and no `` !`cmd` `` expansion, so everything they cause still goes through the gate. An unknown command shows an inline error and sends nothing.

A skill is a directory with a `SKILL.md` (frontmatter `name` and `description`, open schema, then Markdown) in `.orx/skills/*/` or `~/.config/orx/skills/*/`, loaded by `src/core/skills.ts` through the same helpers. A workspace skill or command wins a name clash with the user's; a skill and a command with one name is a load warning and the command wins. Only names and descriptions go in the system prompt. A skill over 500 lines or with a description over 1024 characters loads with a warning. The model loads a skill with the `skill {name}` tool, which returns the body and the skill's directory; the user loads one with `/name args`. Skills never run anything on load.

### The @ file picker

Typing `@` at the start of a word opens the shared picker over the workspace file list (the glob walker: walked on the first open, and each later open answers from the last walk while refreshing it for the next), ranked by fuzzy subsequence with basename hits first (`src/tui/mentions.ts`). Selecting inserts `@relative/path`. On send, the bridge's `attachFiles` (`mentionAttachments` in `src/core/mentions.ts`) reads each `@path` that resolves inside the workspace through the `read` implementation, subject to the same rules (secret-shaped paths are not attached), and stores the `<file path="...">` blocks in `UserMessage.attachments`. Over 2000 lines attaches the first 2000 with a note; `@dir/` attaches a listing.

### TUI

One line per tool call: running, then `→ read src/x.ts · 120 lines` or `→ bash bun test · exit 1`; a failed or denied call shows the failure message on that line; an edit's diff sits under it, collapsed past 20 lines (`DIFF_MAX_LINES`). The approval panel sits unbordered above the composer with the command or the diff and `y / a / n`; the composer is unfocused while it's open, and after `n` it takes an optional note. Esc interrupts the step, kills a running bash, and closes an open panel. Colors come from `theme.ts`, per `DESIGN.md`.

### Repo conventions this touched

`scripts/vanilla.ts` deletes an explicit `REMOVE` list; every new product file went on it in the PR that created it, and `bun run vanilla` also drops the `diff`, `ignore`, and `picomatch` dependencies. New env vars went in `config.ts`, `.env.example`, and the README. The stub OpenRouter gained scripted `steps` with several tool calls, text plus tool calls, reasoning details, and slow chunks.

## Verification, as planned

Unit (vitest, `runCli` and direct program tests): `Workspace.resolve` rejects `..`, outside absolutes, and symlink escapes; root at `$HOME` refused; edit's exact, prefix-stripped, CRLF, indent-fallback, ambiguous, and stale cases; read numbering and truncation; bash timeout, truncation, scrubbed env, and kill on interrupt; permission decisions per mode, protected paths, secret paths, and "always" refusal for compound commands; parallel edits to one file serialize; memory order and cap; command parsing and `$ARGUMENTS`; skill loading, name clashes, descriptions in the prompt, the `skill` tool, `/name` expansion, reading a supporting file from a user-level skill dir, and skill results surviving elision; a stub-scripted read then edit turn asserting the file changed and the next request carries the tool result with its call id; replay across two turns; synthetic results after an interrupted tool call; elision under a small `context_length`; `ask --agent --permission-mode default` denying an edit; `orx mcp` tools/list unchanged. TUI (bun test, fake bridge): approval panel keys and cancel, `/` completion, `@` picker insertion, tool line statuses. Closed loop: the real bridge against the stub editing a file in a temp workspace. `tui:capture` smoke per step. Evals: a coding case against two or three real models before phase 1 is called done.

All of it landed except the last sentence.

## Review notes

The devils-advocate review changed the draft in these ways:

- Tool history replay needed a new stored shape (`steps` with encoded Prompt parts and reasoning details), not just call ids, plus synthetic results for interrupted calls.
- Context overflow could permanently break a chat, since a context-length error is not retryable and replay resends it: elision runs within a turn against `context_length`, with one retry, and Anthropic cache breakpoints moved from phase 3 to 1b.
- The confinement claims were wrong for bash. Now: bash is stated as unconfined, "always" means the exact command and is refused for compound commands, the child env is scrubbed, root at `$HOME` or `/` is refused, secret paths ask, and `acceptEdits` still asks for hooks, scripts, and memory files. `ask` gets tools only with `--agent`.
- `McpTools` merges `ChatTools`, so the agent tools live in a separate `AgentTools` toolkit.
- The per-step timeout would have included bash runs; it's an idle timeout between chunks now. The approval queue joined the `TurnEvent` stream with an `approval-cancelled` event instead of being a side channel. The lock covers the whole diff, approve, write, `FileState` sequence.
- Edit robustness: CRLF, pasted line-number prefixes, re-indentation after a fuzzy match, diff before approval. bash uses `/bin/bash` with closed stdin and non-interactive git and pager settings.
- `OutsideWorkspace` became a tool failure instead of an `AppError`; new files go on vanilla's `REMOVE` list; the stub and models schema work was budgeted in 1a.
- The reviewer recommended moving custom commands to phase 2 and dropping the `@` picker UI. The user kept both in phase 1; custom commands grant nothing, `.claude/commands` compatibility moved to phase 2, and the picker was the last step so it could slip. It didn't.

## What changed during execution

`ask` stays a plain Q&A command: it gets the workspace tools only with `--agent`, and `--cwd` and `--permission-mode` without `--agent` are usage errors rather than silently ignored. With `--agent`, a call the headless gate denies emits a `permission-denied` event (`{type, id, tool, message}`) right before that call's `tool-result`, so a script can tell "the model's tool failed" from "orx wouldn't let it run". `MAX_OUTPUT_TOKENS` is 8192 for every command, not only the agent; OpenRouter checks credit against input plus `max_tokens` before a call, so the README tells a user who sees a 402 "can only afford" error to lower it.

`yolo` allows secret-shaped reads. The design had them asking in every mode; the user decided that `--dangerously-skip-permissions` should mean nothing asks, and the flag's name already carries the warning. `grep` never searches secret-shaped files in any mode and says how many it skipped, since a match line would leak the value without anyone approving a read. Protected paths grew `.orx/skills/` (a skill's body becomes instructions the model follows) and are compared case-insensitively, so `.GIT/config` on a case-insensitive filesystem is still `.git/config`. "Always" is narrower than designed: it isn't offered for reads, for compound commands (newlines now count), or for secret and protected paths, where accepting it would promise more than the resulting mode allows.

Anthropic cache breakpoints sit only on the system prompt and the last user message. The design wanted one on the latest tool step, but `@effect/ai-openrouter` sends `cache_control` only on system and user messages, so a long tool loop re-reads its own steps uncached until the next user message. ([Phase 2](phase-2-delegates.md) proposes OpenRouter's request-level `cache_control` and `session_id` to close this.)

`AssistantMessage.steps` is an array of `Prompt`s, one per model step, rather than a flat list of parts: a step boundary is where an interrupted step gets its synthetic results, and replay needs the boundaries intact. Replies also store `requestedModel`, and replay drops another model's reasoning by comparing it with the next turn's requested model. The served `model` can differ from the requested one (a fallback from `OPENROUTER_FALLBACK_MODELS`, or an id OpenRouter reports differently), so comparing against it would treat staying on the same model as a switch and throw away reasoning that model needs.

The footer shows only the keys that fit in 80 columns; `/help` lists every key and built-in. The design's footer carried all of them and wrapped on a normal terminal.

`@` attachments are stored beside the message, not in it. The first version appended the `<file>` blocks to the user's text, so `--resume`, exports, and `orx chats` titles showed whole files, and the blocks could never be elided. `UserMessage.attachments` now holds them, `toPrompt` sends them as a second text part marked for eliding (`ATTACHMENT_OPTIONS`), and older messages' attachments are elided like old tool outputs (the latest message's never are). Attaching moved from the TUI component into the bridge's `send`, so a component can't store the expanded text by mistake.

Chats remember their workspace (`StoredChat.cwd`). `--resume` from a different directory exits 2 naming both paths, and an explicit `--cwd` chooses where to continue. A note on stderr was the alternative, but the TUI takes over the alternate screen immediately, so nobody would read it, and a chat whose history names files in another tree can point the model at the wrong files.

A review reported that approval events published after a turn's stream closes would show a stale approval request in the next turn. A test that stops a turn with an approval open (two parallel calls, one waiting its turn to ask) found only a leftover `approval-cancelled` in the queue, which the next turn already drops because it only passes cancellations for requests it showed. The test stays as a pin; nothing else changed.

The coding eval landed as `rename-across-files` in `evals/cases.ts`: a small TypeScript project in a temp directory, the prompt asks to rename a function everywhere, and the run goes through the real CLI (`ask --agent --permission-mode acceptEdits --json`). It's scored on the files (no old name left, the new name wherever the old one was, no files added or removed) and a script that imports the renamed function and checks the outputs. Its scoring is unit-tested, including that the script fails before the rename and passes after.

## Corrections to the design

Found while turning the RFC into this record, checked against the code at `a1b39e5`:

- `MAX_TOOL_STEPS` went from 5 to 50 for every command, not "for the agent" only; plain `ask` shares the limit (`config.limits.maxToolSteps`).
- The TUI has no `denied` tool status. `UiToolCall.status` is `running`, `ok`, or `error`; a denied call is an `error` line whose summary carries the denial message. `ask --json` is where denial is distinct (`permission-denied`).
- The per-path lock lives in `FileState.withLock`, not inside the tools; `write` and `edit` take it.
- `Workspace.layer` takes the root (`Workspace.layer(root)`); `layerTest(root)` skips only the `$HOME` and `/` check.
- The scrubbed shell env removes `OPENROUTER_*` and `ORX_*`. Other credentials in the user's shell (`AWS_*`, `GITHUB_TOKEN`) reach `bash`. That matches the RFC's wording ("no orx secrets") but is worth knowing; [phase 3](phase-3-runs-unattended.md) revisits it with the sandbox.
- Custom command and skill loading is shared through helpers in `src/core/commands.ts` (`parseMarkdown`, `decodeFrontmatter`, `slashDirs`); there is no separate loader module.

## Still open

- **Run the coding eval against real models.** `rename-across-files` has never run against a real model: there is no `evals/results/` in the checkout or the main tree. The RFC made this the gate for calling phase 1 done. Run `bun run eval --models <two or three tool-capable models>` (for example one Anthropic, one OpenAI, one open-weight model) and record pass rates, steps, and cost here. It needs a key and costs a little money, so it's a user action.
- **Tune the elision threshold.** `ELIDE_AT` (0.6) and `PROTECTED_STEPS` (2) are guesses. Nothing measures them yet: `rename-across-files` is too small to reach 60% of any current window. Tuning needs a long-context case (a task that reads more than the window can hold, so elision has to fire) and a comparison of pass rate and cost at, say, 0.5, 0.6, and 0.75. [Phase 2's](phase-2-delegates.md) compaction work depends on the answer, so the case is scheduled there.
- **The headless denial message names `orx chat`.** `HEADLESS_DENIAL` in `src/services/permissions.ts` says "run orx chat", which no longer exists; it should say "run orx". One-line fix with a test on the message.
- **`DESIGN.md` says the footer "always lists" every key.** The footer shows a fixed subset (`app.tsx`) and `/help` lists the rest, as decided during execution. `DESIGN.md` should say so.
- **`plans/` ships in the vanilla tree.** `scripts/vanilla.ts`'s `REMOVE` list has `docs/rfcs` but not `plans`, so `bun run vanilla` carries orx's product plans into a blank-slate CLI. Adding `"plans"` to `REMOVE` fixes it.
- **Open question from the RFC, settled:** `.orx/` is both `bun run orx`'s data dir in this checkout (`.orx/data`) and the project commands and skills dir. Nobody objected; it stays.

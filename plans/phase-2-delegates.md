# Phase 2: it delegates

Status: PROPOSED 2026-09-28 | Size: XL (eight PR-sized steps) | Depends on: [phase 1](phase-1-edits-code.md), including its open eval run

Phase 2 lets orx hand work to subagents, keep long sessions going past the context window, and pick up an existing `.claude/` setup without rewriting it. Every claim about the code below was checked at `a1b39e5`; per `plans/README.md`, treat each one as a hypothesis to recheck before the step that relies on it.

## Summary

The headline is a `task` tool that runs a subagent as a nested turn with its own history, a restricted toolkit, and optionally a different, cheaper OpenRouter model, returning only its final text to the parent. That is where orx can do something Claude Code can't: an `explore` agent on a fast, cheap model reading a large codebase for a parent running on an expensive one, with the cost of each subagent shown separately.

Around it: agent files (`.orx/agents/*.md`) with built-in `explore` and `general` agents; `.claude/{commands,agents,skills}` and `.agents/skills` compatibility, including `` !`cmd` `` expansion behind the gate; a `todo` tool; `/compact` and automatic summarization; and two pieces of groundwork the rest leans on, OpenRouter session stickiness with request-level prompt caching, and user-level allow/deny permission rules.

Two items moved into this phase from phase 3, and one from the unscheduled list. Allow/deny rules moved because headless `ask --agent` has no middle ground today: `default` denies every command and `yolo` allows all of them, so a CI job that only needs `bun test` has to grant everything. `` !`cmd` `` expansion moved because `.claude/commands` compatibility is hollow without it. `@path` imports in `CLAUDE.md` moved in with the rest of the compatibility work, since memory files that use them currently lose content without a warning. Project-level rules (rules a repository grants itself) stay in [phase 3](phase-3-runs-unattended.md), behind workspace trust.

## Who it's for and the jobs

orx's user is a developer who already works the Claude Code way (an agent in the terminal, approvals, AGENTS.md, slash commands, skills) and wants model choice: a cheaper model for routine work, an open-weight or zero-data-retention route for sensitive code, one OpenRouter key and one bill. Phase 1 gave them the core loop. What they hire phase 2 for:

| Job | Today, without phase 2 | What phase 2 gives them |
| --- | --- | --- |
| "Find out how X works in this big repo without burning my context on it" | The parent reads every file itself; elision stubs out old reads, and the model re-reads | `explore` reads in its own context and returns a summary; the parent's context holds only the answer |
| "Do the grunt reading on a cheap model and the thinking on a good one" | One model per turn | `explore` on `ORX_EXPLORE_MODEL`, with its cost shown apart from the parent's |
| "Run two or three independent investigations at once" | Sequential tool calls | Parallel `task` calls, capped |
| "Use my existing `.claude/` commands, agents, and skills with a non-Anthropic model" | Only `.orx/` is read; `.claude/` is invisible | Both are loaded, `.orx/` wins a clash, and what orx ignores says so |
| "Keep a long session going instead of starting over" | Elision until even that isn't enough, then a context-length error ends the turn | `/compact`, and automatic compaction at the start of a turn |
| "Let a CI job run tests but nothing else" | `ask --agent` with `default` (no commands) or `yolo` (every command) | `--allow 'Bash(bun test *)'` |
| "See what the agent plans to do on a long task" | Nothing between the tool lines | A todo list above the composer |

Not for: people who want an autonomous background agent that opens PRs, or a hosted service. orx stays a local, interactive-first tool with a headless mode.

## How the others do it

Researched 2026-09-28 against each project's current docs. Sources at the end.

| | Claude Code | opencode | Codex CLI | aider |
| --- | --- | --- | --- | --- |
| Delegation | `Agent` tool; `.claude/agents/*.md` with `name`, `description`, `tools`, `model`, `permissionMode`, `maxTurns`, `skills`, `isolation`, and more | `task` tool; `.opencode/agents/*.md` or JSON, primary vs subagent modes | `spawn_agent`, only when asked; TOML agents in `.codex/agents/` | None; architect/editor mode pairs two models |
| Built-in agents | Explore, Plan, general-purpose | general, explore, scout, plus hidden compaction and title agents | default, worker, explorer | n/a |
| Subagent model | Per call, then frontmatter, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model; Explore inherits | Inherits unless `model` is set | `default_subagent_model` | Weak model for summaries and commits |
| Nesting, parallelism | Up to 3 levels, 20 concurrent by default | Undocumented | Parallel, one consolidated answer | n/a |
| Subagent approvals | Surface in the main session, labelled with the agent's name | Per-agent permission config | Surface from inactive threads; headless fails if it can't ask | n/a |
| Commands and skills | Merged into skills; `allowed-tools` pre-approves for that turn; `` !`cmd` `` runs through permission checks | Commands with `` !`cmd` ``, `@file`, `subtask`; reads `.claude/skills` and `.agents/skills` | Skills in `.agents/skills`, capped at 2% of context | `/load` replays a command file |
| Todo | `TaskCreate`/`TaskUpdate` panel; `TodoWrite` is legacy and opt-in on newer models | `todowrite` | `update_plan`, now opt-in | None |
| Compaction | `/compact [focus]`, auto near the window, skills re-injected after | `/compact`, auto on, optional pruning of old tool outputs | Auto at a token limit, local or server-side | Summarizes history past a token limit with the weak model |

Three things to take from this. First, the subagent shape has converged (a tool, Markdown or TOML definitions with name, description, tools, model, built-in explore and general agents), so orx should match it rather than invent one; reading `.claude/agents/` unchanged is worth more than a better format. Second, both Claude Code and Codex made their todo tools opt-in for newer models, which says strong models need them less; orx serves weaker and cheaper models too, so the eval should decide whether `todo` is on by default. Third, nobody but Claude Code documents per-subagent cost, and on OpenRouter cost is the reason to delegate, so orx shows it.

## Scope

In:

- OpenRouter `session_id` per chat and request-level `cache_control`, with cached tokens recorded.
- User-level allow/deny rules: the config file, plus `--allow`/`--deny` on `orx` and `ask --agent`.
- A long-context eval case, and tuning `ELIDE_AT` and `PROTECTED_STEPS` with it (phase 1's open question).
- A `todo` tool and its TUI list.
- The subagent runtime, the `task` tool, and the built-in `explore` agent.
- Agent files in `.orx/agents/` and `~/.config/orx/agents/`, the built-in `general` agent, and `/agents`.
- `.claude/commands`, `.claude/skills`, `.claude/agents` (workspace and `~/.claude/`) and `.agents/skills` compatibility, `` !`cmd` `` expansion behind the gate, `@path` imports in memory files, positional `$1`/`$2` arguments.
- `/compact [focus]` and automatic compaction at the start of a turn.

Out, with where it went:

- Subagents that spawn subagents, background subagents, resuming a finished subagent, worktree isolation: [follow-ups](follow-ups.md). Depth 1 covers explore and general; the rest adds state orx doesn't have a use for yet.
- OpenRouter's server-side `openrouter:subagent` and `openrouter:advisor` tools: [follow-ups](follow-ups.md). `@effect/ai-openrouter` rejects provider-defined tools at `4.0.0-rc.117` (`prepareTools` in `OpenRouterLanguageModel.ts` fails with "Provider-defined tools are unsupported"), and a server-side worker can't call orx's local `read` and `grep` anyway, so it can't be the explorer.
- Honoring `allowed-tools` in commands and `permissionMode`, `hooks`, `mcpServers` in agent files: ignored and reported, never granted. Rules in the user's own config are the way to pre-approve.
- Project-level permission rules, hooks, MCP servers: [phase 3](phase-3-runs-unattended.md), behind workspace trust.
- A session spend cap: [follow-ups](follow-ups.md), with the trigger that would pull it in.

## Experience

### A delegated task in the TUI

The parent calls `task`. The message list shows one tool line for it, and while the subagent works, one progress line under it that updates in place with the subagent's latest tool call. No spinner: the changing line is the progress, per `DESIGN.md`.

```
→ task explore · where are OAuth tokens refreshed?
    grep refreshToken · 6 lines
```

When it finishes, the progress line is replaced by a summary in `faint` (model ids here and below are illustrative):

```
→ task explore · where are OAuth tokens refreshed?
    explore · 9 tools · 41k in / 2.1k out · $0.0040 · google/gemini-3-flash
```

Parallel tasks each get their own pair of lines, in call order. The reply's usage line adds subagent cost after the parent's: `anthropic/claude-sonnet-5 · 12k in / 800 out · $0.041 (+ explore $0.004)`. Esc stops the parent and every running subagent; each subagent's partial transcript is saved as interrupted.

An approval from a subagent uses the same panel, prefixed with the agent's name in `muted` (`general  Run  bun test`), so the user knows the parent didn't ask for it directly. Answers apply session-wide, as they do now: "always" for a command covers the parent and every subagent.

### Agents

`/agents` lists the built-ins and every loaded agent file with its description and model, as unbordered lines like `/help`. There's no `@agent` mention in phase 2: `@` already opens the file picker, and "use the explore agent to..." in plain words works because agent descriptions are in the `task` tool's description.

### Todos

When the model calls `todo`, the list appears between the messages and the composer, unbordered: `›` and `text` for the item in progress, `·` and `muted` for pending, `✓` and `faint` for done, at most 8 rows plus "N more". It stays while any item is open and disappears when the list is all done or the next message is sent. It's derived from the last `todo` call in the chat, so `--resume` shows it again.

### Compaction

`/compact` (optionally `/compact keep the migration plan`) summarizes the chat so far and shows one `muted` line where it happened: `compacted 38 messages · summary 1.4k tokens · $0.003`. Automatic compaction shows the same line with "automatically". The earlier messages stay visible above it and in exports; the model sees only the summary and what follows.

### Headless

`ask --agent --json` gains three event types: `tool-progress {id, message}` for a subagent's progress lines, `usage` detail in `done` (`subagents: [{agent, model, inputTokens, outputTokens, cost}]`), and `agent` on `permission-denied` when a subagent's call was denied. `--allow` and `--deny` (repeatable) add rules for the run:

```bash
orx ask --agent --allow 'Bash(bun test *)' --allow 'Edit(src/**)' --json "fix the failing test in src/price.ts"
```

## Architecture

### How it fits the existing seams

```
src/core/chat.ts        runTurn gains `nested` (no approval merge, no cancelAll, no save);
                        preliminary tool results become `tool-progress` events; compaction
                        boundary in toPrompt
src/core/subagents.ts   runSubagent: a nested runTurn with the agent's prompt, toolkit, model
src/core/agents.ts      agent files: .orx/agents, ~/.config/orx/agents, .claude/agents, built-ins
src/core/compact.ts     the summary call, the compaction message, the auto trigger
src/core/rules.ts       permission rules: parse, match, split compound commands (pure)
src/services/
  subagents.ts          per session: concurrency semaphore, per-call usage and transcripts
  permissions.ts        decide() takes rules; requests carry the agent that made them
src/tools/task.ts       the task tool
src/tools/todo.ts       the todo tool (validates and returns; no state)
src/schemas/            agents.ts (frontmatter), rules in config-file.ts, Usage.subagents,
                        UserMessage.compaction, TurnEvent/AskEvent additions
src/tui/                task progress lines, the todo list, the compaction line, /agents, /compact
```

Dependencies stay one-way: `tools/task.ts` depends on `core/subagents.ts`, which depends on `core/chat.ts` and the services; nothing in `core/chat.ts` imports the task tool. The TUI still sees only the `ChatBridge`.

### The subagent runtime

`runSubagent(agent, prompt)` in `src/core/subagents.ts` builds a history of one user message (the task), a system prompt from `buildSystemPrompt` with the agent's body as the base and the same env and memory as the session (loaded once in `prepareSession`, not per call), and calls `runTurn` with the agent's toolkit and model. It collects the text of the final step and returns it. The `task` tool handler calls it.

Four changes to `runTurn` make nesting safe, all behind a `nested: { agent: string; callId: string }` option:

1. **Approvals.** Today `runTurn` merges `Permissions.events` into its stream and calls `cancelAll` on exit. `events` is a single-consumer queue (`Stream.fromQueue`), so a nested turn would steal the parent's approval requests, and a subagent finishing would cancel its siblings' open approvals. A nested turn does neither: its tool handlers still call `Permissions.check`, the requests still land on the one queue, and the parent's merge delivers them to the UI. Interrupting a subagent interrupts its handlers' `Deferred` waits, which already publish `approval-cancelled` (`ask` in `permissions.ts`).
2. **Which agent asked.** `PermissionRequest` and `ApprovalEvent` gain `agent?: string`. The handler doesn't know it's inside a subagent, so `runSubagent` provides a `CurrentAgent` context reference around the nested stream and `permit` reads it.
3. **Saving.** A nested turn has no `onEnd` save; the parent's reply carries the subagent's transcript (below).
4. **Logging.** The nested turn's `llm call` line carries `agent` and `parentCallId`, under the same `runId`.

The idle watchdog needs no change: the parent counts a running `task` call as a running tool, so its watchdog waits, and the nested turn has its own.

**Progress.** Effect AI handlers get a `HandlerContext` with `preliminary(result)` (`Toolkit.ts`), which streams intermediate tool results through the parent's `LanguageModel.streamText` as `tool-result` parts with `preliminary: true`. `toEvents` in `chat.ts` drops those today. The `task` tool's success schema is a string, each preliminary result is one progress line (the subagent's latest tool summary), and `toEvents` maps preliminary results to a new `tool-progress {id, message}` event. That keeps progress inside the existing stream with no second side channel. Only the final result reaches the model.

**Usage and transcripts.** A per-session `Subagents` service (`src/services/subagents.ts`) holds a semaphore (`MAX_SUBAGENTS`, default 4, so a model that fans out ten `task` calls runs four at a time) and records each finished run's usage and steps by tool call id (`HandlerContext.toolCallId`). The parent's `toReply` reads the records for its own call ids, adds their tokens and cost to `usage`, and stores them in `AssistantMessage.subagents` (`{callId, agent, model, steps, usage, interrupted?}`). `steps` there is never replayed; it's for export and debugging. The parent's replayed history holds only the `task` call and its final text, which is the whole point.

**Toolkits.** `explore` gets `read`, `glob`, `grep`, and `skill`: no `bash`, because orx can't tell a read-only command from another, and Claude Code's Explore running shell commands is exactly the part orx can't make safe without a sandbox. `general` gets every session tool except `task`. An agent file's `tools` list picks from the session tools by name. A subset toolkit is `Toolkit.make(...)` over the same `Tool` definitions; the handlers already in the session layer should serve it, since Effect AI resolves handlers by tool. Verify that in the first PR with a test, before building on it.

**Model.** `explore` defaults to the session's model. `ORX_EXPLORE_MODEL` (and `exploreModel` in the config file) sets another. A default cheap model was the alternative, but it would hard-code one vendor's model into a multi-vendor tool and silently degrade answers for anyone whose default model is strong; the eval measures what a cheap explorer costs in accuracy, and the README can recommend one with numbers. A subagent's model goes through `resolveToolModel`, so one without tool calling fails the `task` call with the reason instead of failing the turn.

**Failure.** A subagent that fails (upstream error, step cap) returns a `ToolFailure` with what it managed and why, and the parent carries on. Hitting its step cap (`maxSteps` in the agent file, default `MAX_TOOL_STEPS`) returns the text so far plus a note.

### OpenRouter specifics

- **Sticky routing.** Every request in a chat sends `session_id` set to the chat id, which makes OpenRouter route the session to one provider from the first turn and keeps its prompt cache warm. Subagent requests send `<chatId>:<callId>`: their prompts share nothing with the parent's, so sharing the parent's key would buy nothing. `OpenRouterLanguageModel.Config` accepts every `ChatRequest` field but `messages`, `tools`, and a few others, and `withConfigOverride` scopes an override to one call, so this needs no provider change.
- **Caching.** Phase 1's breakpoints stop at the last user message because the provider only sends message-level `cache_control` on system and user messages. OpenRouter also takes a request-level `cache_control`, which Anthropic, Bedrock, Vertex, and Azure honor by caching up to the last cacheable block. Sending it for `anthropic/` models (alongside the system breakpoint) should cover a long tool loop's own steps. OpenAI, DeepSeek, Gemini 2.5, and Grok cache automatically. Check each with a recording before claiming it.
- **Measuring caching.** The provider already maps `prompt_tokens_details.cached_tokens` and `cache_write_tokens` into `usage.inputTokens.cacheRead` and `cacheWrite`; orx drops them. `Usage` gains `cachedTokens`, the usage line shows `(34k cached)`, and the `llm call` line logs both. Without this there's no way to tell whether the caching work did anything.
- **Cost per subagent** comes from each response's `usage.cost`, summed client-side as `runTurn` already does. OpenRouter's `trace` field would group requests for users who forward to an observability tool through Broadcast; that's cheap to add later and nobody has asked.
- **Reasoning.** A subagent's history is its own, so replaying `reasoning_details` needs nothing new. Whether `explore` should send a low `reasoning.effort` to save cost is an open question for the eval.

### Permission rules

`src/core/rules.ts` parses and matches rules; `decide` in `permissions.ts` gains a `rules` argument and stays pure. The syntax is the subset of Claude Code's that orx's tools can honor, so rules copy across:

- `Bash(bun test *)` matches a command starting with `bun test `; `Bash(git status)` matches exactly.
- `Read(src/**)`, `Edit(src/**)`, `Write(...)`: gitignore-style globs relative to the workspace root. `Edit` covers `write` and `edit`, as in Claude Code.
- A bare tool name matches every call of it.

Evaluation: deny rules first, in every mode including `yolo`; then allow rules, except that `plan` still denies writes and commands; then the mode table from phase 1. A compound command is split on `;`, `&&`, `||`, `|`, `&`, and newlines, and every part must match an allow rule, while a deny rule matching any part denies the whole command. A command with `$(`, backticks, or a redirection never matches an allow rule; it asks. An explicit allow rule wins over the built-in protected and secret paths, since the user wrote it in their own config.

Sources: `permissions: {allow, deny}` in `~/.config/orx/config.json` (`schemas/config-file.ts`; no env var, since a list of rules in an env var is miserable to write), and `--allow`/`--deny` on bare `orx` and `ask --agent`. A rule that doesn't parse is `InvalidConfig` (exit 3) naming it, so a typo can't silently widen or narrow access. "Always" answers stay exact and session-scoped; writing them back as rules comes with project settings in phase 3.

### Agent files and `.claude/` compatibility

`src/core/agents.ts` loads agent files the way `src/core/skills.ts` loads skills: frontmatter `name`, `description`, `tools`, `model` (an OpenRouter id or `inherit`), `maxSteps`, then the body as the agent's instructions. Unknown keys are ignored and listed once as a load warning ("ignored: permissionMode, hooks"), so a `.claude/agents` file that expects more than orx gives is visible, not silently different.

Claude Code agent files write `tools` as a YAML list (this repo's `.claude/agents/architect.md` does), and `parseFields` in `src/core/commands.ts` only reads `key: value` lines, so today it would read `tools` as empty. The loader needs a real YAML parser: the `yaml` package, used only on frontmatter, is the conventional choice. `Bun.YAML` would work in the binary but breaks the platform boundary. The same parser replaces `parseFields` for commands and skills, so all three read the same frontmatter.

Claude Code's model aliases (`sonnet`, `opus`, `haiku`) don't name an OpenRouter model. They resolve through `modelAliases` in the config file when set, else fall back to `inherit` with a load warning.

Directories, lowest precedence first: `~/.claude/{commands,skills,agents}`, `~/.config/orx/...`, then in the workspace `.agents/skills`, `.claude/...`, `.orx/...`. Later wins a name clash, so a workspace's `.orx/` version of a command beats its `.claude/` one. `slashDirs` grows from two directories to this list. `.agents/skills` is included because it's where Codex and opencode look, and where this repo keeps its own skills (`.claude/skills/` here is symlinks into it).

`isProtectedPath` grows to `.orx/agents/`, `.claude/`, and `.agents/skills/`: an agent's or command's body becomes instructions, same reasoning as `.orx/skills/` in phase 1.

Frontmatter that restricts is honored: a skill's `disable-model-invocation` keeps it out of the system prompt and the `skill` tool, `user-invocable: false` keeps it off the `/` list. Frontmatter that grants (`allowed-tools`, `permissionMode`) is ignored. `argument-hint` shows in the command list, and `$1`, `$2` substitute positional arguments alongside `$ARGUMENTS`.

**`` !`cmd` `` expansion.** Each `` !`cmd` `` in a command's body runs before the message is sent, and its output replaces it. It runs as a `bash` permission request (`summary: "/commit runs git status"`), so the mode, rules, and approval panel apply, and headless without a matching rule denies it. The catch is that approvals only render while a turn's stream is being consumed, and expansion happens before the turn. So expansion runs as the first stage of the turn stream in `sendMessage`: the approval merge moves out of `runTurn` into a helper both use. A denied or failing command aborts the command with an inline error and sends nothing, as Claude Code does.

**`@path` imports** in `AGENTS.md` and `CLAUDE.md` expand relative to the file that contains them, up to five levels deep, inside the 32 KiB memory cap. An import outside the workspace and the user's config directories, or of a secret-shaped path, is skipped with a note in the prompt.

### Todo

`todo {todos: [{content, status: "pending" | "in_progress" | "completed"}]}` replaces the whole list each call, like `TodoWrite`. The handler validates (at most one `in_progress`) and returns `ok`. There is no todo service: the list is the input of the latest `todo` call in the chat, the TUI derives it from `tool-call` events, `--resume` derives it from saved `steps`, and headless scripts see it in `tool-call` events. The prompt tells the model to use it for tasks of three or more steps.

### Compaction

`src/core/compact.ts` summarizes the chat with the session model, or `ORX_COMPACT_MODEL` when set, using a fixed prompt that asks for sections: the user's goal, decisions made, files read and changed (paths), open todos, and the next step. The user's latest message is kept verbatim after the summary, and loaded skills' bodies are re-attached, since the model was following them.

Storage decides compatibility, and chat files are the one persisted format orx has. The summary is stored as a `UserMessage` with a new optional `compaction: {count, model, usage, auto}` field rather than a new message role. An older orx reading the file then sees an ordinary user message (Effect Schema ignores excess keys by default, and `ChatStore` decodes without overriding that; a test that decodes a new file with the old schema pins it), where a new role would make every older binary fail to decode the chat. `toPrompt` starts from the last message with `compaction`: system prompt, the summary, then everything after it. The TUI and exports show the full history with the compaction line in place.

Automatic compaction runs only at the start of a turn, when the estimated prompt after elision passes `COMPACT_AT` of the window. Mid-turn stays as it is: elision, one harder-elided retry, and if that fails, the turn ends with a note that suggests `/compact`. Summarizing in the middle of a tool loop would mean summarizing the step in progress, which is where compaction loses the most. `COMPACT_AT` starts at 0.8 and gets tuned together with `ELIDE_AT` on the long-context case.

## Sequencing

Each step is one PR and leaves `bun run check` green. New product files go on `scripts/vanilla.ts`'s `REMOVE` list in the PR that adds them; changes to `src/config.ts` are mirrored in `template/vanilla/src/config.ts` where they apply.

| Step | Ships | Depends on | Size |
| --- | --- | --- | --- |
| 2a | `session_id`, request-level `cache_control`, `Usage.cachedTokens` in the usage line and logs; stub records request bodies so tests can assert them | none | S |
| 2b | Permission rules: `core/rules.ts`, config file key, `--allow`/`--deny`, `decide` with rules | none | M |
| 2c | Long-context eval case; tune `ELIDE_AT`, `PROTECTED_STEPS`, and pick `COMPACT_AT`; record results in this file | phase 1's eval run | S |
| 2d | `todo` tool and the TUI list | none | S |
| 2e | Subagent runtime, `nested` in `runTurn`, `tool-progress`, `Subagents` service, `task` tool, built-in `explore`, `ORX_EXPLORE_MODEL`, subagent usage in replies and `done` | 2a | L |
| 2f | Agent files (`.orx/agents`, `~/.config/orx/agents`), `yaml` frontmatter parser for all three loaders, built-in `general`, agent labels on approvals, `/agents` | 2b, 2e | M |
| 2g | `.claude/` and `.agents/skills` compatibility, `` !`cmd` `` expansion, `$1`/`$2`, `@path` imports in memory, protected paths | 2f | M |
| 2h | `/compact`, automatic compaction, the compaction line | 2c | M |

2a, 2b, 2d, and 2c can run in parallel. 2e is the critical path.

## Testing

- **Stub OpenRouter.** It needs to tell the parent's requests from a subagent's, so scripts can be keyed by the request's `model` or by a marker in the system prompt, and it records request bodies so tests can assert `session_id`, `cache_control`, and which tools each request offered. Both are small additions to `tests/helpers/stub-openrouter.ts`.
- **`runCli`** for the contracts: `ask --agent --json` with a scripted `task` call produces `tool-call`, `tool-progress` events, the subagent's `tool-result`, and a `done` whose usage adds the subagent's cost; a subagent's denied `edit` produces `permission-denied` with `agent`; `--allow 'Bash(bun test *)'` allows `bun test x` and still denies `bun test x; rm -rf y`; a bad rule exits 3.
- **Pure units:** the rule parser and matcher (table-driven, including compound splitting and substitutions), agent frontmatter with YAML lists and aliases, directory precedence, `toPrompt` across a compaction boundary, the todo input schema.
- **Turn-level:** a nested turn doesn't consume or cancel the parent's approvals (two parallel subagents, one waiting to ask while the other finishes); interrupting the parent interrupts the subagents and saves their partial transcripts; a subset toolkit is served by the session's handlers.
- **`tests/tui`:** the progress line updating and resolving, a labelled approval, the todo list from `tool-call` events and after `--resume`, the compaction line; closed loop with the real bridge where the parent delegates to `explore`, which reads a file.
- **Evals:** the long-context case from 2c, run with and without delegation and with `explore` on a cheaper model; a compatibility smoke that loads this repo's own `.claude/commands`, `.claude/agents`, and `.agents/skills` with no warnings except the ones expected.

## Success criteria

orx has no telemetry and shouldn't grow any, so these come from evals and local logs.

- On the long-context case, the parent's final prompt is at least 40% smaller with `explore` than without, at the same pass rate.
- With `explore` on a cheaper model, cost per passing run drops, and the pass rate stays within one case of the inherit run. If it doesn't, the README doesn't recommend a cheap explorer.
- On an Anthropic model, at least half the input tokens of a 20-step tool loop are cached, as `cachedTokens` reports.
- `rename-across-files` passes headless in `default` mode with `--allow 'Bash(bun test *)'`, without `yolo`.
- A session on the long-context case survives past the window through compaction with no context-length failure.
- This repo's own `.claude/` and `.agents/` directories load in orx with no unexpected warnings.

## Risks

- **Subagent spend.** Four parallel `general` agents on an expensive model can cost more in a minute than a whole phase 1 session. The semaphore bounds concurrency, live usage shows it, and the README already tells users to set a credit limit on the key. A spend cap is in [follow-ups](follow-ups.md) with its trigger.
- **A cheap explorer that's wrong.** The parent trusts the summary it gets back. Defaulting `explore` to the session model keeps that risk opt-in until the eval puts a number on it.
- **Compatibility that looks complete and isn't.** A `.claude/` command built around `allowed-tools` prompts far more in orx; an agent with `permissionMode: acceptEdits` doesn't get it. The load warnings name what was ignored, and the README gets a short "what orx reads from `.claude/`" table.
- **Instructions from a cloned repo.** `.claude/` content in a repo someone else wrote becomes instructions the model follows, and `` !`cmd` `` proposes commands. Nothing it causes skips the gate, which is the same line phase 1 drew for `.orx/commands`.
- **Chat files grow** with subagent transcripts. They're local and each is bounded by its step cap; if files get unwieldy, transcripts can move to sidecar files without changing what's replayed.
- **The `yaml` dependency** is a new parser on untrusted input. It's widely used and only sees frontmatter; `vanilla` drops it with the agent loaders.

## Open questions

- Should `todo` be on by default? Claude Code and Codex turned theirs off for newer models. Proposal: on, and let the long-context eval compare with it off on one strong and one cheap model.
- Does `explore` benefit from `reasoning: {effort: "low"}`? Cheap to try in the eval.
- Does the `task` tool's description list every agent file (Claude Code's approach), or only names with a `/agents`-style lookup? With many agent files the description gets long and costs tokens on every request. Start with the full list and cap it at a character budget like skills.
- Should a skill with `context: fork` run as a subagent, as Claude Code does? It fits 2e's runtime; it's left out until someone has such a skill.
- Where do "always" answers go once rules exist: still session-only, or offered as "always, and save a rule"? That depends on phase 3's project settings file.

## Sources

- Claude Code: [subagents](https://code.claude.com/docs/en/sub-agents), [skills and commands](https://code.claude.com/docs/en/skills), [tools reference](https://code.claude.com/docs/en/tools-reference), [permissions](https://code.claude.com/docs/en/permissions), [context window](https://code.claude.com/docs/en/context-window), [checkpointing](https://code.claude.com/docs/en/checkpointing)
- opencode: [agents](https://opencode.ai/docs/agents/), [commands](https://opencode.ai/docs/commands/), [skills](https://opencode.ai/docs/skills/), [tools](https://opencode.ai/docs/tools/), [config](https://opencode.ai/docs/config/), [TUI](https://opencode.ai/docs/tui/)
- Codex CLI: [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md), [skills](https://learn.chatgpt.com/docs/build-skills.md), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference.md), [changelog](https://developers.openai.com/codex/changelog)
- aider: [commands](https://aider.chat/docs/usage/commands.html), [options](https://aider.chat/docs/config/options.html)
- A secondary comparison of compaction internals, used only where marked above: [justin3go.com, 2026-04-09](https://justin3go.com/en/posts/2026/04/09-context-compaction-in-codex-claude-code-and-opencode)
- OpenRouter: [prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching), [sticky routing and `session_id`](https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/), [usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting), [reasoning tokens](https://openrouter.ai/docs/use-cases/reasoning-tokens), [models API](https://openrouter.ai/docs/guides/overview/models), [broadcast and `trace`](https://openrouter.ai/docs/guides/features/broadcast)
- In the tree: `ChatRequest`, `SubagentServerToolConfig`, and `AnthropicCacheControlDirective` in `node_modules/@effect/ai-openrouter/src/Generated.ts`; `prepareTools` and `withConfigOverride` in `OpenRouterLanguageModel.ts`; `HandlerContext.preliminary` in `effect/src/unstable/ai/Toolkit.ts`

# Phase 3: it runs unattended

Status: PROPOSED 2026-09-28 | Size: XL (seven PR-sized steps) | Depends on: [phase 2](phase-2-delegates.md) steps 2b (permission rules) and 2f (agent files)

Phase 3 is about leaving orx alone with a task for twenty minutes and coming back to something you can trust or undo. Claims about the code were checked at `a1b39e5`; recheck each before the step that relies on it (`README.md` in this folder).

## Summary

After phase 2, orx can do long work, but only with someone at the keyboard: every command asks unless the user switches to `yolo`, nothing it did can be undone except through git, it can't start a dev server and keep working, it can't read a docs page or reach the user's other tools, and a project can't tell it "always format after an edit". Phase 3 closes those gaps, in this order:

1. **Workspace trust and project settings**, so a repository can carry permission rules, hooks, and MCP servers, and none of them take effect until the user says yes once.
2. **Checkpoints and `/rewind`**, so every edit orx makes can be undone per message, git or no git.
3. **Background commands**, so the agent can run a dev server or a watcher and read its output later.
4. **`web_fetch`**, a local tool with per-domain approval.
5. **An MCP client**, so the user's MCP servers become tools, behind the same gate.
6. **Hooks**, in Claude Code's format, from user config and trusted projects.
7. **An OS sandbox for `bash`**, which is what finally lets commands run without asking.

Changes from the RFC's phase 3 list: allow/deny rules and `` !`cmd` `` expansion moved to phase 2 (reasons there). The persistent shell and per-model edit formats moved to [follow-ups](follow-ups.md): the job behind "persistent shell" is long-running processes, which background commands do better, and there's no data yet that any model needs a different edit format. Workspace trust is new: three of the phase 3 features let a repository run code or grant access, and they need one shared answer to "did the user agree to this".

## Who it's for and the jobs

The same developer as phase 2, now running longer tasks: a refactor across a package, "make the test suite pass", a migration with a dev server running.

| Job | What gets in the way today | Phase 3 feature |
| --- | --- | --- |
| "Let it run commands without approving each one, without handing it my machine" | `default` asks for everything; `yolo` gives full access | Sandbox: commands run without asking, confined to the workspace with no network |
| "Undo what it just did" | `git checkout`, if the repo was clean and it's a git repo at all | `/rewind` to any earlier message: code, conversation, or both |
| "Start the dev server and check the page" | `bash` blocks until the command exits, 10 minutes at most | `bash` with `run_in_background`, then `bash_output` |
| "Read the docs for this library version" | Nothing; `:online` models search but can't read a given URL | `web_fetch` |
| "Use my Linear, database, or browser MCP servers" | orx can't use MCP servers | MCP client |
| "This repo formats on every edit and forbids `git push`" | Only memory files, which the model may ignore | Hooks and project rules |
| "My team's repo should set this up for everyone" | Only user-level config | Project settings, behind trust |

## How the others do it

Researched 2026-09-28; sources at the end.

| | Claude Code | opencode | Codex CLI | aider |
| --- | --- | --- | --- | --- |
| Project config | `.claude/settings.json` and `settings.local.json`; managed > CLI > local > project > user; a deny anywhere wins | Layered JSON config, project included | `config.toml`, `.rules` files | `.aider.conf.yml` |
| Undo | Checkpoint per prompt, last 100, about 30 days; `/rewind` restores code, conversation, or both; bash side effects and most subagent edits untracked | `/undo` and `/redo` via internal git snapshots; needs a git repo | `/undo` removed; use git | Auto-commits every edit; `/undo` reverts the last one |
| Long-running commands | Fresh process per call, cwd persists; `run_in_background`; timed-out commands move to the background | Fresh process per call (from the source, unverified) | PTY-backed `unified_exec` | `/run` only |
| Web | `WebFetch` gated per domain, `WebSearch` | `webfetch`, `websearch` with a provider | `web_search` modes, no generic fetch | `/web <url>` |
| MCP client | stdio, HTTP, SSE; `.mcp.json` and `~/.claude.json`; OAuth; output capped at 25k tokens | local and remote, OAuth | stdio and HTTP, bearer tokens, OAuth | None |
| Hooks | Many events (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, ...), command/http/prompt types, exit 2 blocks | JS/TS plugins | Claude-compatible `hooks.json` | None |
| Sandbox | Seatbelt on macOS, bubblewrap on Linux, network through an allowlisting proxy, sandboxed bash auto-allowed | None documented | Seatbelt, bubblewrap, native Windows; `workspace-write` by default | None |

Codex adopting Claude Code's hook schema is the strongest signal on this page: the hook format is becoming a shared contract, and orx should speak it rather than design its own. For undo, Claude Code's per-message checkpoints without git are the right model for orx, whose users aren't always in a clean git tree, and orx can do better than Claude Code on one point: subagent edits go through the same tools, so they're tracked too.

## Scope

In: the seven items above. Out, with where it went:

- A persistent shell and per-model edit formats (`apply_patch` for codex models): [follow-ups](follow-ups.md), with triggers.
- MCP OAuth and remote servers that need it: [follow-ups](follow-ups.md). stdio and HTTP with static headers first.
- Web search as a tool: OpenRouter's `:online` model variants already search, and `openrouter:web_search` as a server tool is blocked by the provider's rejection of provider-defined tools. The README documents `:online`.
- Hook types other than `command` (http, prompt, agent): follow-ups.
- Rewinding what `bash` changed: not tracked, and the UI says so, as Claude Code's does.
- A Windows sandbox: Windows itself is a [follow-up](follow-ups.md).

## Experience

### Trust

The first time orx starts in a workspace whose `.orx/settings.json`, `.claude/settings.json`, or `.mcp.json` asks for anything (rules, hooks, MCP servers), it shows one panel before the session starts, in the approval panel's style:

```
This project's settings want to:
  allow  Bash(bun run *), Edit(src/**)
  run    2 hooks: PostToolUse → bunx biome format, PreToolUse → .claude/hooks/guard.ts
  start  1 MCP server: postgres (npx @modelcontextprotocol/server-postgres)
y trust · n ignore project settings
```

The answer is remembered per workspace and per content hash of those files, so an edit to a hook re-asks. Until trusted, project settings are ignored and the footer says `project settings ignored` in `muted`. Headless `ask --agent` ignores untrusted project settings and says so on stderr; `--trust-project` accepts them for that run.

### Rewind

Esc twice with an empty composer, or `/rewind`, opens the shared picker over the chat's user messages, newest first, each with how many files orx changed after it. Picking one offers `c` code and conversation, `k` code only, `v` conversation only. Conversation rewind drops the messages from that one on and puts its text back in the composer. Code rewind restores each file orx changed since, and lists what it can't restore: a file that changed on disk since orx last wrote it is skipped with a warning rather than overwritten, and commands' side effects were never recorded.

### Background commands

A background command's tool line shows `→ bash bun run dev · running in background (job 1)`. While any run, the footer shows `1 job` in `muted`, and `/jobs` lists them with their last output line; picking one kills it. They're killed when the session ends.

### web_fetch

Approval shows the full URL, not only the domain, because a URL is how data leaves the machine: `Fetch  https://docs.example.com/v4/migrating?from=3`. "Always" allows that domain for the session. The result line: `→ web_fetch docs.example.com · 14k chars`.

### Sandbox

With the sandbox on (`sandbox: true` in config, or `--sandbox`), `bash` in `default` and `acceptEdits` runs without asking, confined: writes only inside the workspace and the temp directory, no network except allowlisted domains. The footer shows `sandboxed`. A command that fails because of the sandbox gets a result saying so, and the model can retry with `unsandboxed: true`, which asks. `orx doctor` reports whether the sandbox works on this machine (bubblewrap installed on Linux, `sandbox-exec` present on macOS).

## Architecture

### Workspace trust and project settings (3a)

A `ProjectSettings` program in `src/core/project.ts` reads `.orx/settings.json`, the `permissions` and `hooks` keys of `.claude/settings.json`, and `.mcp.json`, decodes each with its own schema in `src/schemas/project.ts` (open, since Claude's settings file carries many keys orx ignores), and hashes their contents. A `Trust` store keeps `{realpath, hash, decision}` entries in `$XDG_CONFIG_HOME/orx/trust.json`, written through a temp file and rename like `ChatStore`. `prepareSession` loads project settings and, when they ask for something and no matching entry exists, returns them untrusted; the TUI shows the trust panel before the first message, through a new `ChatBridge.trust` call. Trusted settings merge with the user's: rules concatenate (a deny anywhere wins, as in Claude Code), hooks and MCP servers append.

This is also where "always, and save a rule" can land: an "always" answer for a command writes a `Bash(<exact command>)` allow rule to `.orx/settings.local.json`, which is personal and shouldn't be committed; orx adds it to the workspace's `.gitignore` the first time it writes one, or says to when there's no `.gitignore`. Whether to offer that is phase 2's open question.

`isProtectedPath` gains `.orx/settings*.json`, `.claude/settings*.json`, and `.mcp.json`. An edit to them also invalidates trust through the hash, but asking first is cheaper than re-trusting.

### Checkpoints and /rewind (3b)

A per-session `Checkpoints` service in `src/services/checkpoints.ts`. `write` and `edit` already hold `FileState.withLock(path)` from the freshness check to recording the new state; inside that, just before writing, they call `checkpoints.record(path, before)` with the file's prior bytes (or "didn't exist"). Records are grouped by the index of the user message that started the turn and stored under `$ORX_DATA_DIR/checkpoints/<chatId>/`: content-addressed blobs and one JSON manifest per message. Subagent edits go through the same tools and the same service, so they're recorded under the parent's message.

`rewind(chatId, messageIndex, {code, conversation})` in `src/core/rewind.ts`:

- Code: for every file recorded at or after that message, the earliest prior content wins. Before restoring, compare the file on disk with the last content orx wrote (the manifest keeps its hash); if they differ, something else changed it, so skip it and report. Files orx created are deleted.
- Conversation: `ChatStore.save` with the messages before that index. Subagent transcripts go with their replies.

Retention: the last 100 message checkpoints per chat and nothing older than 30 days, pruned when a session starts. `orx chats` gains nothing; there's no CLI rewind in phase 3, since headless users have git and a scripted rewind needs a design of its own.

### Background commands (3c)

A per-session `Jobs` service in `src/services/jobs.ts`. `bash` gains `run_in_background`; with it, `runBash` spawns the same `ChildProcess` (same env, cwd, permission check) in a fiber forked into the session's scope, and returns `job <n> started` at once. Output goes into the existing head-and-tail buffer (`makeOutputBuffer`), per job, with a cursor. Two new tools: `bash_output {job}` returns what arrived since the last read, and whether it's still running and its exit code; `kill_job {job}` interrupts the fiber, which kills the process group the way an interrupted `bash` does now. Because the fibers live in the session scope, ending the session kills every job: Effect's structured concurrency does the cleanup that other agents implement by hand.

The idle watchdog is unaffected: a background job isn't a running tool call. `explore` never gets these tools; `general` does.

### web_fetch (3d)

A local tool, not OpenRouter's `openrouter:web_fetch` server tool, because `@effect/ai-openrouter` rejects provider-defined tools at `4.0.0-rc.117`. `src/tools/web-fetch.ts` uses Effect's `HttpClient` (platform-free) with a timeout, a 5 MB response cap, and redirects followed only within the approved domain. HTML becomes Markdown-ish text through a small, well-used converter; the choice is an open question. The result is capped at `WEB_FETCH_MAX_CHARS` (a new constant in `tools/limits.ts`) and wrapped in `<fetched url="...">` so the model can tell page content from instructions.

With a `prompt` argument, the page goes to a cheap model (`ORX_FETCH_MODEL`, else the session model) with that question, and only its answer returns, which keeps a 100k-character docs page out of the parent's context. That's Claude Code's WebFetch design and an easy fit for OpenRouter. Its cost is added to the reply like a subagent's, through phase 2's `Subagents` records.

Permissions: a new `web_fetch` request kind with a `domain` field; rules take `WebFetch(domain:docs.example.com)`; the default in every mode but `yolo` is ask, and a sandboxed session doesn't change that, since the fetch runs in orx's own process.

### MCP client (3e)

Servers come from `mcpServers` in the user's config file and from a trusted project's `.mcp.json`, in Claude Code's shape: `{command, args, env}` for stdio, `{type: "http", url, headers}` for streamable HTTP, with `${VAR}` expanded from the environment through `src/config.ts`. An `McpClients` service connects to each at session start, lists tools, and exposes them through `Tool.dynamic` (Effect AI builds a tool from a raw JSON Schema, which is what MCP gives). Names are `mcp__<server>__<tool>`, as in Claude Code, so rules and agent files copy across. Each call goes through `Permissions` as kind `mcp`: ask by default, `mcp__server__tool` rules to allow. Output is capped like `bash`'s. A server that fails to start is a load warning and its tools are absent; it doesn't stop the session.

Transport: Effect ships `McpSchema` (including the `ClientRpcs` a client sends) and the RPC machinery `McpServer` uses, but no packaged client. Building the client on `McpSchema` plus Effect's RPC client keeps one stack and one schema library; `@modelcontextprotocol/sdk` is the fallback if HTTP transport or session handling turns out to be large. Spike it first. The test fixture is a small stdio MCP server in `tests/helpers/`, built on Effect's `McpServer`.

### Hooks (3f)

Claude Code's schema, `command` type only: `hooks.<Event>[] = {matcher, hooks: [{type: "command", command, timeout}]}` in the user config and trusted project settings. Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SubagentStop`. The hook gets Claude Code's JSON payload on stdin (`tool_name` with Claude's names, since matchers written for Claude Code say `Edit|Write`, mapped from orx's), exit 2 blocks (for `PreToolUse`, the stderr becomes the denial the model reads), and JSON output supports `permissionDecision` and `additionalContext`.

`src/core/hooks.ts` runs them through `ChildProcess` with `agentShellEnv()` and a timeout. `PreToolUse` runs inside `permit` after the rule check, so a hook can deny but can't allow past a deny rule (Claude Code's rule too). `PostToolUse` runs after the handler, and its `additionalContext` is appended to the tool result. Hooks run without asking; that's what trust is for. A hook's failure (non-zero other than 2, or a timeout) is a warning in the log and a `note`, never a failed turn.

### OS sandbox for bash (3g)

`runBash` wraps the command when the sandbox is on. The first candidate is `@anthropic-ai/sandbox-runtime`, the library Claude Code uses: it wraps a command with `sandbox-exec` and a generated Seatbelt profile on macOS, or bubblewrap on Linux, and runs a proxy that enforces a domain allowlist. Before adopting it: confirm the license, that it bundles into `bun build --compile`, and that it works with Effect's `ChildProcess` rather than its own spawner. The fallback is orx's own Seatbelt profile and bubblewrap arguments with network all-or-nothing, which is less but still the core of the value.

The sandbox also changes the environment: in sandbox mode `agentShellEnv` drops variables that look like credentials (`*_TOKEN`, `*_SECRET`, `*_KEY`, `AWS_*`), since phase 1's scrub removes only orx's own.

`decide` gains a `sandboxed` input: sandboxed `bash` is allowed in `default` and `acceptEdits` unless a rule says otherwise, and `unsandboxed: true` asks in every mode but `yolo`. The sandbox is off by default in phase 3; turning it on by default waits until it has run on both platforms in CI and on the rr hosts for a while.

## Sequencing

Each step is one PR and leaves `bun run check` green.

| Step | Ships | Depends on | Size |
| --- | --- | --- | --- |
| 3a | Project settings, trust store and panel, merged rules, protected settings paths, `--trust-project` | 2b | M |
| 3b | `Checkpoints` service, recording in `write`/`edit`, `/rewind` and Esc Esc, retention | none | M |
| 3c | `Jobs` service, `run_in_background`, `bash_output`, `kill_job`, `/jobs`, footer count | none | M |
| 3d | `web_fetch` with domain rules and the optional `prompt` model call | 2e (usage records) | M |
| 3e | MCP client spike, then `McpClients`, `Tool.dynamic` tools, `mcp__` rules, `.mcp.json` via trust | 3a | L |
| 3f | Hooks from user config and trusted projects, Claude-compatible payloads | 3a | M |
| 3g | Sandbox wrapper, credential scrub, `sandboxed` in `decide`, `doctor` check, CI on both platforms | 2b | L |

3b and 3c can start as soon as phase 2's runtime work is out of the way; neither touches permissions.

## Testing

- **Checkpoints:** bun test against a temp workspace: a turn with three edits and a created file rewinds to byte-identical files; an externally modified file is skipped and reported; a subagent's edit is rewound with the parent's message; retention prunes. `tests/tui` for the picker and the three choices.
- **Jobs:** a stub-scripted turn starts `sleep 30 && echo done` in the background, reads output, kills it; ending the session kills a job (process gone); `bash_output` on an unknown job is a tool failure.
- **web_fetch:** a local HTTP stub (like `stub-releases.ts`) serving HTML, a redirect to another domain (refused), a 10 MB body (capped); the domain rule allowing one host; `prompt` mode against the stub OpenRouter, cost added to the reply.
- **MCP:** orx as client to the stub stdio server, listing and calling its tool; a server that fails to start; an `mcp__` rule.
- **Hooks:** a `PreToolUse` script exiting 2 blocks an edit and the model sees stderr; `PostToolUse` context appended; an untrusted project's hooks don't run.
- **Trust:** untrusted project settings ignored in the session and headless; trusting stores the hash; editing a hook re-asks.
- **Sandbox:** in e2e, since it needs the real binary and OS: a sandboxed `bash` can write inside the workspace and not outside it, and can't reach the network; `doctor` reports availability. The CI job runs on macOS and Linux (bubblewrap installed in the Linux job); `rr` covers the two Macs.
- **Evals:** an unattended case: `rename-across-files` in `acceptEdits` with the sandbox on, scored as before plus "zero approvals needed", which `ask --agent` can report by counting `permission-denied` events.

## Success criteria

- A 10-edit turn rewinds to byte-identical files, in a git repo and outside one.
- With the sandbox on, `rename-across-files` passes in `acceptEdits` headless with no denied calls and no `yolo`.
- orx as an MCP client drives the stub server in a test, and a real stdio server (a filesystem or database server) works by hand with a config copied from Claude Code's `.mcp.json`.
- A Claude Code `PostToolUse` formatter hook, copied unchanged from a `.claude/settings.json`, runs in orx.
- The trust panel shows once per workspace and again only when the settings change.

## Risks

- **Sandbox as false confidence.** A sandbox with a gap is worse than none, because users stop reading commands. It ships off by default, with the escape hatch always asking and `doctor` saying exactly what's enforced.
- **Trusted doesn't mean safe.** A user who trusts a cloned repo's hooks has run its code. The panel lists commands, not only counts, and trust is per content hash.
- **MCP servers are code.** Starting a stdio server is running a program; that's why project `.mcp.json` sits behind trust and user config doesn't.
- **Exfiltration through fetch.** The model can read a secret and put it in a URL. Asking per domain with the full URL shown, secret reads asking in every mode but `yolo`, and the sandbox's network block for `bash` are the layers; none is complete alone.
- **Checkpoint storage** grows with large files. Content addressing dedupes, retention bounds it, and files over `READ_MAX_FILE_BYTES` aren't editable by orx anyway.
- **Hook compatibility drift.** Claude Code adds events and fields often. orx implements a named subset and warns on hooks for events it doesn't have.

## Open questions

- Which HTML-to-text converter for `web_fetch`, weighed on size in the binary, since everything ships in one file.
- Does `@anthropic-ai/sandbox-runtime` survive `bun build --compile`, and is its proxy something orx wants to run?
- Should `/rewind` also be offered headless (`orx rewind <chat> --to <n>`)? Only if someone scripting `ask --agent` asks for it.
- Should trust be keyed by the git remote as well as the path, so a fresh clone of a trusted repo doesn't ask again? Simpler per path for now.

## Sources

- Claude Code: [checkpointing](https://code.claude.com/docs/en/checkpointing), [tools reference](https://code.claude.com/docs/en/tools-reference), [permissions](https://code.claude.com/docs/en/permissions), [hooks](https://code.claude.com/docs/en/hooks), [MCP](https://code.claude.com/docs/en/mcp), [sandboxing](https://code.claude.com/docs/en/sandboxing)
- opencode: [TUI (undo, redo)](https://opencode.ai/docs/tui/), [permissions](https://opencode.ai/docs/permissions/), [MCP servers](https://opencode.ai/docs/mcp-servers/), [plugins](https://opencode.ai/docs/plugins/), [tools](https://opencode.ai/docs/tools/)
- Codex CLI: [sandboxing](https://learn.chatgpt.com/docs/sandboxing), [rules](https://learn.chatgpt.com/docs/agent-configuration/rules.md), [hooks](https://developers.openai.com/codex/hooks), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference.md), [undo removal discussion](https://github.com/openai/codex/discussions/9618)
- aider: [git integration and /undo](https://aider.chat/docs/git.html), [commands](https://aider.chat/docs/usage/commands.html)
- Gemini CLI: [checkpointing](https://geminicli.com/docs/cli/checkpointing/)
- In the tree: `prepareTools` in `node_modules/@effect/ai-openrouter/src/OpenRouterLanguageModel.ts` (provider-defined tools rejected); `ClientRpcs` in `effect/src/unstable/ai/McpSchema.ts`; `Tool.dynamic` in `effect/src/unstable/ai/Tool.ts`

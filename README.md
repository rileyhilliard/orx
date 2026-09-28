# orx

A terminal client for any OpenRouter model: `orx ask` streams a reply into your terminal or a pipe, bare `orx` is a coding agent session (file and shell tools, slash commands, skills) with a model picker and per-reply tokens and cost, `orx extract` pulls structured data out of text, and `orx mcp` offers `currentTime` and `extractContact` to other agents over MCP (the file and shell tools stay in the session, behind its approvals). One self-contained binary that updates itself.

Built with [Effect](https://effect.website) (CLI, AI, and MCP modules), [OpenTUI](https://github.com/sst/opentui) for the terminal UI, and [Bun](https://bun.sh), which compiles it to a single file.

## Install

```bash
curl -fsSL https://github.com/rileyhilliard/orx/releases/latest/download/install.sh | bash
export OPENROUTER_API_KEY=sk-or-...
orx ask "hello"
```

The installer picks the binary for your OS and CPU (macOS and Linux with glibc, x64 and arm64), checks it against the release's `SHA256SUMS`, and puts it in `~/.local/bin` (`ORX_INSTALL_DIR` to change). `orx update` replaces it with the latest release the same way; `orx update --check` only reports.

## Quickstart

```bash
orx ask "what's a monad, in one sentence"
git diff | orx ask "review this diff"        # piped stdin is appended to the prompt
orx ask --json "time in Tokyo?" | jq -c .   # NDJSON: text, tool-call, tool-result, permission-denied, note, then done | error
orx                                          # the coding agent, working in this directory
orx --resume <id>                            # ids from `orx chats`
orx ask --agent --permission-mode acceptEdits "rename fmtPrice to formatPrice"
orx models gpt                               # search models, prices per million tokens
orx extract "Ada Lovelace, ada@example.com, Analytical Engines Ltd"
orx export <id> -o chat.md
claude mcp add orx -- orx mcp                # currentTime and extractContact as MCP tools
orx doctor                                   # version, paths, key set or not, config errors (--tui checks the TUI)
```

Every reply is saved as a chat (the id is printed after the reply, on stderr). Results go to stdout and everything else (usage lines, logs, errors) to stderr, so pipes only see the answer. When stdin isn't a terminal, `ask` and `extract` read it to the end, so in a `while read` loop or under a job runner whose stdin stays open, give them `< /dev/null`.

## The coding agent

Bare `orx` starts a session in the current directory (`--cwd <dir>` picks another, and is required to work in your home directory or `/`). The model gets `read`, `glob`, `grep`, `write`, `edit`, and `bash`, plus `skill`, and only models with tool calling are offered. File tools resolve every path inside the workspace, symlinks included, and refuse anything outside it. `bash` runs in the workspace with the API key scrubbed from its environment, but it is not sandboxed: an approved command can touch anything your user can.

What runs without asking depends on the permission mode. Shift+Tab or `/mode` switches between the first three during a session.

| Mode | Reads | Writes and edits | bash |
|---|---|---|---|
| `default` | allowed | ask | ask |
| `acceptEdits` | allowed | allowed, except protected paths | ask |
| `plan` | allowed | denied | denied |
| `yolo` | allowed | allowed | allowed |

Two kinds of path always ask, in every mode but `yolo`. Secret-shaped files (`.env*`, `*.pem`, `*.key`, `id_*`) ask before they're read or written; `@` doesn't attach them, and `grep` never searches them (it says how many it skipped). Protected paths ask before a write even in `acceptEdits`, because a later approved command would run or load them: anything under `.git/`, `.orx/commands/`, or `.orx/skills/`, and any `package.json`, `lefthook.yml`, `AGENTS.md`, or `CLAUDE.md`, compared without regard to case (`.GIT/config` is `.git/config` on macOS).

An approval shows the command or the diff; `y` allows it, `a` allows it for the rest of the session (the same command again, or every edit by switching to `acceptEdits`), and `n` denies it with an optional note for the model. "Always" isn't offered for compound commands (`;`, `&&`, pipes, redirects, substitution) or for secret and protected paths. `--dangerously-skip-permissions` starts in `yolo`: nothing asks, file tools still stay in the workspace, and `bash` doesn't.

`orx ask --agent` runs the same tools with no one to ask, so whatever would ask is denied and the model sees why. `--permission-mode` (default `default`, which denies every write, edit, and command) says what may run; `--cwd` and `--permission-mode` need `--agent`. With `--json`, a denied call emits `{"type":"permission-denied","id","tool","message"}` right before that call's `tool-result`.

**Memory.** The system prompt includes `~/.config/orx/AGENTS.md`, then the `AGENTS.md` (or `CLAUDE.md` where there's none) of each directory from the git root down to the workspace, capped at 32 KiB.

**Slash commands.** `/` lists the built-ins (`/help`, `/clear`, `/model`, `/mode`, `/export`, `/quit`), custom commands, and skills. A custom command is a Markdown file in `.orx/commands/` (or `~/.config/orx/commands/`); `/name args` sends its body with `$ARGUMENTS` replaced (or the arguments appended), and a `model:` line in its frontmatter runs that turn on another model. A skill is a directory in `.orx/skills/` (or `~/.config/orx/skills/`) with a `SKILL.md` whose frontmatter has `name` and `description`: the description goes in the system prompt, and the model loads the body with the `skill` tool when it needs it (`/name args` sends it as your message). The workspace's commands and skills win a name clash with yours.

**@ mentions.** `@` opens a fuzzy file picker. Each `@path` in a message attaches that file (numbered lines, the first 2000) or that directory's listing for the model; the chat, `--resume`, and exports show only what you typed. When a long chat nears the model's context window, old tool outputs and older messages' attachments are replaced by a one-line stub.

`/help` lists every key. Chats remember their workspace: `--resume` from a different directory exits 2 and names it, and an explicit `--cwd` chooses where to continue.

## Configuration

Environment variables win over the optional config file, `~/.config/orx/config.json` (`$XDG_CONFIG_HOME/orx/config.json`), which takes `model`, `systemPrompt`, `fallbackModels`, `providerSort`, `allowFallbacks`, `dataCollection`, `zdr`, `maxOutputTokens`, `maxToolSteps`, and `maxStreamSeconds`. An unknown key is an error, and the API key can't go in the file.

| Variable | What it does |
|---|---|
| `OPENROUTER_API_KEY` | Required for anything that calls a model (exit 3 without it). Set a credit limit on the key at openrouter.ai. |
| `OPENROUTER_MODEL` | Default model (`openai/gpt-6-luna`); `--model` overrides it per run (variants like `:online` work). |
| `OPENROUTER_BASE_URL` | OpenRouter's API base (default `https://openrouter.ai/api/v1`); the dev stub sets it. |
| `SYSTEM_PROMPT` | Replaces the default system prompt. |
| `OPENROUTER_FALLBACK_MODELS` | Comma-separated model ids OpenRouter tries if the main one fails. |
| `OPENROUTER_PROVIDER_SORT` | `price`, `throughput`, or `latency`; empty lets OpenRouter choose. |
| `OPENROUTER_ALLOW_FALLBACKS` | Whether OpenRouter may use other providers for the same model (default `true`). |
| `OPENROUTER_DATA_COLLECTION` / `OPENROUTER_ZDR` | `deny` / `true` restrict routing to providers that don't store prompts / keep zero data. |
| `MAX_OUTPUT_TOKENS`, `MAX_TOOL_STEPS`, `MAX_STREAM_SECONDS` | Reply length (8192 for every command), model steps per turn (50; hitting it ends the turn with a note), and seconds a reply may go without a chunk from the model (120; time running tools doesn't count). OpenRouter checks your credit against the input plus `max_tokens` before the call, so lower `MAX_OUTPUT_TOKENS` if you get a 402 "can only afford" error. |
| `LOG_LEVEL`, `ORX_LOG_FORMAT`, `ORX_LOG_FILE` | Log level (`warn` by default; `--log-level` per run), `pretty` or `json` on stderr, and a file to also append JSON lines to. `NO_COLOR=1` turns off color and `FORCE_COLOR=1` forces it. |
| `ORX_DATA_DIR` | Where chats are saved (default `$XDG_DATA_HOME/orx`, else `~/.local/share/orx`). |
| `ORX_RELEASES_REPO`, `ORX_RELEASES_URL` | Where `orx update` looks for releases (default `rileyhilliard/orx` on `https://api.github.com`). |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including `--help` |
| 1 | A bug in orx (the log has details) |
| 2 | Bad usage or input: unknown flag, empty prompt, unknown model, unknown chat id, bare `orx` without a terminal, `--resume` from another workspace |
| 3 | Not configured: no API key, a bad env var or config file value (the message names it), or the terminal UI can't load here |
| 4 | OpenRouter or GitHub failed or timed out; `retryable` in the `--json` error says whether trying again can help |
| 5 | The model's structured output didn't match the schema |
| 6 | Permission denied writing a file (`orx update` into a directory you don't own) |
| 130 | Interrupted (Ctrl+C) |

With `--json`, errors are `{"error":{"tag","message","retryable"}}` on stderr.

## Logs

Each run logs one `command` line (command, flag names, exit code, duration) and each model turn one `llm call` line (model, tokens, cost, finish reason) at `info`, which the default level (`warn`) hides. `orx --log-level info ask hi` shows them for one run; `ORX_LOG_FILE=~/orx.jsonl` keeps them. Prompts, replies, and the key are never logged.

## Working in this repo

Requires bun 1.4 and Node 24.

```bash
cp .env.example .env              # optional: a real key for bun run orx
bun install                       # also installs the git hooks
eval "$(bun run --silent stub)"   # a local stub OpenRouter: no key, no cost
bun run orx -- ask "hi"           # orx from source; logs in logs/orx.jsonl
bun run tui:capture -- --keys "hi<enter>" --wait-for "in /"   # the TUI's screen as text
bun run check                     # the gate (CI adds coverage and build:all)
```

| Command | What it does |
|---|---|
| `bun run orx -- <args>` | orx from source, logging at `info` to the terminal, `logs/orx.jsonl`, and `logs/orx.log`; chats in `.orx/data` |
| `bun run stub` / `stub:stop` | Stub OpenRouter and GitHub releases on local ports; prints the env to point orx at them |
| `bun run tui:capture -- --keys ... [-- <orx flags>]` | Runs orx in a pseudo-terminal, types keys, prints the screen |
| `bun run lint` / `format` / `typecheck` | Biome check / Biome fixes / tsc |
| `bun run test` | vitest (Node) and the TUI tests (bun), no network |
| `bun run e2e` | Builds `dist/orx` and tests the binary, including the TUI in a PTY |
| `bun run check` | lint, typecheck, test, e2e (CI also runs `coverage` and `build:all`) |
| `bun run coverage` | vitest with a coverage report in `coverage/` |
| `bun run record:openrouter` | Re-records `tests/fixtures/openrouter/` from real OpenRouter streams (needs a key) |
| `bun run clean` | Removes `dist/`, `coverage/`, and `logs/` (dev chats in `.orx/` stay) |
| `bun run build` / `build:all` | `dist/orx` for this machine / every release target plus `SHA256SUMS` |
| `bun run eval --models a,b` | Model behavior against the real API (needs a key, costs a fraction of a cent) |
| `bun run vanilla -- --name <name>` | Starts a different CLI from this one: on a new branch, removes the orx product (keeping one example model command and a placeholder TUI), renames orx to `<name>` when given one, runs the gate, and commits |

Use `bun run test`, not `bun test`: most tests run on vitest. `AGENTS.md` is the map of the code and conventions, for agents and people. `docs/harness.md` explains the agent harness (hooks, rules, commands, reviewers) and which layer catches which mistake. To release, bump `version` in `package.json`, commit, and push a matching `v*` tag.

## License

Copyright (c) 2026 Riley Hilliard

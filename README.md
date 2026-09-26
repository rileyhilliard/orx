# orx

A terminal client for any OpenRouter model: `orx ask` streams a reply into your terminal or a pipe, `orx chat` is a full-screen chat with a model picker and per-reply tokens and cost, `orx extract` pulls structured data out of text, and `orx mcp` offers the same tools to agents over MCP. One self-contained binary that updates itself.

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
git diff | orx ask "review this diff"        # stdin is appended to the prompt
orx ask --json "time in Tokyo?" | jq -c .   # NDJSON: text, tool-call, tool-result, done | error
orx chat                                     # Ctrl+P model, Ctrl+E export, Esc stop, Ctrl+C quit
orx chat --resume <id>                       # ids from `orx chats`
orx models gpt                               # search models, prices per million tokens
orx extract "Ada Lovelace, ada@example.com, Analytical Engines Ltd"
orx export <id> -o chat.md
claude mcp add orx -- orx mcp                # currentTime and extractContact as MCP tools
```

Every reply is saved as a chat (the id is printed after the reply, on stderr). Results go to stdout and everything else (usage lines, logs, errors) to stderr, so pipes only see the answer.

## Configuration

Environment variables win over the optional config file, `~/.config/orx/config.json` (`$XDG_CONFIG_HOME/orx/config.json`), which takes `model`, `systemPrompt`, `fallbackModels`, `providerSort`, `allowFallbacks`, `dataCollection`, `zdr`, `maxOutputTokens`, `maxToolSteps`, and `maxStreamSeconds`. An unknown key is an error, and the API key can't go in the file.

| Variable | What it does |
|---|---|
| `OPENROUTER_API_KEY` | Required for anything that calls a model (exit 3 without it). Set a credit limit on the key at openrouter.ai. |
| `OPENROUTER_MODEL` | Default model (`openai/gpt-6-luna`); `--model` overrides it per run. |
| `SYSTEM_PROMPT` | Replaces the default system prompt. |
| `OPENROUTER_FALLBACK_MODELS` | Comma-separated model ids OpenRouter tries if the main one fails. |
| `OPENROUTER_PROVIDER_SORT` | `price`, `throughput`, or `latency`; empty lets OpenRouter choose. |
| `OPENROUTER_ALLOW_FALLBACKS` | Whether OpenRouter may use other providers for the same model (default `true`). |
| `OPENROUTER_DATA_COLLECTION` / `OPENROUTER_ZDR` | `deny` / `true` restrict routing to providers that don't store prompts / keep zero data. |
| `MAX_OUTPUT_TOKENS`, `MAX_TOOL_STEPS`, `MAX_STREAM_SECONDS` | Reply length (1024), tool-call steps per turn (5), and wall-clock limit per reply (120). |
| `LOG_LEVEL`, `ORX_LOG_FORMAT`, `ORX_LOG_FILE` | Log level (`warn` by default; `--log-level` per run), `pretty` or `json` on stderr, and a file to also append JSON lines to. `NO_COLOR=1` turns off color. |
| `ORX_DATA_DIR` | Where chats are saved (default `~/.local/share/orx`). |
| `ORX_RELEASES_REPO`, `ORX_RELEASES_URL` | Where `orx update` looks for releases (default `rileyhilliard/orx` on `https://api.github.com`). |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including `--help` |
| 1 | A bug in orx (the log has details) |
| 2 | Bad usage or input: unknown flag, empty prompt, unknown model, unknown chat id, `chat` without a terminal |
| 3 | Not configured: no API key, or a bad env var or config file value (the message names it) |
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
bun run tui:capture -- chat --keys "hi<enter>" --wait-for "in /"   # the TUI's screen as text
bun run check                     # what CI runs
```

| Command | What it does |
|---|---|
| `bun run orx -- <args>` | orx from source, logging at `info` to the terminal, `logs/orx.jsonl`, and `logs/orx.log`; chats in `.orx/data` |
| `bun run stub` / `stub:stop` | Stub OpenRouter and GitHub releases on local ports; prints the env to point orx at them |
| `bun run tui:capture -- <args> --keys ...` | Runs orx in a pseudo-terminal, types keys, prints the screen |
| `bun run lint` / `format` / `typecheck` | Biome check / Biome fixes / tsc |
| `bun run test` | vitest (Node) and the TUI tests (bun), no network |
| `bun run e2e` | Builds `dist/orx` and tests the binary, including the TUI in a PTY |
| `bun run check` | lint, typecheck, test, e2e |
| `bun run build` / `build:all` | `dist/orx` for this machine / every release target plus `SHA256SUMS` |
| `bun run eval --models a,b` | Model behavior against the real API (needs a key, costs a fraction of a cent) |

Use `bun run test`, not `bun test`: most tests run on vitest. `AGENTS.md` is the map of the code and conventions, for agents and people. `docs/harness.md` explains the agent harness (hooks, rules, commands, reviewers) and which layer catches which mistake. To release, bump `version` in `package.json`, commit, and push a matching `v*` tag.

## License

Copyright (c) 2026 Riley Hilliard

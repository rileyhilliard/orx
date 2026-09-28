# orx

A starting point for a terminal tool that calls OpenRouter models. It has the plumbing a real CLI needs (one self-contained binary that updates itself, config, logging, exit codes, a terminal UI, tests, and an agent harness) and one small example of each moving part: `orx ask` sends a prompt to a model and prints the reply, and `orx ui` is a placeholder terminal UI over the same call. Replace the examples with your own commands; keep the plumbing.

Built with [Effect](https://effect.website) (CLI and AI modules), [OpenTUI](https://github.com/sst/opentui) for the terminal UI, and [Bun](https://bun.sh), which compiles it to a single file.

## Install

```bash
curl -fsSL https://github.com/rileyhilliard/orx/releases/latest/download/install.sh | bash
export OPENROUTER_API_KEY=sk-or-...
orx ask "hello"
```

The installer picks the binary for your OS and CPU (macOS and Linux with glibc, x64 and arm64), checks it against the release's `SHA256SUMS`, and puts it in `~/.local/bin` (`ORX_INSTALL_DIR` to change). `orx update` replaces it with the latest release the same way; `orx update --check` only reports.

## Commands

```bash
orx ask "what's a monad, in one sentence"
git diff | orx ask "review this diff"        # piped stdin is appended to the prompt
orx ask --json "hi" | jq .                  # one object: {text, model, usage: {inputTokens, outputTokens, cost}}
orx ask -m <model-id> "hi"                  # another model for this run
orx ui                                       # the placeholder TUI: Enter sends, Ctrl+C quits
orx update                                   # replace this binary with the latest release
orx doctor                                   # version, paths, and config, for bug reports
```

`orx ask` isn't streamed: it waits for the whole reply, prints it on stdout, and prints a usage line (model, tokens, cost) on stderr. It retries rate limits, 5xx responses, and timeouts twice and gives up after 60 seconds per attempt. Results go to stdout and everything else (usage lines, logs, errors) to stderr, so pipes only see the answer. When stdin isn't a terminal, `ask` reads it to the end, so in a `while read` loop or under a job runner whose stdin stays open, give it `< /dev/null`.

## Configuration

Environment variables win over the optional config file, `~/.config/orx/config.json` (`$XDG_CONFIG_HOME/orx/config.json`), which takes `model` and `maxOutputTokens`. An unknown key is an error, and the API key can't go in the file.

| Variable | What it does |
|---|---|
| `OPENROUTER_API_KEY` | Required for anything that calls a model (exit 3 without it). Set a credit limit on the key at openrouter.ai. |
| `OPENROUTER_MODEL` | Default model (`openai/gpt-6-luna`); `--model` overrides it per run (variants like `:online` work). |
| `OPENROUTER_BASE_URL` | OpenRouter's API base (default `https://openrouter.ai/api/v1`); the dev stub sets it. |
| `MAX_OUTPUT_TOKENS` | Reply length cap (1024). |
| `LOG_LEVEL`, `ORX_LOG_FORMAT`, `ORX_LOG_FILE` | Log level (`warn` by default; `--log-level` per run), `pretty` or `json` on stderr, and a file to also append JSON lines to. `NO_COLOR=1` turns off color and `FORCE_COLOR=1` forces it. |
| `ORX_DATA_DIR` | Where orx keeps its data (default `$XDG_DATA_HOME/orx`, else `~/.local/share/orx`). Nothing writes there yet; `orx doctor` reports it. |
| `ORX_RELEASES_REPO`, `ORX_RELEASES_URL` | Where `orx update` looks for releases (default `rileyhilliard/orx` on `https://api.github.com`). |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including `--help` and quitting `orx ui` with Ctrl+C |
| 1 | A bug in orx (the log has details) |
| 2 | Bad usage or input: unknown flag, empty prompt, `ui` without a terminal |
| 3 | Not configured: no API key, a bad env var or config file value (the message names it), or the terminal UI can't load here |
| 4 | OpenRouter or GitHub failed or timed out; `retryable` in the `--json` error says whether trying again can help |
| 6 | Permission denied writing a file (`orx update` into a directory you don't own) |
| 130 | Interrupted (Ctrl+C outside the TUI) |

Code 5 is unused. With `--json`, errors are `{"error":{"tag","message","retryable"}}` on stderr.

## Logs

Each run logs one `command` line (command, flag names, exit code, duration) and each model call one `llm call` line (model, tokens, cost, finish reason) at `info`, which the default level (`warn`) hides. `orx --log-level info ask hi` shows them for one run; `ORX_LOG_FILE=~/orx.jsonl` keeps them. Prompts, replies, and the key are never logged.

## Working in this repo

Requires bun 1.4.

```bash
cp .env.example .env              # optional: a real key for bun run orx
bun install                       # also installs the git hooks
eval "$(bun run --silent stub)"   # a local stub OpenRouter: no key, no cost
bun run orx -- ask "hi"           # orx from source; logs in logs/orx.jsonl
bun run tui:capture -- ui --keys "hi<enter>" --wait-for "in /"   # the TUI's screen as text
bun run check                     # the gate (CI adds coverage and build:all)
```

| Command | What it does |
|---|---|
| `bun run orx -- <args>` | orx from source, logging at `info` to the terminal, `logs/orx.jsonl`, and `logs/orx.log`; its data dir is `.orx/data` |
| `bun run stub` / `stub:stop` | Stub OpenRouter and GitHub releases on local ports; prints the env to point orx at them |
| `bun run tui:capture -- <args> --keys ...` | Runs orx in a pseudo-terminal, types keys, prints the screen |
| `bun run lint` / `format` / `typecheck` | Biome check / Biome fixes / tsc |
| `bun run test` | Every test under `tests/` (unit and TUI) with `bun test`, no network |
| `bun run e2e` | Builds `dist/orx` and tests the binary, including the TUI in a PTY |
| `bun run check` | lint, typecheck, test, e2e (CI also runs `coverage` and `build:all`) |
| `bun run coverage` | The same tests with a coverage report in `coverage/` |
| `bun run clean` | Removes `dist/`, `coverage/`, and `logs/` (`.orx/` stays) |
| `bun run build` / `build:all` | `dist/orx` for this machine / every release target plus `SHA256SUMS` |

`bun test ./tests/<file>` runs one file. `AGENTS.md` is the map of the code and conventions, for agents and people. `docs/harness.md` explains the agent harness (hooks, rules, commands, reviewers) and which layer catches which mistake. To release, bump `version` in `package.json`, commit, and push a matching `v*` tag.

## License

Copyright (c) 2026 Riley Hilliard

# Development

You need bun 1.4.2 or newer and git. `rg` (ripgrep) is optional: without it, the tests for `grep`'s ripgrep path skip.

```bash
git clone https://github.com/rileyhilliard/orx.git && cd orx
bun install
cp .env.example .env    # set OPENROUTER_API_KEY for anything that calls a real model
```

## Commands

| Command | What it does |
|---|---|
| `bun run orx -- <args>` | Runs orx from source, logging at `info` to the terminal, `logs/orx.jsonl`, and `logs/orx.log`. Chats go in `.orx/data` |
| `bun run stub` / `stub:stop` | Starts or stops the stub OpenRouter and stub GitHub releases on local ports; `stub` prints the env that points orx at them |
| `bun run demo [dir]` | Creates the demo project in a fresh git repo (a temp dir if you don't name one) |
| `bun run tui:capture -- --keys "hi<enter>"` | Runs orx in a pseudo-terminal, types the keys, and prints the screen as text |
| `bun run lint` / `format` / `typecheck` | Biome check / Biome fixes / tsc |
| `bun run test` | Every test under `tests/` (unit and TUI) with `bun test`; no network |
| `bun run e2e` | Builds `dist/orx` and tests the binary, including the TUI in a PTY |
| `bun run check` | The gate: lint, typecheck, test, and e2e. CI also runs `coverage` and `build:all` |
| `bun run coverage` | The same tests, with a coverage report in `coverage/` |
| `bun run eval --models a,b` | The coding eval against real models (needs a key; about $0.001 per model per case) |
| `bun run record:openrouter` | Re-records `tests/fixtures/openrouter/` from real OpenRouter streams (needs a key) |
| `bun run build` / `build:all` | `dist/orx` for this machine / every release target plus `SHA256SUMS` |
| `bun run clean` | Removes `dist/`, `coverage/`, and `logs/`. Dev chats in `.orx/` stay |

`bun test ./tests/<file>` runs one file. Tests never touch the network or your real config: a preload points everything at unreachable URLs and a temp HOME and clears every variable orx reads (so your `.env` can't change a result), and model calls go to the stub or to recorded OpenRouter streams.

## Without a key

`bun run stub` starts a local stand-in for OpenRouter that streams a canned reply. Nothing leaves your machine and nothing costs money.

```bash
eval "$(bun run --silent stub)"             # points this shell at the stub
bun run orx -- ask "hi"                      # streams "Hello from the stub.", usage on stderr
bun run orx -- ask hi --json | jq -c .       # NDJSON events: text, then done with tokens and cost
bun run orx -- ask --bogus; echo $?          # stdout stays empty, exit 2
bun run orx                                  # the TUI; type a message, Ctrl+C to quit
bun run --silent stub:stop
```

## The demo project

`bun run demo` writes a small TypeScript project into a fresh git repo and prints its path: a `fmtPrice` function in `src/money.ts`, used by `src/cart.ts` and `src/receipt.ts` and mentioned in its README. It's the workspace of the `rename-across-files` eval, so the right result is known and `git diff` shows exactly what the agent changed.

```bash
bun run demo
bun run orx -- --cwd <path>        # then ask: rename fmtPrice to formatPrice everywhere
bun run orx -- ask --agent --cwd <path> --permission-mode acceptEdits "rename fmtPrice to formatPrice everywhere"
git -C <path> diff
```

On `z-ai/glm-5.3-flash` the headless run takes about 5 seconds and costs about $0.001.

## What to look at in the code

| Area | Where |
| --- | --- |
| OpenRouter requests: attribution headers, `session_id`, `provider.require_parameters`, fallbacks and routing, Anthropic `cache_control` | `src/services/Llm.ts`, `runTurn` in `src/core/chat.ts` |
| The turn loop: streaming steps, tool calls, retry only before the first token, Retry-After, idle timeout, saving a partial reply on Ctrl+C | `src/core/chat.ts` |
| Mapping OpenRouter errors (402, 403, 404, 429, 503, mid-stream errors) to messages, exit codes, and `retryable` | `src/core/upstream.ts` |
| The models list: caching, tool-support check, `context_length` for context elision | `src/services/OpenRouterModels.ts`, `src/core/context.ts` |
| Token, cache, reasoning, and cost accounting | `src/core/chat.ts` (`llm call` log line), `src/core/format.ts` |
| The agent's tools and the approval gate | `src/tools/`, `src/services/permissions.ts`, `src/services/workspace.ts` |
| Tests against recorded OpenRouter streams | `tests/openrouter-replay.test.ts`, `tests/fixtures/openrouter/` |
| Real-model eval | `evals/`; results in [`rfcs/RFC001-bootstrap-agent-harness/phase-1-edits-code.md`](rfcs/RFC001-bootstrap-agent-harness/phase-1-edits-code.md) |

[`AGENTS.md`](../AGENTS.md) maps the code and its conventions. [`harness.md`](harness.md) covers how coding agents are kept on the rails in this repo (hooks, rules, reviewers). [`rfcs/RFC001-bootstrap-agent-harness/`](rfcs/RFC001-bootstrap-agent-harness/README.md) has the roadmap: what phase 1 shipped and what phases 2 and 3 propose.

## Releasing

Bump `version` in `package.json`, commit, and push a matching `v*` tag. `release.yml` checks the tag against `package.json`, runs the gate, smoke-tests each binary on its own OS and CPU, and publishes the binaries, `SHA256SUMS`, and `install.sh`.

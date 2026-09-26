# orx

Instructions for coding agents working in this repository. Keep this file under about 200 lines: it is loaded at the start of every session. Put detail that matters only for one area in a rule or doc and link it from Deeper context.

## Overview

orx is a terminal client for OpenRouter, compiled to one binary with `bun build --compile`: `orx ask` streams a reply (pipe-friendly, `--json` for NDJSON), `orx chat` is a TUI with a model picker, per-reply tokens and cost, and Markdown export, `orx extract` is a structured-output example, `orx mcp` serves the same tools over MCP, and `orx update` replaces the binary from GitHub Releases. Code is Effect 4 (`4.0.0-rc.117`): the CLI is `effect/unstable/cli`, model calls are Effect AI with `@effect/ai-openrouter`, MCP is Effect's `McpServer`, validation is Effect Schema. The TUI is OpenTUI (`@opentui/core` + `@opentui/react` 0.5.12) on React 19. Tooling: bun 1.4 (runtime, package manager, compiler, TUI and e2e tests), Node 24 (vitest 5), Biome 2, TypeScript 7 (`tsc`).

## Commands

Run these from the repo root. They are `package.json` scripts, the only supported way to build, test, and run the project; if a command here is wrong, fix it here in the same change. Unit tests are `bun run test:unit` (vitest); `bun test` runs only with a `./tests/tui` or `./e2e` path, and a hook blocks it otherwise.

| Command | What it does |
| --- | --- |
| `bun install` | Dependencies, then `scripts/prepare.ts` installs the git hooks (skipped when `CI` is set) |
| `bun run orx -- <args>` | orx from source, with `LOG_LEVEL=info`, logs in `logs/orx.jsonl` and `logs/orx.log`, chats in `.orx/data` |
| `bun run stub` / `stub:stop` | A stub OpenRouter and stub releases on local ports, detached; prints `export` lines (`eval "$(bun run --silent stub)"`) |
| `bun run tui:capture -- chat --keys "hi<enter>"` | Runs orx in a pseudo-terminal, types the keys, prints the screen as text (`--wait-for <text>`, `--bin dist/orx`) |
| `bun run lint` | `biome check .` (lint, format, import order, `biome-plugins/boundaries.grit`) |
| `bun run format` | `biome check --write .` |
| `bun run typecheck` | `tsc` |
| `bun run test` | `test:unit` (vitest on Node) then `test:tui` (`bun test ./tests/tui`) |
| `bun run test:unit tests/cli-contract.test.ts` | One vitest file; add `-t "<name>"` for one test |
| `bun run coverage` | vitest with a v8 coverage report in `coverage/` |
| `bun run e2e` | Builds `dist/orx`, then `bun test ./e2e`: the binary as a process and in a PTY, against the stubs |
| `bun run check` | The full gate: lint, typecheck, test, e2e. Run it before calling work done. CI also installs every target's native package (`bun install --os='*' --cpu='*'`), runs `coverage` in place of `test:unit`, and ends with `build:all` |
| `bun run build` / `build:all` | `dist/orx` for this machine / every release target plus `dist/SHA256SUMS` (needs `bun install --os='*' --cpu='*'`) |
| `bun run eval --models a,b` | `evals/cases.ts` against real models through orx's own programs. Needs a key, costs money, never in CI |
| `bun run record:openrouter` | Re-records `tests/fixtures/openrouter/` from real OpenRouter streams. Needs a key |
| `bun run clean` | Remove `dist/`, `coverage/`, `logs/` |

In Claude Code, `/check` runs the gate and fixes what fails, `/test` runs scoped tests then the suite, `/add-command`, `/add-service`, `/add-tool` scaffold those the way this repo does them, and `/feature` takes a feature from RFC to PR. Before committing a non-trivial change, have the `reviewer` agent review it; for design questions, use the `architect` agent.

## Architecture map

```
src/
  bin.ts            the only Bun entry: BunServices + Host, runs main, maps the exit to a code
  main.ts           one run: parse argv (Command.runWith), handler, outcome -> stderr + exit code,
                    one `command` log line. Platform-free, so vitest runs it (tests/helpers/cli.ts)
  cli.ts            the command tree
  commands/         one file per command, thin: decode -> one program -> render via Output.
                    ask, chat, models, extract, chats, export, mcp, update, doctor; shared.ts flags
  core/             programs: chat.ts (the turn loop, a Stream of TurnEvents), models.ts, extract.ts,
                    export.ts, update.ts, upstream.ts (AiError -> UpstreamUnavailable), input.ts,
                    format.ts (human output), stdin.ts, mcp-stdio.ts
  services/         Context.Service + static layers: Llm, OpenRouterModels (10 min cache), ChatStore
                    (JSON files; layerMemory), Releases, Output (the only stdout writer), Host
  tools/            Effect AI tools: ChatTools (chat + mcp), mcp.ts adds extractContact
  schemas/          Effect Schema per domain, including the config file and the NDJSON events
  config.ts         every env var and the config file via Effect Config; Paths; logConfig
  errors.ts         tagged errors, exitCodeFor + retryableFor (exhaustive), outcomeOf
  logging.ts        record shape, terminal and JSON formats, file sink; everything on stderr
  runtime.ts        AppLayer (every service; platform from outside), LoggerLayer
  tui/              Bun-only: launch.tsx (renderer + makeBridge: the only TUI file importing effect),
                    app.tsx, message-list, model-picker, types.ts (the bridge), theme.ts
scripts/            build.ts (native-lib plugin), orx-dev.ts, stub.ts + stub-server.ts, tui-capture.ts,
                    record-openrouter.ts, prepare.ts; lib/ (pty.ts, stub-pid.ts, script-layer.ts, recording.ts)
install.sh          curl | bash installer: OS/arch, SHA256SUMS check, ~/.local/bin
evals/              bun run eval: cases.ts, run.ts, score.ts (pure, unit-tested)
tests/              vitest (Node); helpers/ (cli.ts runs main, stub-openrouter.ts, stub-releases.ts);
                    fixtures/openrouter/ recorded streams; tui/ is bun test (testRender, closed loop)
e2e/                bun test against dist/orx
docs/               harness.md, rfcs/
```

Flow: `bin.ts` provides the platform and runs `main`, which parses argv and runs one handler. A handler decodes its input, runs one program from `core/`, and renders the result through `Output`. Config loads on first use (`loadConfig`), so `--help`, `--version`, `doctor`, and `update` work with a broken config file. For a chat turn, `core/chat.ts` streams one model step at a time through Effect AI, runs tool calls, and re-prompts until the model stops or `MAX_TOOL_STEPS`; the stream's `onExit` logs one `llm call` line and saves the chat, including a partial reply marked `interrupted`.

## Conventions

- stdout carries results only, and only through `Output`. Logs, notes (`Output.note`), and errors go to stderr. `main.ts` holds the CLI's own Console output (help, `--version`) and sends it to stdout on success, stderr on a usage error. `orx mcp` depends on this: one stray stdout line corrupts JSON-RPC.
- Exit codes: 0 ok (and help), 1 defect, 2 usage error / `BadInput` / `NotFound` / `UnknownModel` / `NotInteractive`, 3 `NotConfigured` / `InvalidConfig`, 4 `UpstreamUnavailable`, 5 `InvalidModelOutput`, 6 `PermissionDenied`, 130 interrupted. A new error needs a decision in `exitCodeFor` and `retryableFor` (both exhaustive) and a line in the README table.
- `--json` makes results machine-readable (NDJSON `AskEvent`s for `ask`) and errors `{"error":{tag,message,retryable}}` on stderr.
- Platform boundary: only `src/bin.ts` and `src/tui/**` may import `bun`, `bun:*`, `@effect/platform-bun`, or `@opentui/*`, or use the `Bun` global. Everything else uses Effect's `FileSystem`, `Path`, `Stdio`, `HttpClient`, so vitest can run it on Node. The `chat` and `doctor` commands reach the TUI only by dynamic `import("../tui/launch")`.
- TUI components never import `effect`; they get a `ChatBridge` (plain promises and async iterables) from `launch.tsx`. Colors come from `tui/theme.ts` only.
- Only `src/config.ts` reads the environment (`bin.ts` also clears `DEV`, which would load OpenTUI's devtools). Empty values count as unset. A new var goes in `config.ts`, `.env.example`, and the README table; one the config file should also set goes in `schemas/config-file.ts` and `fileToEnv`.
- Each service is a `Context.Service` class with static layers: `X.layer`, plus `X.layerMemory` where tests need fresh state.
- Streaming model calls retry only before the first part is emitted (`step` in `core/chat.ts`); non-streaming calls (models list, extract, releases) use Effect retry + timeout.
- Chats are JSON files in `$ORX_DATA_DIR/chats/`, written to a temp file and renamed. Two processes saving one chat: the last write wins.
- `dist/`, `coverage/`, `bun.lock`, and `tests/fixtures/openrouter/` are generated; regenerate them with their command instead of editing.

## Schemas

- Schemas live in `src/schemas/`, one file per domain, re-exported from `index.ts`. A schema and its type share a name. Ids are branded (`ChatId`).
- Decode at every trust boundary: argv values and stdin (`decodeInput`), env and the config file (Effect Config, `onExcessProperty: "error"`), third-party responses (models list, releases), and model output (extract decodes the model's object again).
- Domain errors are `Schema.TaggedError` classes in `src/errors.ts`.
- Effect AI tool parameter schemas become open JSON Schema objects (`additionalProperties: true`) and there is no option to close them; the handler still decodes its input. Zod is present only as a transitive dependency; never use it.

## Testing

- vitest 5 on Node for everything except the TUI and the binary. `tests/helpers/cli.ts` `runCli(argv, { env, stdin })` runs the real `main` and `AppLayer` with `NodeServices` and a captured `Stdio`, and returns `{ exitCode, stdout, stderr, logs }`. Prefer it: it tests the contract a user sees.
- `tests/helpers/stub-openrouter.ts` stands in for OpenRouter (`/models`, streaming and non-streaming `/chat/completions`, failures, `hangAfter`, `dropAfter`, scripted `toolCalls`, `replay(fixtures)`); `stub-releases.ts` for GitHub releases. `tests/openrouter-replay.test.ts` replays the recorded bodies in `tests/fixtures/openrouter/` through the real provider and checks text, tokens, and cost against the recordings. Point `OPENROUTER_BASE_URL` / `ORX_RELEASES_URL` at them. Nothing is module-mocked.
- `tests/isolation.ts` runs before every vitest and bun test process: no key, unreachable URLs, config, data, and HOME in a temp dir. No test can reach the network or your real files.
- `tests/tui/` (bun test): components with `@opentui/react/test-utils` and a fake bridge, `closed-loop.test.tsx` with the real bridge and programs against the stub, and a pin on the renderer options.
- `e2e/` (bun test) spawns `dist/orx` with an env built from scratch: exit codes and empty stdout, piped `ask --json`, `.env` ignored, the native library, `mcp`, the TUI in a PTY, install.sh, `update --check`. Keep it to what only the binary shows.
- A bug fix starts with a test that reproduces it. Weakening or skipping a test to get green is a failure, not a fix.

## Error handling

- Expected failures are tagged errors; `outcomeOf` in `errors.ts` turns the run's Exit into an outcome, and `main.ts` prints `orx: <message>` (or the JSON body) to stderr. Anything else is a defect: logged once with `Effect.logError`, printed as a generic message, exit 1.
- Model errors: `toUpstreamError` in `core/upstream.ts` maps each `AiError` reason to a message and `retryable` (a rejected key or request is not retryable; rate limits, 5xx, timeouts are). `ask --json` also emits an `error` event before exiting 4.
- Never swallow an error. Handle it, or add context and pass it on. Log an error once, at the boundary that handles it.

## Debugging

- If a fix hasn't worked after two attempts with no new diagnostic step in between, stop, write down what you learned, list two or three other root-cause hypotheses, and ask which to pursue.
- Drive the real CLI: `eval "$(bun run --silent stub)"`, then `bun run orx -- ask "hi"`, `bun run orx -- ask hi --json | jq`, `bun run tui:capture -- chat --keys "hi<enter>" --wait-for "in /"`. The stub needs no key and costs nothing.
- Read the logs before guessing. `logs/orx.jsonl` has one JSON object per line: `time`, `level`, `msg`, annotations as top-level keys, `error` for defects. Every run logs one `command` line (`command`, flag names, `exitCode`, `durationMs`, `runId`, `errorTag`, and `errorDetail` with OpenRouter's or GitHub's status and reason), including a run a signal interrupted; every model turn one `llm call` line (requested and served model, tokens, cost, finish reason, `aborted` when the user stopped it, `errorTag`/`errorDetail` when it failed, time to first token) with the same `runId`. `logs/orx.log` is stderr as plain text.
- Queries: `jq -c 'select(.level == "error" or .level == "warn")' logs/orx.jsonl`, `jq -c 'select(.msg == "command" and .exitCode != 0)' logs/orx.jsonl`.
- `bun run orx -- doctor --json` prints the version, paths, whether the key is set, and a config error if there is one. `--log-level debug` shows debug lines for one run.

## Build workarounds

Things in the tree that exist to get a build through, not because they are right. Re-check them when upgrading the tools involved.

| Where | What and why | Remove when |
| --- | --- | --- |
| `package.json`: `effect`, `@effect/platform-bun`, `@effect/ai-openrouter`, `@effect/platform-node`, `@effect/vitest` pinned to exactly `4.0.0-rc.117`, plus an `overrides` pin on `@effect/platform-node-shared` | RCs break APIs between releases, and every Effect package must match; bump all together, run `bun run check`, update the `effect` skill | `effect` 4.0.0 is stable; switch to `^4` ranges |
| `scripts/build.ts` native-lib plugin | a compiled binary would embed every platform's `@opentui/core-*` package it can resolve; the plugin keeps the target's only | OpenTUI or Bun select the native package per compile target |
| `src/bin.ts` deletes `process.env.DEV` | `@opentui/react` loads its devtools when `DEV=true`, which a user's shell may set | OpenTUI stops reading `DEV` |
| `src/core/mcp-stdio.ts` | Effect's stdio MCP transport stops when stdin closes and drops in-flight requests; the wrapper holds stdin open until every request has a response (or is cancelled), for at most 30 seconds | the transport drains pending requests on EOF |
| `src/commands/mcp.ts` runs the server in a child fiber | the stdio transport interrupts the fiber that started it on EOF, which would make every session exit 130 | the transport ends normally on EOF |
| `provider` is always null in `llm call` lines and replies | `@effect/ai-openrouter`'s chunk schema drops OpenRouter's `provider` field; `readOpenRouter` in `core/chat.ts` reads it when present | the provider keeps `provider` (`tests/openrouter-replay.test.ts` can then assert it) |
| `src/tui/app.tsx` reads the submitted value and remounts the input to clear it | `onInput` didn't fire for typed text under the test renderer, so a controlled draft stayed empty | a controlled `<input>` works in `tests/tui/app.test.tsx` |

## CI

- `.github/workflows/ci.yml`, one job `ci-ok` (the required check) on push to `main`, pull requests, and manual dispatch; `contents: read`. Steps: setup-bun (from `packageManager`), setup-node (`.node-version`), `bun install --frozen-lockfile --os='*' --cpu='*'`, lint, typecheck, coverage, test:tui, e2e, build:all. No `OPENROUTER_API_KEY`: tests never touch the network.
- `.github/workflows/release.yml` on a `v*` tag: checks the tag matches `package.json`, runs the gate and `build:all`, smoke-tests each binary on its own OS and CPU (`--version`, `doctor --tui`), then publishes binaries, `SHA256SUMS`, and `install.sh` (`contents: write` in that job only).
- Actions are pinned to major tags.

## Git hooks

- lefthook (`lefthook.yml`): pre-commit runs Biome on staged files; commit-msg enforces Conventional Commits (`feat fix docs style refactor perf test build ci chore revert`); pre-push runs typecheck and tests.
- Never use `--no-verify`. Fix the cause, or fix the hook.

## Deferred

Explicitly out of scope for now, so nobody mistakes them for forgotten work.

- musl Linux (OpenTUI needs `OPENTUI_LIBC=musl` at runtime) and Windows (needs install.ps1 and a smoke job). npm distribution.
- Code signing and notarization of the macOS binaries.
- Concurrent writers to one chat (last write wins); chat search; deleting chats from the CLI.

## Pending user actions

Steps only a human can do. Check here before reporting one of these as a problem.

- Put an OpenRouter key in `.env` (for `bun run orx`) or your shell (installed orx) as `OPENROUTER_API_KEY`, and set a credit limit on it at openrouter.ai. Confirm: `bun run orx -- ask hi` streams a real reply.
- Create the GitHub repo and, if it isn't `rileyhilliard/orx`, change `DEFAULT_RELEASES_REPO` in `src/config.ts` and the URL in `install.sh` before the first tag.
- Run `bun run record:openrouter` once: the fixtures were recorded through the AI SDK provider in rra, and re-recording through `@effect/ai-openrouter` confirms cost still arrives.

## Deeper context

| Need | Read |
| --- | --- |
| Install, configuration, exit codes, commands for humans | `README.md` |
| Claude Code hooks, rules, commands, agents, settings | `.claude/README.md`, `.claude/rules/src/` |
| Which layer catches which mistake, one `orx ask` turn as a diagram | `docs/harness.md` |
| Why this repo is shaped the way it is | `docs/rfcs/` |
| Effect 4 APIs (cli, ai, platform-bun), v3 names that are gone | `.agents/skills/effect/SKILL.md` |
| OpenTUI APIs, the test renderer | `.agents/skills/opentui/SKILL.md` |
| TUI design: tokens, layout, keys; avoiding generic TUI patterns | `DESIGN.md`, `.agents/skills/tui-design-slop/SKILL.md` |

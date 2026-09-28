# orx

Instructions for coding agents working in this repository. Keep this file under about 200 lines: it is loaded at the start of every session. Put detail that matters only for one area in a rule or doc and link it from Deeper context.

## Overview

orx is a starting point for a CLI that calls OpenRouter models, compiled to one binary with `bun build --compile`. It has the plumbing (config, logging, exit codes, self-update, a TUI scaffold, tests, the agent harness) and one small example of each part, meant to be replaced: `orx ask` sends one prompt and prints the reply (non-streaming, pipe-friendly, `--json` for one `AskResult` object), `orx ui` is a placeholder TUI over the same call, `orx update` replaces the binary from GitHub Releases, and `orx doctor` reports the install. Code is Effect 4 (`4.0.0-rc.117`): the CLI is `effect/unstable/cli`, model calls are Effect AI with `@effect/ai-openrouter`, validation is Effect Schema. The TUI is OpenTUI (`@opentui/core` + `@opentui/react` 0.5.12) on React 19. Tooling: bun 1.4 (runtime, package manager, compiler, test runner), Biome 2, TypeScript 7 (`tsc`).

## Commands

Run these from the repo root. They are `package.json` scripts, the only supported way to build, test, and run the project; if a command here is wrong, fix it here in the same change. `bun test` is the only test runner: a bare `bun test` runs everything under `tests/`, and `bun test ./tests/<file>` one file.

| Command | What it does |
| --- | --- |
| `bun install` | Dependencies, then `scripts/prepare.ts` installs the git hooks (skipped when `CI` is set) |
| `bun run orx -- <args>` | orx from source, with `LOG_LEVEL=info`, logs in `logs/orx.jsonl` and `logs/orx.log`, data dir `.orx/data` |
| `bun run stub` / `stub:stop` | A stub OpenRouter and stub releases on local ports, detached; prints `export` lines (`eval "$(bun run --silent stub)"`) |
| `bun run tui:capture -- ui --keys "hi<enter>"` | Runs orx in a pseudo-terminal, types the keys, prints the screen as text (`--wait-for <text>`, `--bin dist/orx`; orx's own flags after a second `--`) |
| `bun run lint` | `biome check .` (lint, format, import order, `biome-plugins/boundaries.grit`) |
| `bun run format` | `biome check --write .` |
| `bun run typecheck` | `tsc` |
| `bun run test` | `bun test`: every file under `tests/`, unit and TUI, in one process (`test:tui` for `tests/tui` alone) |
| `bun test ./tests/cli-contract.test.ts` | One file; add `-t "<name>"` for one test |
| `bun run coverage` | `bun test --coverage`, a text and lcov report in `coverage/` |
| `bun run e2e` | Builds `dist/orx`, then `bun test ./e2e`: the binary as a process and in a PTY, against the stubs |
| `bun run check` | The full gate: lint, typecheck, test, e2e. Run it before calling work done. CI also installs every target's native package (`bun install --os='*' --cpu='*'`), runs `coverage` in place of `test`, and ends with `build:all` |
| `bun run build` / `build:all` | `dist/orx` for this machine / every release target plus `dist/SHA256SUMS` (needs `bun install --os='*' --cpu='*'`) |
| `bun run clean` | Remove `dist/`, `coverage/`, `logs/` |
| `rr check` / `rr test` / `rr test -- ./tests/<file> -t "<name>"` / `rr tui -- ./tests/tui/<file>` | The same scripts on a remote Mac (`.rr.yaml`: m4-mini, m1-mini), synced with rsync; see Remote runs below |

Remote runs: `rr <task>` syncs the tree you run it from (in a worktree, its root) and runs the task on the first free host; each task checks bun >= 1.4.2 and runs `bun install --frozen-lockfile` first. `rr run "<one quoted command>"` runs anything else, e.g. `rr run 'eval "$(bun run --silent stub)" && bun run orx -- ask hi --json; bun run stub:stop'` (stop the stub in the same run). The remote has no `.git`, `.env`, or key. Pull files into a gitignored dir: `rr pull logs/orx.jsonl --dest logs/remote/` (without `--dest` they land in the repo root and sync back). Read the result event's `log_file` instead of rerunning, and don't pipe rr through `tail`.

In Claude Code, `/check` runs the gate and fixes what fails, `/test` runs scoped tests then the suite, `/add-command` and `/add-service` scaffold those the way this repo does them, and `/feature` takes a feature from RFC to PR. Before committing a non-trivial change, have the `reviewer` agent review it; for design questions, use the `architect` agent.

## Architecture map

```
src/
  bin.ts            the only Bun entry: BunServices + Host, runs main, maps the exit to a code
  main.ts           one run: parse argv (Command.runWith), handler, outcome -> stderr + exit code,
                    one `command` log line. Platform-free; tests run it through tests/helpers/cli.ts
  cli.ts            the command tree
  commands/         one file per command, thin: decode -> one program -> render via Output.
                    ask, ui, update, doctor; load-tui.ts (the dynamic TUI import), shared.ts flags
  core/             programs: ask.ts (the example model call), update.ts, upstream.ts
                    (AiError -> UpstreamUnavailable), input.ts, format.ts (human output), stdin.ts
  services/         Context.Service + static layers: Llm (OpenRouter client), Releases, Output (the
                    only stdout writer), Host
  schemas/          Effect Schema per domain: ask (Prompt, AskResult), config-file, errors
  config.ts         every env var and the config file via Effect Config; Paths; logConfig
  errors.ts         tagged errors, exitCodeFor + retryableFor (exhaustive), outcomeOf
  logging.ts        record shape, terminal and JSON formats, file sink; everything on stderr
  runtime.ts        AppLayer (every service; platform from outside), LoggerLayer
  tui/              Bun-only: launch.tsx (renderer + makeBridge: the only TUI file importing effect),
                    app.tsx (the placeholder screen), types.ts (the bridge), theme.ts
scripts/            build.ts (native-lib plugin), orx-dev.ts, stub.ts + stub-server.ts, tui-capture.ts,
                    prepare.ts; lib/ (pty.ts, stub-pid.ts)
install.sh          curl | bash installer: OS/arch, SHA256SUMS check, ~/.local/bin
tests/              bun test; helpers/ (cli.ts runs main, stub-openrouter.ts, stub-releases.ts,
                    hooks.ts); hooks/; tui/ is bun test (testRender, closed loop)
e2e/                bun test against dist/orx
docs/               harness.md
```

Flow: `bin.ts` provides the platform and runs `main`, which parses argv and runs one handler. A handler decodes its input, runs one program from `core/`, and renders the result through `Output`. Config loads on first use (`loadConfig`), so `--help`, `--version`, `doctor`, and `update` work with a broken config file. For `ask`, `core/ask.ts` calls `LanguageModel.generateText` once through `Llm`, with a 60-second timeout and two retries of retryable upstream errors, and logs one `llm call` line. `orx ui` runs the same program through the TUI bridge.

## Conventions

- stdout carries results only, and only through `Output`. Logs, notes (`Output.note`), and errors go to stderr. `main.ts` holds the CLI's own Console output (help, `--version`) and sends it to stdout on success, stderr on a usage error. `--json` and pipes depend on this: one stray stdout line breaks them.
- Exit codes: 0 ok (and help), 1 defect, 2 usage error / `BadInput` / `NotInteractive`, 3 `NotConfigured` / `InvalidConfig` / `TuiUnavailable`, 4 `UpstreamUnavailable`, 6 `PermissionDenied`, 130 interrupted (5 is free). A new error needs a decision in `exitCodeFor` and `retryableFor` (both exhaustive) and a line in the README table.
- `--json` makes results machine-readable (one `AskResult` object for `ask`) and errors `{"error":{tag,message,retryable}}` on stderr.
- Platform boundary: only `src/bin.ts` and `src/tui/**` may import `bun`, `bun:*`, `@effect/platform-bun`, or `@opentui/*`, or use the `Bun` global. Everything else is platform-free: it uses Effect's `FileSystem`, `Path`, `Stdio`, `HttpClient`, which `bin.ts` provides (`BunServices`). The `ui` and `doctor` commands reach the TUI only by dynamic `import("../tui/launch")`.
- TUI components never import `effect`; they get a `UiBridge` (plain data and promises) from `launch.tsx`. Colors come from `tui/theme.ts` only.
- Only `src/config.ts` reads the environment (`bin.ts` also clears `DEV`, which would load OpenTUI's devtools). Empty values count as unset. A new var goes in `config.ts`, `.env.example`, and the README table; one the config file should also set goes in `schemas/config-file.ts` and `fileToEnv`.
- Each service is a `Context.Service` class with static layers: `X.layer`, plus a variant named by what differs (`X.layerMemory`) only where a test needs one.
- Non-streaming calls (`ask`, releases) use Effect retry (retryable errors only) + timeout, one retry layer. A streaming call you add must retry only before its first part reaches the user, or it prints text twice.
- `Paths.dataDir` (`$ORX_DATA_DIR`) is where persistent files belong; nothing writes there yet. Write a file to a temp name and rename it.
- `dist/`, `coverage/`, and `bun.lock` are generated; regenerate them with their command instead of editing.

## Schemas

- Schemas live in `src/schemas/`, one file per domain, re-exported from `index.ts`. A schema and its type share a name. Brand ids when you add them.
- Decode at every trust boundary: argv values and stdin (`decodeInput`), env and the config file (Effect Config, `onExcessProperty: "error"`), third-party responses (releases), and model output you act on (decode structured output again).
- Domain errors are `Schema.TaggedError` classes in `src/errors.ts`.
- Zod is present only as a transitive dependency; never use it.

## Testing

- `bun test` (`bun:test`) for everything; every file under `tests/` shares one process, so a test puts back what it changes (`restoreEnv`, `mock.restore()`, closed stubs). `tests/helpers/cli.ts` `runCli(argv, { env, stdin })` runs the real `main` and `AppLayer` with `BunServices` and a captured `Stdio`, and returns `{ exitCode, stdout, stderr, logs }`. Prefer it: it tests the contract a user sees.
- `tests/helpers/stub-openrouter.ts` stands in for OpenRouter (`/models`, streaming and non-streaming `/chat/completions`, `failCompletions`, `hangAfter`, `dropAfter`, scripted `toolCalls`; `chatRequests` holds what it received); `stub-releases.ts` for GitHub releases. Point `OPENROUTER_BASE_URL` / `ORX_RELEASES_URL` at them. Nothing is module-mocked.
- `tests/isolation.ts` runs before every `bun test` run (the `bunfig.toml` preload): no key, unreachable URLs, config, data, and HOME in a temp dir. No test can reach the network or your real files.
- `tests/tui/` (bun test): `app.test.tsx` with `@opentui/react/test-utils` and a fake bridge (wait with `waitForScreen` from `render.ts`), `closed-loop.test.tsx` with the real bridge and programs against the stub, and a pin on the renderer options.
- `e2e/` (bun test) spawns `dist/orx` with an env built from scratch: exit codes and empty stdout, piped `ask --json`, `.env` ignored, the native library, `orx ui` in a PTY, install.sh, `update` and `update --check`. Keep it to what only the binary shows.
- A bug fix starts with a test that reproduces it. Weakening or skipping a test to get green is a failure, not a fix.

## Error handling

- Expected failures are tagged errors; `outcomeOf` in `errors.ts` turns the run's Exit into an outcome, and `main.ts` prints `orx: <message>` (or the JSON body) to stderr. Anything else is a defect: logged once with `Effect.logError`, printed as a generic message, exit 1.
- Model errors: `toUpstreamError` in `core/upstream.ts` maps each `AiError` reason to a message and `retryable` (a rejected key or request is not retryable; rate limits, 5xx, timeouts are).
- Never swallow an error. Handle it, or add context and pass it on. Log an error once, at the boundary that handles it.

## Debugging

- If a fix hasn't worked after two attempts with no new diagnostic step in between, stop, write down what you learned, list two or three other root-cause hypotheses, and ask which to pursue.
- Drive the real CLI: `eval "$(bun run --silent stub)"`, then `bun run orx -- ask "hi"`, `bun run orx -- ask hi --json | jq`, `bun run tui:capture -- ui --keys "hi<enter>" --wait-for "in /"`. The stub needs no key and costs nothing.
- Read the logs before guessing. `logs/orx.jsonl` has one JSON object per line: `time`, `level`, `msg`, annotations as top-level keys, `error` for defects. Every run logs one `command` line (`command`, flag names, `exitCode`, `durationMs`, `runId`, `errorTag`, and `errorDetail` with OpenRouter's or GitHub's status and reason), including a run a signal interrupted; every model call one `llm call` line (requested and served model, tokens, cost, finish reason; at `warn` with `errorTag`/`errorDetail` when it failed) with the same `runId`. `logs/orx.log` is stderr as plain text.
- Queries: `jq -c 'select(.level == "error" or .level == "warn")' logs/orx.jsonl`, `jq -c 'select(.msg == "command" and .exitCode != 0)' logs/orx.jsonl`.
- `bun run orx -- doctor --json` prints the version, paths, whether the key is set, and a config error if there is one. `--log-level debug` shows debug lines for one run.

## Build workarounds

Things in the tree that exist to get a build through, not because they are right. Re-check them when upgrading the tools involved.

| Where | What and why | Remove when |
| --- | --- | --- |
| `package.json`: `effect`, `@effect/platform-bun`, `@effect/ai-openrouter` pinned to exactly `4.0.0-rc.117`, plus an `overrides` pin on `@effect/platform-node-shared` (`@effect/platform-bun` depends on it with a caret range) | RCs break APIs between releases, and every Effect package must match; bump all together, run `bun run check`, update the `effect` skill | `effect` 4.0.0 is stable; switch to `^4` ranges |
| `scripts/build.ts` native-lib plugin | a compiled binary would embed every platform's `@opentui/core-*` package it can resolve; the plugin keeps the target's only | OpenTUI or Bun select the native package per compile target |
| `src/bin.ts` deletes `process.env.DEV` | `@opentui/react` loads its devtools when `DEV=true`, which a user's shell may set | OpenTUI stops reading `DEV` |
| `src/tui/app.tsx` reads the submitted value and remounts the input to clear it | `onInput` didn't fire for typed text under the test renderer, so a controlled draft stayed empty | a controlled `<input>` works in `tests/tui/app.test.tsx` |

## CI

- `.github/workflows/ci.yml`, one job `ci-ok` (the required check) on push to `main`, pull requests, and manual dispatch; `contents: read`. Steps: setup-bun (from `packageManager`), `bun install --frozen-lockfile --os='*' --cpu='*'`, lint, typecheck, coverage (every test under `tests/`), e2e, build:all. No Node: `bun run` aliases `node` to bun for the `tsc` and `biome` shims when none is on PATH. No `OPENROUTER_API_KEY`: tests never touch the network.
- `.github/workflows/release.yml` on a `v*` tag: checks the tag matches `package.json`, runs the gate and `build:all`, smoke-tests each binary on its own OS and CPU (`--version`, `doctor --tui`), then publishes binaries, `SHA256SUMS`, and `install.sh` (`contents: write` in that job only).
- Actions are pinned to major tags.

## Git hooks

- lefthook (`lefthook.yml`): pre-commit runs Biome on staged files; commit-msg enforces Conventional Commits (`feat fix docs style refactor perf test build ci chore revert`); pre-push runs typecheck and tests.
- Never use `--no-verify`. Fix the cause, or fix the hook.

## Deferred

Explicitly out of scope for now, so nobody mistakes them for forgotten work.

- musl Linux (OpenTUI needs `OPENTUI_LIBC=musl` at runtime) and Windows (needs install.ps1 and a smoke job). npm distribution.
- Code signing and notarization of the macOS binaries.

## Pending user actions

Steps only a human can do. Check here before reporting one of these as a problem.

- Put an OpenRouter key in `.env` (for `bun run orx`) or your shell (installed orx) as `OPENROUTER_API_KEY`, and set a credit limit on it at openrouter.ai. Confirm: `bun run orx -- ask hi` prints a real reply.
- Create the GitHub repo and, if it isn't `rileyhilliard/orx`, change `DEFAULT_RELEASES_REPO` in `src/config.ts` and the URL in `install.sh` before the first tag.

## Deeper context

| Need | Read |
| --- | --- |
| Install, configuration, exit codes, commands for humans | `README.md` |
| Claude Code hooks, rules, commands, agents, settings | `.claude/README.md`, `.claude/rules/src/` |
| Which layer catches which mistake, one `orx ask` run as a diagram | `docs/harness.md` |
| Effect 4 APIs (cli, ai, platform-bun), v3 names that are gone | `.agents/skills/effect/SKILL.md` |
| OpenTUI APIs, the test renderer | `.agents/skills/opentui/SKILL.md` |
| TUI design: tokens, layout, keys; avoiding generic TUI patterns | `DESIGN.md`, `.agents/skills/tui-design-slop/SKILL.md` |

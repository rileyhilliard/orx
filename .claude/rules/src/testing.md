---
paths:
  - "tests/**"
  - "e2e/**"
  - "vitest.config.ts"
  - "bunfig.toml"
---

# Testing

## Two runners

| Runner | Runs | Command |
| --- | --- | --- |
| vitest 5 on Node 24 | `tests/**/*.test.ts` except `tests/tui/` (commands, programs, services, schemas, config, logging, hooks) | `bun run test:unit [file] [-t "<name>"]` |
| `bun test` | `tests/tui/` (OpenTUI's `testRender` needs Bun) | `bun run test:tui`, or `bun test ./tests/tui/<file>` |
| `bun test` | `e2e/` (the compiled binary in a PTY) | `bun run e2e` (builds first) |

`bun run test` runs both unit and TUI suites and takes no arguments. A bare `bun test` would also collect the vitest files, and vitest on `tests/tui` can't load OpenTUI; the `guard-commands` hook denies both. Code that vitest imports must run on Node: that's the platform boundary in `cli.md`.

## No network, no real state

- Both runners start from `isolateEnv()` in `tests/isolation.ts` (vitest `setupFiles`, bun's `bunfig.toml` preload): empty `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` and `ORX_RELEASES_URL` at `127.0.0.1:9`, `HOME`, `XDG_CONFIG_HOME`, and `ORX_DATA_DIR` in a fresh temp dir, `ORX_LOG_FILE` empty. bun auto-loads `.env`, so the preload is what keeps a real key out. A test that needs a key or a stub sets it explicitly.
- `runCli` builds its env from scratch (a dummy key, unreachable URLs, a temp root) and parses it with the real config; e2e spawns the binary with an env built from scratch, never `process.env`.
- The only fakes are for third parties: the stub OpenRouter (`tests/helpers/stub-openrouter.ts`: `/models`, streaming `/chat/completions` from hand-written or recorded bodies, failures, hangs, and the requests it received), the stub releases server (`tests/helpers/stub-releases.ts`), and a scripted `LanguageModel` through `Llm.layerModel`. Never mock our own modules or services; use the real layers (`ChatStore.layerMemory` where a test needs fresh in-memory state).

## Where a test goes

- Commands: argv through `runCli(argv, { env, stdin, stdoutIsTerminal, host, root })` (`tests/helpers/cli.ts`), which runs the real `main` and `AppLayer` on `NodeServices` with a test `Stdio`. Assert `exitCode`, `stdout` (only the result; empty on failure), `stderr`, and `logs` (every record, debug and up). `ndjson(stdout)` parses `--json` streams. Reuse `root` across runs to see saved chats.
- Programs and services: `@effect/vitest` (`it.effect`) with the layers they need, for anything time-based (`TestClock`) or below the CLI.
- TUI: `tests/tui/` with a fake `ChatBridge` (`tui.md`).
- The compiled binary: `e2e/`, only for what only the binary can break (`distribution.md`).

## Required coverage

- Every tagged error a command can produce, asserted by exit code and `retryable` through `runCli`, with stdout empty and the `--json` error shape on stderr.
- The stdout contract: help on stdout for `--help`, nothing on stdout for a bad flag, `--json` errors as JSON on stderr, `orx mcp` writing only JSON-RPC frames (`tests/cli-contract.test.ts`, `tests/mcp.test.ts`).
- The turn loop (`effect-ai.md`, Tests), the OpenRouter request body for each setting, the models cache TTL with `TestClock`, and retry schedules.
- A key in the config file never reaching a request; a broken config file not breaking `--help`, `--version`, `doctor`, or `update`.
- `update`: checksum mismatch changes nothing, running from source refuses, a read-only install dir exits 6.

## Hooks, recorded fixtures, evals

- `tests/hooks/` runs each hook in `.claude/hooks/` through its wired command, with a JSON payload on stdin (helpers in `tests/helpers/hooks.ts`); `wiring.test.ts` checks `settings.json`. A new guard pattern gets a deny row and a near miss that must pass. Rows are named after the command; the guards ignore quoted text, so `-t "<name>"` works. Run them with `bun run test:unit tests/hooks`.
- `tests/fixtures/openrouter/*.sse` are real OpenRouter bodies replayed through the real provider. Don't hand-edit them (a hook denies it); re-record with `bun run record:openrouter` (needs a key) after upgrading `effect` or `@effect/ai-openrouter`.
- `bun run eval` calls the real API and costs money, so it's manual and never part of `bun run test` or CI. Its pure scoring is unit-tested.

## Effect tests

- `it.effect` runs on the TestClock (import `TestClock` from `"effect/testing"`; it starts at 0 and moves only on `TestClock.adjust`; `Effect.forkChild` the program, adjust, then join) and routes the default logger to the TestConsole. `runCli` uses `Effect.runPromise`, so it is on the live clock: test time-based behavior on the program or service, not through argv.
- `it.layer` shares one layer build across its block; use a fresh `Effect.provide(layer)` per test when state must not leak.

## Discipline

- A bug fix starts with a test that fails for the bug's reason. Reintroduce the bug once to see it go red.
- A validation or limit test must prove the check bites: feed input that should be rejected and assert the rejection, not just that valid input passes.
- Never sleep to wait for something: wait on a condition (`vi.waitFor`, `waitForFrame`), or drive the clock.
- Weakening an assertion, adding `.skip`, or loosening a limit to get green is a failure, not a fix.
- A subagent asked to write tests touches only test files; check with `git diff --stat`.

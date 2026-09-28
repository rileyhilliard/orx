---
paths:
  - "tests/**"
  - "e2e/**"
  - "bunfig.toml"
---

# Testing

## One runner

`bun test` (`bun:test`) runs everything, on the Bun platform code the binary ships (`BunServices`).

| Runs | Command |
| --- | --- |
| everything under `tests/`: commands, programs, services, schemas, config, logging, hooks, and `tests/tui/` | `bun run test` (a bare `bun test`: `bunfig.toml` roots it at `tests/`), `bun test ./tests/<file> [-t "<name>"]` |
| `tests/tui/` alone | `bun run test:tui` |
| `e2e/` (the compiled binary in a PTY) | `bun run e2e` (builds first; `e2e/` is outside the root, so `bun test` never runs it against a stale binary) |

Every file runs in one process, one after another, sharing `process.env`, module state, and the event loop (no `--isolate`). A file that changes shared state puts it back: `stubEnv`/`restoreEnv` (`tests/helpers/env.ts`) in `afterEach` for env vars, `mock.restore()` after `spyOn`, `close()` every stub server in `afterAll`, `renderer.destroy()` every TUI renderer. Effect's default `ConfigProvider` reads `process.env` once per process, so a test that sets env for Effect code provides `ConfigProvider.fromEnv()` built after the change (as `runCli` does). `describe` takes no options in bun: a slow test passes its timeout as the third argument to `it`. vitest is gone, and the `guard-commands` hook denies running or installing it.

## No network, no real state

- Every run starts from `isolateEnv()` in `tests/isolation.ts` (the `bunfig.toml` preload, `tests/setup.ts`): empty `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` and `ORX_RELEASES_URL` at `127.0.0.1:9`, `HOME`, `XDG_CONFIG_HOME`, and `ORX_DATA_DIR` in a fresh temp dir, `ORX_LOG_FILE` empty. bun auto-loads `.env`, so the preload is what keeps a real key out. A test that needs a key or a stub sets it explicitly.
- `runCli` builds its env from scratch (a dummy key, unreachable URLs, a temp root) and parses it with the real config; e2e spawns the binary with an env built from scratch, never `process.env`.
- The only fakes are for third parties: the stub OpenRouter (`tests/helpers/stub-openrouter.ts`) and the stub releases server (`tests/helpers/stub-releases.ts`). The model is always the real provider pointed at the stub, which serves `/models` and streaming and non-streaming `/chat/completions` and can be scripted per test: `completion` (the reply, model, usage, and cost), `failCompletions` (an error response, optionally for the first `times` requests), `toolCalls` (a queue of `{ name, arguments }` streamed as tool calls), `dropAfter` (N deltas, then drop the connection), and `hangAfter` (N deltas, then never finish); `chatRequests` holds what it received. Never mock our own modules or services; use the real layers (a `layerMemory` variant where a test needs fresh in-memory state).

## Where a test goes

- Commands: argv through `runCli(argv, { env, stdin, stdoutIsTerminal, host, root })` (`tests/helpers/cli.ts`), which runs the real `main` and `AppLayer` on `BunServices` with a test `Stdio`. Assert `exitCode`, `stdout` (only the result; empty on failure), `stderr`, and `logs` (every record, debug and up). `ndjson(stdout)` parses NDJSON if a command streams. Reuse `root` across runs to see files an earlier run saved.
- Programs and services: an Effect body run with `runTest` (`tests/helpers/effect.ts`) and the layers it needs, for anything time-based (`TestClock`) or below the CLI.
- TUI: `tests/tui/` with a fake `UiBridge` (`tui.md`).
- The compiled binary: `e2e/`, only for what only the binary can break (`distribution.md`).

## Required coverage

- Every tagged error a command can produce, asserted by exit code and `retryable` through `runCli`, with stdout empty and the `--json` error shape on stderr.
- The stdout contract: help on stdout for `--help`, nothing on stdout for a bad flag, `--json` errors as JSON on stderr (`tests/cli-contract.test.ts`).
- Each model call (`effect-ai.md`, Tests), the OpenRouter request body for each setting, and retry schedules.
- A key in the config file never reaching a request; a broken config file not breaking `--help`, `--version`, `doctor`, or `update`.
- `update`: checksum mismatch changes nothing, running from source refuses, a read-only install dir exits 6.

## Hooks

- `tests/hooks/` runs each hook in `.claude/hooks/` through its wired command, with a JSON payload on stdin (helpers in `tests/helpers/hooks.ts`); `wiring.test.ts` checks `settings.json`. A new guard pattern gets a deny row and a near miss that must pass. Rows are named after the command; the guards ignore quoted text, so `-t "<name>"` works. Run them with `bun test ./tests/hooks`.

## Effect tests

- `it("...", () => runTest(Effect.gen(function* () { ... })))`: `runTest` gives the body a fresh `Scope`, the TestClock (import `TestClock` from `"effect/testing"`; it starts at 0 and moves only on `TestClock.adjust`; `Effect.forkChild` the program, adjust, then join), and the TestConsole (the default logger prints nothing). A failed `expect` inside the body rejects the promise and fails the test. `runCli` uses `Effect.runPromise`, so it is on the live clock: test time-based behavior on the program or service, not through argv.
- Provide layers per test (`Effect.provide(layer)` inside the body) so state doesn't leak; a `layerMemory` variant starts empty on every build.

## Discipline

- A bug fix starts with a test that fails for the bug's reason. Reintroduce the bug once to see it go red.
- A validation or limit test must prove the check bites: feed input that should be rejected and assert the rejection, not just that valid input passes.
- Never sleep to wait for something: wait on a condition (`waitFor` from `tests/helpers/wait.ts`, `waitForScreen`), or drive the clock.
- Weakening an assertion, adding `.skip`, or loosening a limit to get green is a failure, not a fix.
- A subagent asked to write tests touches only test files; check with `git diff --stat`.

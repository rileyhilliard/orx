---
paths:
  - "src/bin.ts"
  - "src/main.ts"
  - "src/cli.ts"
  - "src/commands/**"
  - "src/services/Output.ts"
  - "src/errors.ts"
  - "src/core/stdin.ts"
  - "src/core/input.ts"
  - "src/core/format.ts"
---

# CLI: commands, the stdout contract, exit codes

## Thin commands

- A command in `src/commands/<name>.ts` is `Command.make(name, { ...flags, ...args }, handler)` with a description, added to `withSubcommands` in `src/cli.ts`. The handler decodes its input (`decodeInput(Schema)` for an argument, flag value, or stdin), runs one program from `src/core/`, and renders the result through `Output`. No business logic, no HTTP, no config parsing in the handler.
- Shared flags live in `src/commands/shared.ts` (`jsonFlag`, `modelFlag`). Reuse them so `--json` and `--model`/`-m` mean the same thing everywhere.
- A command that talks to the model takes `modelFlag`; `OPENROUTER_MODEL` (`config.defaultModel`) applies only when no model was given. Ids aren't checked against a list: OpenRouter rejects an unknown one (exit 4, not retryable). Yield `(yield* Llm).ready` before reading stdin, so a missing key fails (exit 3) before the command waits on a pipe. Config is loaded inside the program that needs it (`loadConfig`), never at the top of `main`: `--help`, `--version`, `doctor`, and `update` must work with no key and a broken config file.
- Piped input: `readPipedStdin` returns `undefined` at a terminal, so a command never blocks on a keyboard it didn't ask for. `orx ui` needs a TTY on stdin and stdout and fails with `NotInteractive` (exit 2) pointing at `orx ask` otherwise.
- Interactive-only code (the TUI) is loaded through `importTui` (`src/commands/load-tui.ts`, a dynamic `import("../tui/launch")`) inside the handler, so vitest and every other command never load OpenTUI.

## Platform boundary

vitest runs everything except `tests/tui/` on Node, so only `src/bin.ts` and `src/tui/**` may use `bun`, `bun:*`, the `Bun` global, `@effect/platform-bun`, or `@opentui/*`. Everything else uses Effect's `FileSystem`, `Path`, `Stdio`, `Terminal`, and `HttpClient`, provided by `BunServices` in `bin.ts` and `NodeServices` in tests. `process.env` is read only in `src/config.ts` (and `bin.ts`, which deletes `DEV` so `@opentui/react` never loads its devtools for a user with `DEV=true`). The `guard-boundaries` hook denies these before the write and `biome-plugins/boundaries.grit` fails lint on them. If a rule is wrong for a case, change both, don't route around them.

## stdout contract

stdout carries results only; `orx ... | jq` and every script reading `--json` depend on it.

- Results go through the `Output` service (`write`, `line`, `json`). Notes for the person (the usage line after a reply, a hint) go through `Output.note`, which writes stderr. Logs go to stderr and the log file (`logging.ts`). No `console.*` anywhere in `src/`; `process.stdout` only in `bin.ts`, and `process.stderr` only in `bin.ts`, `logging.ts` (the terminal sink), and `config.ts` (the color default's TTY check). Both guards deny the rest.
- `effect/unstable/cli` prints help, `--version`, completions, and (with `renderErrors` on) parse errors through Effect's `Console`, a `Context.Reference` whose default is the global console, so all of it lands on stdout, including the help it prints for a usage error. `main` runs `Command.runWith(cli, { version, renderErrors: false })(argv)` with a holding `Console` and flushes what it held to stdout only for `ok`/`help` outcomes; errors are rendered by `main` on stderr, as `{"error":{tag,message,retryable}}` when argv contains `--json` (parse errors happen before any handler sees its flags). `--wizard` is interactive and prints as it goes.
- `BunRuntime.runMain(..., { disableErrorReporting: true, teardown })`: the default error reporting logs the failure through the default logger, which is `console.log`. The loggers are provided at the outermost layer so nothing Effect logs reaches stdout.
- With `--json`: one JSON value for a result (`orx ask --json` prints one `AskResult`), NDJSON if a command streams. Every shape has a schema in `src/schemas/`, and it's a public contract: add fields, don't rename or remove them.
- No ANSI on stdout when it isn't a TTY; `Output.color` (stderr notes) is off with `NO_COLOR` or a non-TTY stderr. A closed pipe (`orx ask hi | head -1`) ends the run quietly (EPIPE is an interrupt, not a defect).

## Exit codes

`exitCodeForOutcome` in `src/errors.ts` is the only mapping: 0 ok, `--help`, a bare `orx`, and quitting the TUI with Ctrl+C; 1 defect; 2 usage (`CliError`), `BadInput`, `NotInteractive`; 3 `NotConfigured`, `InvalidConfig`, `TuiUnavailable`; 4 `UpstreamUnavailable`; 6 `PermissionDenied`; 130 interrupted by a signal. 5 is unused. They are documented in the README; changing one is a breaking change for scripts. A new tagged error needs a case in `exitCodeFor` and `retryableFor` (both exhaustive) and a test that asserts its code through `runCli`.

## Logging per invocation

`main` logs one `command` line per run, including parse errors and `--version`: the subcommand, flag names (never values), `exitCode`, `durationMs`, `runId`, `errorTag`. Don't add another per-command line. `--log-level` (built in) overrides `LOG_LEVEL` for one run.

## Tests

Every command gets argv-level tests through `runCli` (`tests/helpers/cli.ts`), which runs the same `main` and `AppLayer` on Node with stdin, stdout, stderr, and logs captured. Assert the exit code, that stdout holds only the result (and is empty on failure), the `--json` shape, and the stderr message. `tests/cli-contract.test.ts` holds the cross-command contract (bad flag, `--json` errors, help to stdout, exit codes).

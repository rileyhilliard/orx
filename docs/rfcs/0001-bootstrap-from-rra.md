# RFC 0001: Bootstrap orx from rra

Status: accepted after review · 2026-09-26

## Why

`rra` (`~/Projects/openrouter`) is a turnkey fullstack sandbox: a small but real OpenRouter app plus an agent harness (tested hooks, path-scoped rules, slash commands, review agents, skills), one `bun run check` gate, lefthook, one-job CI, structured dev logs, a stub OpenRouter, replay fixtures, and evals. orx is the same thing for CLI development. The product is a compiled Bun binary instead of a web app, and the harness guards the mistakes that matter for a CLI: a stray line on stdout, a wrong exit code, a platform import that breaks the Node test runner, a TUI that steals signals, a binary that can't load its native library.

The example app mirrors rra's features so every harness piece guards something real: streaming chat (the TUI), a searchable model picker, per-reply tokens and cost, Markdown export, and structured extraction, plus what a CLI adds: one-shot `ask` for pipes and agents, `--json`, stable exit codes, an MCP server, and self-update.

## Scope

In: the CLI and TUI above, the harness port, a release pipeline (GitHub Releases, `SHA256SUMS`, `install.sh`, `orx update`), and the docs. Out, and listed under Deferred in `AGENTS.md`: musl and Windows builds, npm distribution, auth, concurrent-writer safety for chats.

## Design

The stack is fixed: Bun 1.4 (package manager, script runner, `bun build --compile`), Effect 4 (`effect/unstable/cli`, `unstable/ai`, `unstable/ai`'s MCP server, `@effect/platform-bun`, `@effect/ai-openrouter`), OpenTUI 0.5 with React 19, Effect Schema only, Biome 2, TypeScript 7.

### The platform boundary

Tests run on vitest under Node, except the TUI tests and e2e, which need Bun (`@opentui/react/test-utils`, PTYs). So code vitest imports must run on Node: only `src/bin.ts` and `src/tui/**` may use `bun:*`, the `Bun` global, `@effect/platform-bun`, or `@opentui/*`. Everything else uses Effect's abstract services (`FileSystem`, `Path`, `Stdio`, `HttpClient`); `bin.ts` provides the Bun implementations and tests provide Node's. This is the CLI's version of rra's `.server/` boundary, and it's enforced the same way: a PreToolUse hook (`guard-boundaries.ts`) and a Grit rule.

### The stdout contract

stdout carries results only, so pipes and `orx mcp` work. Effect's defaults violate that (CLI errors and help render to the console, `runMain` reports failures, the default logger can print to stdout), so `src/main.ts` owns the process edge: `Command.runWith` with `renderErrors: false`, the CLI's console output held and flushed only on success or help, errors rendered to stderr (as JSON with `--json`), every logger on stderr or the log file, and one `command` log line per run. Exit codes come from `exitCodeFor`, which switches exhaustively on the error tag.

### The chat turn

Effect AI resolves tool calls once per request and has no step concept, so `core/chat.ts` loops: it re-prompts with tool results up to `MAX_TOOL_STEPS`, sums usage and cost across steps, and retries a step only while nothing has been emitted (a retry after a delta reached stdout would print it twice). The chat is saved on exit, partial and marked interrupted on failure or Ctrl+C. ChatStore writes each chat through a temp file and a rename, so an interrupted write can't truncate it.

### The TUI bridge

`orx chat` dynamic-imports `src/tui/launch.tsx`, so vitest never loads OpenTUI. The launcher creates the renderer with `exitOnCtrlC: false` and `exitSignals: []`, so Effect owns signals and Ctrl+C is a keybinding that ends the handler with exit 0. Components get plain async functions and async iterables with errors already mapped to `{ message, retryable }`, and never import `effect`.

### Distribution

`scripts/build.ts` compiles one binary per target with a plugin that stubs every other target's OpenTUI native package, so each binary embeds one native library. `release.yml` builds all four targets, smoke-tests each binary on its own OS and CPU (`--version`, `doctor --tui`), and publishes them with `SHA256SUMS` and `install.sh`. `orx update` verifies the checksum, writes a temp file next to the binary, and renames it over the old one (macOS kills a signed binary that's overwritten in place).

## Review notes

A devil's-advocate review of the plan raised these, and the plan changed for each:

- The framework defaults print to stdout in several places, and one stray line corrupts `orx mcp`. The process edge (above) now owns all output, and tests assert stdout is empty on errors and holds only JSON-RPC frames in `orx mcp`.
- A broken config file shouldn't break `--help`, `--version`, `doctor`, or `update`. Config is loaded lazily in the handlers that need it, and the releases settings are read separately from the rest.
- Bun auto-loads `.env`, and `@opentui/react` loads devtools when `DEV` is set. The build turns dotenv autoload off (e2e checks it), `bin.ts` clears `DEV`, and the test preload overrides every variable that could reach the network or real state.
- A cross-compiled binary that embeds the wrong native library, or none, builds fine and fails at runtime. The native-lib plugin plus `doctor --tui` in e2e and in the release smoke matrix catch that.
- Retrying a streamed step after output started would duplicate text. The retry predicate checks whether anything was emitted.
- Updating in place can leave a truncated binary or get it killed on macOS. `update` writes a temp file and renames it, and maps EACCES to exit 6 with a hint.

## What changed during execution

- `McpServer.layerStdio` interrupts the fiber that started it when stdin ends, dropping requests still in flight. `orx mcp` runs the server in a child fiber and wraps stdio (`core/mcp-stdio.ts`) so it drains pending requests first. Both are in the Build workarounds table.
- `@effect/ai-openrouter` drops the `provider` field from stream chunks, so the served provider is always null in `llm call` lines and evals.
- `doctor` is a visible command, not hidden: it's the first thing to run when something is off.
- The release smoke matrix uses `macos-15-intel` for x64 macOS (`macos-13` runners are retired). The linux binaries are checked only in CI.
- The harness port was committed after the code, not before it as the plan ordered, and the code was written in a session rooted at rra, so rra's hooks (not orx's) guarded it. Two reviews afterwards (orx's `reviewer` checklist and a plan-conformance review) found what orx's own guards would have: a static TUI import path and stdout writes the boundary checks didn't cover, now covered.
- OpenTUI's `onInput` doesn't fire under the test renderer, so the composer submits the value passed to `onSubmit` and remounts after each send.

## Changes from the reviews

Fixed after review, each with a test: a stopped or failed turn is saved as interrupted (and a failure with no output saves nothing, so an empty assistant message never goes back to the model); a tool's bad input returns to the model (`failureMode: "return"`); no retry once output started (tested with a stub stream that drops mid-reply); every `--json` failure after parsing ends with an `error` event; the `command` line can't log prompt text, names the command after global flags, and is written when a signal interrupts; a closed stdout exits 0; `export -o` and the TUI export map write errors to exit 2 or 6; a TUI that can't load is `TuiUnavailable` (exit 3) and `doctor --tui` reports it; update retries only what a retry can fix and allows 5 minutes per download; install.sh detects musl under `pipefail` and renames within the install dir; `orx mcp` stops waiting for cancelled requests and after 30 seconds. The binary embeds a sourcemap.

## Verification

`bun run check` green: lint, typecheck, vitest, the bun TUI tests, and e2e of the compiled binary against the stubs, including the TUI in a PTY and `install.sh`. By hand: the manual QA pass listed in the plan, run as an agent through `bun run stub`, `bun run orx`, and `bun run tui:capture`.

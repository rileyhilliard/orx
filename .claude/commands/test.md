---
description: Run tests scoped to what changed, then the full suite
argument-hint: "[test file or -t pattern]"
---

Run tests for: $ARGUMENTS

1. If a file or pattern was given, run just that on the right runner: `bun run test:unit <file>` or `bun run test:unit -t "<name>"` for anything outside `tests/tui/`, `bun test ./tests/tui/<file>` for the TUI. Otherwise pick the test files covering what changed (`git diff --name-only` against the last commit) and run those. `bun run test` takes no arguments here.
2. When they pass, run `bun run test` (vitest, then the TUI suite). If the change touched `scripts/build.ts`, `src/bin.ts`, or anything the compiled binary does differently, also `bun run e2e`.
3. For a failure, read the assertion and the stack, find the cause, and fix the code (or the test, if the test was wrong: say which and why). Never skip, weaken, or delete a test to get green.

Report the pass/fail/skip counts from the final run of each runner.

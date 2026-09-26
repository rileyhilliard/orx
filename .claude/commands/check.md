---
description: Run the full quality gate (lint, typecheck, unit and TUI tests, build + e2e) and fix what fails
---

Run the project's gate and fix everything it reports.

1. `bun run lint`. If it fails, `bun run format` fixes formatting and safe lint issues; fix the rest by hand (a `boundaries.grit` diagnostic names the rule file to read). Re-run until clean.
2. `bun run typecheck` (`tsc`, covering `src/`, `tests/`, `scripts/`, and `.claude/hooks/`).
3. `bun run test:unit`, then `bun run test:tui`. Read the pass/skip counts from both runners, not just the exit code.
4. `bun run e2e`. It builds `dist/orx` first (which catches a broken compile, a bad native-lib plugin, or a Bun-only import the unit tests never load), then drives the binary in a PTY against the stubs.

Fix the underlying problem each time. Don't skip or weaken a test, loosen a lint rule, or add a type cast to get green; if one of those is truly the right call, say so and why.

Done when all four pass in one run (`bun run check` runs them in order). Report what you changed to get there.

`bun run check` is close to CI but not the same. CI (`.github/workflows/ci.yml`) installs with `bun install --frozen-lockfile --os='*' --cpu='*'` (every platform's OpenTUI package), runs `bun run coverage` in place of `test:unit`, and ends with `bun run build:all`, which cross-compiles every release target. When the build script, the native-lib plugin, or dependencies changed, run those two as well (`build:all` needs that install first).

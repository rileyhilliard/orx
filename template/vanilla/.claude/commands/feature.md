---
description: Take a feature from idea to PR - RFC, adversarial review, worktree execution with subagents, two code reviews, PR
argument-hint: <what to build>
---

Build this feature the way this repo builds features: $ARGUMENTS

The `ce:` skills and agents below come from the claude-essentials plugin. Without it, use the in-repo equivalents: the `architect` agent in place of `ce:devils-advocate`, the `reviewer` agent in place of `ce:code-reviewer`, and your own judgment in place of the skills.

Working in the worktree:
- Run `bun install` there first; a worktree has no `node_modules/` (and without it, OpenTUI's native package for this host is missing too).
- It has no `.env`, so no key, which is how to check the no-key paths (exit 3). For a keyed run, pass the main checkout's file without reading it: `bun --env-file=<main checkout>/.env src/bin.ts ask "hi"`.
- There is no dev server to share. To drive the CLI, run `bun run stub` in the worktree, export the env it prints, and use `bun run orx -- <args>` there; `logs/` (the stub's pid file, `orx.jsonl`, `orx.log`) is per checkout. `bun run stub:stop` when done. If the stub can't bind its ports because the main checkout's stub is running, export the env the main checkout's `bun run stub` prints instead of stopping the user's.
- `bun run e2e` and `bun run build:all` write `dist/` and start their own stubs: only the orchestrator runs them. Subagents run scoped tests (`bun run test:unit <file>`, `bun test ./tests/tui/<file>`), lint, and typecheck, and don't commit.

1. **Plan.** Read what the feature touches, then write `docs/rfcs/NNNN-<slug>.md` (next free number) with these sections: Why, Scope (in and out), Design (per item: the change, the files, the tests; for a command, its argv, stdout, `--json` shape, and exit codes), Work breakdown (groups of related work with the files each owns, and which groups depend on which), Verification (the gate plus what to run by hand), Review notes. Ask the user only about decisions that are theirs to make.

2. **Challenge the plan.** Dispatch `ce:devils-advocate` on the RFC. Tell it which claims about the code to verify and which designs you're least sure of. Fold every real finding into the RFC and summarize them under Review notes.

3. **Execute.** Create a worktree on `feat/<slug>` from `main` and commit the RFC there first. Follow the `ce:executing-plans` skill with one change: the output is a PR, not a merge to `main`. Dispatch one subagent per group from the Work breakdown, in parallel where groups don't depend on each other, and give each one the RFC section it owns and the files it may touch. Commit each group separately with a Conventional Commit message once you've read its diff.

4. **Verify.** Run `bun run check` and read the counts from both test runners. Then run the change by hand the way the RFC's Verification section says (the stub and `bun run orx` in the worktree; `bun run tui:capture` for TUI changes).

5. **Review.** Dispatch two `ce:code-reviewer` agents in parallel on `git diff main...HEAD`:
   - Product and design: what a user types and sees, help text and messages, `--json` shape, exit codes, TUI states and keybindings, and whether it follows `DESIGN.md`.
   - Technical architecture: the platform boundary, the stdout contract, error handling, tests, and the checklist in `.claude/agents/reviewer.md`.

   Fix every finding or write down why it doesn't apply, then run `bun run check` again.

6. **Open the PR.** Load the `ce:writer` skill (Contributor persona) and write the description from `.github/pull_request_template.md`. Write it for a reviewer who has never seen this repo: explain in plain words what the feature is and why it exists before any technical detail, then what landed, where to look closely, and how to try it by hand. Be complete, and cut anything a reviewer wouldn't miss. Push the branch and run `gh pr create --body-file <file>`. If the repo has no remote, stop there and give the user the branch name and the description file.

Report the PR link (or the branch and description file), the commits, and any finding you chose not to fix.

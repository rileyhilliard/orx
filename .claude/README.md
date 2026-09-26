# `.claude/`: Claude Code config

```
settings.json        shared config: hooks wiring, allow rules for the safe scripts, destructive-command deny rules
settings.local.json  your machine-only overrides (gitignored, create as needed)
hooks/               TypeScript hooks run by bun, described below
rules/src/           path-scoped guidance, loaded when a rule's `paths:` globs match
commands/            slash commands: /check, /test, /add-command, /add-service, /add-tool, /feature
skills/              symlinks to agent-neutral skills in .agents/skills/ (effect, opentui, tui-design-slop)
agents/              subagents: architect (read-only design), reviewer (read-only review)
```

Project instructions live in `AGENTS.md` at the repo root, which every coding agent reads. The root `CLAUDE.md` imports it and adds only Claude-specific notes, so edit `AGENTS.md` for anything that isn't Claude-specific. `docs/harness.md` explains how these pieces fit together, for people.

`/feature <what to build>` is the end-to-end workflow: an RFC in `docs/rfcs/`, an adversarial review of it, execution in a worktree with one subagent per work group, the gate, two code reviews, and a PR. It uses skills and agents from the claude-essentials plugin and names in-repo fallbacks when that isn't installed.

## Hooks

| Hook | Event | What it does |
| --- | --- | --- |
| `session-start.ts` | SessionStart | Adds branch, dirty-file count, a warning on `main` (off with `git config orx.allowMain true`), a missing `.env`, uninstalled dependencies (with the install command), a bun that doesn't match `packageManager` (ask before `bun upgrade`), a missing OpenTUI native package for this OS and CPU, the stub servers already running from this checkout (from `logs/stub.pid`), and the count of warn/error lines in `logs/orx.jsonl`. |
| `block-destructive.ts` | PreToolUse `Bash` | Denies commands that destroy work or data: `rm` of `/`, `~` or `.`, discarding uncommitted work (`git reset --hard`, `checkout .`, `restore .`, `clean -f`) when git reports something to lose, force push (`--force-with-lease` is allowed), stash drop, `DROP TABLE`, deleting Docker volumes, `find -delete` from `/`, `~`, or unfiltered from `.`, publishing a release. The agent sees the reason and asks you instead. Ordinary work passes: `checkout .` or `clean -fd` on a clean tree (a plain `git reset --hard` is still refused by `permissions.deny`, below), `killall`, pruning Docker images, `find . -name __pycache__ -exec rm -rf {} +`. |
| `detect-secrets.ts` | PreToolUse `Edit\|Write` | Denies writes containing credential-shaped strings (cloud and SaaS keys, private keys, tokens, connection strings with passwords). |
| `lint-on-write.ts` | PostToolUse `Edit\|Write` | Runs `biome check` on the file just written (JS/TS, JSON, CSS), including the Grit rules in `biome-plugins/`, and hands diagnostics back to the agent. Also records the path for `format-changed.ts`. |
| `typecheck-on-write.ts` | PostToolUse `Edit\|Write` | After a `.ts`/`.tsx` write (not under `node_modules/`, `dist/`, or `coverage/`), runs `tsc` incrementally (build info in `node_modules/.cache/tsc/`) and hands back up to 40 lines of type errors, the written file's first. Errors in other files are included because an edit can break its callers. |
| `format-changed.ts` | Stop | Formats the files this session wrote with `biome check --write`, then forgets them. `lint-on-write.ts` records each path written through Edit/Write in a per-session list under `$TMPDIR/orx-hooks/`, keyed by the session id. Files you or other agents in the same checkout are editing aren't touched; no session id means nothing is formatted. |
| `guard-commands.ts` | PreToolUse `Bash` | Denies installing with npm, pnpm, or yarn (bun is the package manager); `--bun` on vitest (it runs on Node); vitest on `tests/tui` (OpenTUI's test renderer needs Bun); `bun test` except on `./tests/tui` or `./e2e` paths (a bare `bun test` collects the vitest files too); `bun run test` with arguments (it runs both suites; use `test:unit` or `test:tui`); and installing packages this repo doesn't use (`zod`, `@effect/schema`, `@effect/platform`, `ink`, `@modelcontextprotocol/sdk`), each with what to use instead. |
| `guard-generated.ts` | PreToolUse `Edit\|Write` | Denies hand edits to generated files: `dist/` (`bun run build`), `coverage/`, `bun.lock`, and `tests/fixtures/openrouter/` (`bun run record:openrouter`). |
| `guard-boundaries.ts` | PreToolUse `Edit\|Write` | Denies writes under `src/` that cross the platform boundary (`cli.md`): a Bun, `@effect/platform-bun`, or `@opentui/*` import or a `Bun.` global outside `src/bin.ts` and `src/tui/`; `process.env` outside `src/config.ts` and `src/bin.ts`; `console.*` anywhere in `src/`; `zod` or `@effect/schema`; and an `effect` import under `src/tui/` other than `launch.tsx`. Comments don't count. The Grit rules catch the same things at lint time; this hook stops them before the write. |
| `_destructive-patterns.ts` | (imported) | `findings(command)` / `isDestructive(command)`, the rules behind `block-destructive.ts`. Reuse it from any hook that approves or rewrites Bash commands. |
| `_shell.ts` | (imported) | `commands(line)`: a small shell lexer that splits a command line into the simple commands bash would run, quotes removed, following `bash -c`, `$( )`, heredocs fed to a shell, `ssh`, `xargs`, `docker exec`, and wrappers like `sudo`. The Bash guards match command words and arguments from it, so commit messages, heredocs fed to other programs, quoted strings, and comments don't trip them. |
| `_lib.ts` | (imported) | Shared helpers: payload reading, project root, `findUp`, `run` with a timeout that kills the process group, the per-session file list, the deny and context output. |

How they behave:

- **Quiet when there's nothing to do.** A hook whose tool isn't installed, or that gets a payload it can't parse, exits 0 with no output. The worst destructive commands are also in `permissions.deny` in `settings.json`, so they stay blocked if a hook can't run.
- **Guards deny; everything else advises.** `block-destructive.ts`, `detect-secrets.ts`, and the three `guard-*.ts` hooks block; nothing else does. Lint and type errors arrive as context and never block a write.
- **Nothing is downloaded.** Biome and tsc run only from the project's own `node_modules/.bin` (or biome from PATH). The hooks never call `npx` or `bunx`, which could fetch packages mid-session.
- **Timeouts everywhere.** Each external call runs under a timeout, so a stuck linter can't stall the session.
- Hooks are invoked as `bun "${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>.ts"`, so they don't need the executable bit. They use only `node:` APIs, and `tsconfig.json` includes `.claude/hooks/`, so `bun run typecheck` and `bun run lint` cover them like any other source.

To try a hook by hand, pipe it a payload:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"bun test"}}' | bun .claude/hooks/guard-commands.ts
```

### Changing them

- Add a destructive rule to `check()` in `_destructive-patterns.ts`, not to `block-destructive.ts`. Rules see one command at a time (`argv` without quotes, redirects, heredoc bodies), so match on the command word and its arguments rather than on raw text.
- A new boundary goes in `guard-boundaries.ts` and in `biome-plugins/` together, so the hook and lint agree. A hook that fires on every tool call should cost milliseconds.
- `tests/hooks/` has one test file per hook, each running the hook through the command wired in `settings.json` with a real payload on stdin (`bun run test:unit tests/hooks`); `wiring.test.ts` checks that every hook is wired and that no allow rule is one a guard denies. Add a row for each new pattern: one command or write that must be denied and one near miss that must pass. The block-destructive and guard-commands rows are named after the command; the guards ignore quoted text, so `-t "<name>"` works.

## Rules

Each file in `rules/src/` loads only when the agent touches files matching its `paths:` globs:

| Rule | Loads for |
| --- | --- |
| `effect.md` | `src/`, `tests/`, `scripts/`, `evals/`: the Effect version, load the `effect` skill, the v3 names that slip through |
| `effect-services.md` | services, `core/`, runtime, config, errors, logging, `main.ts`: services and layers, config, tagged errors, retry, logging |
| `cli.md` | `bin.ts`, `main.ts`, `cli.ts`, `commands/`, output and input helpers, errors: the stdout contract, exit codes, flags, the platform boundary |
| `effect-ai.md` | the turn loop, tools, extract, `ask`, `mcp`: who owns the step loop, retry before the first part, tool schemas per provider |
| `openrouter.md` | the provider, models list, chat, replay fixtures, the recorder: routing, usage and cost, the `llm call` log line |
| `tui.md` | `src/tui/`, `commands/chat.ts`, `tests/tui/`, `tui-capture`, `DESIGN.md`: the bridge, terminal and signal ownership, states, TUI tests |
| `distribution.md` | the build script, `install.sh`, `update`, `doctor`, releases, CI workflows, `e2e/`: compiled binaries, native libs, self-update |
| `testing.md` | tests, `e2e/`, and the runner configs: the two runners, no network, where a test goes, required coverage, hook tests |
| `verification.md` | `src/`, `tests/`, `e2e/`, `scripts/`: the done-check |
| `typescript.md` | `.ts`/`.tsx` under `src/`, `tests/`, `scripts/`, `evals/`, `e2e/`, `.claude/hooks/`: TypeScript 7 config facts and the mistakes it doesn't catch |

If you rename or move a file, update the globs so the rule still loads where it applies.

## Settings

`settings.json` is shared and committed. Some keys (permission allow rules, plugin marketplaces) only take effect after each person trusts the folder in Claude Code; deny rules apply right away. Put anything personal (extra permissions, env, personal MCP servers) in `settings.local.json`.

`permissions.allow` covers read-only git (`status`, `diff`, `log`, `show`, `branch --show-current`), the non-destructive bun scripts (lint, format, typecheck, the test scripts, coverage, build, e2e, check, `stub`/`stub:stop`, `tui:capture`, `orx`), `bunx vitest run`, `bun test` on `./tests/tui`, and the built `./dist/orx`. `bun run orx` against a real key spends money: the stub env (`bun run stub`) keeps it free, and the allow rule assumes you use it. `bun run eval`, `bun run record:openrouter`, `bun run clean`, and anything that installs, publishes, or deletes still prompt.

`permissions.deny` repeats the worst destructive shapes (`rm -rf /`, `rm -rf ~`, `rm -rf .`, force push, `git reset --hard`) so they stay blocked if `block-destructive.ts` can't run (bun missing from PATH, a broken edit). They are exact rules on purpose: a wildcard such as `Bash(rm -rf /*)` would match every `rm -rf /some/abs/path`, and a deny rule can't be overridden by an allow rule.

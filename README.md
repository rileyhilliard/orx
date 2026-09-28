# orx

orx is a coding agent for the terminal that runs on any tool-capable OpenRouter model. Bare `orx` opens a Claude Code-style session in the current directory: the model reads, searches, edits, and runs commands behind an approval gate, and every reply shows its tokens and cost. `orx ask` is the headless, pipe-friendly version of the same thing.

It's TypeScript on [Effect 4](https://effect.website) (CLI, Effect AI with `@effect/ai-openrouter`, Schema), with an [OpenTUI](https://github.com/sst/opentui) terminal UI, compiled by [Bun](https://bun.sh) into one self-updating binary.

## Try it in five minutes

You need bun 1.4.2 or newer and git. `rg` (ripgrep) is optional; `grep` falls back to a JS search without it.

```bash
git clone <this repo> orx && cd orx
bun install
```

### Without a key

`bun run stub` starts a local stand-in for OpenRouter that streams a canned reply. Nothing leaves your machine and nothing costs money, so you can see the CLI's contract and the TUI before you spend anything.

```bash
eval "$(bun run --silent stub)"             # points this shell at the stub
bun run orx -- ask "hi"                      # streams "Hello from the stub.", usage on stderr
bun run orx -- ask hi --json | jq -c .       # NDJSON events: text, then done with tokens and cost
bun run orx -- ask --bogus; echo $?          # stdout stays empty, exit 2
bun run orx                                  # the TUI; type a message, Ctrl+C to quit
bun run --silent stub:stop
```

### With a key: the agent on a real task

```bash
cp .env.example .env    # set OPENROUTER_API_KEY; OPENROUTER_MODEL picks the default model
bun run demo            # writes a small TypeScript project into a fresh git repo, prints its path
```

The demo project has a `fmtPrice` function that's used in three files and mentioned in the README. Point the agent at it and ask for a rename:

```bash
bun run orx -- --cwd <path from bun run demo>
```

In the session, type `rename fmtPrice to formatPrice everywhere`. The model greps, reads each file, then proposes edits one at a time. Each approval shows the diff: `y` allows that edit, `a` allows every edit for the rest of the session, and `n` refuses with an optional note for the model. When it's done, the reply line shows the model, tokens in and out, and cost. `git -C <path> diff` shows exactly what changed.

A few more things worth trying in the session:

- Shift+Tab cycles the permission mode (`default`, `acceptEdits`, `plan`). In `plan` mode the model can read but not change anything.
- `@` opens a fuzzy file picker. `@src/cart.ts` attaches that file to your message.
- `/model` switches models mid-chat; `/help` lists every command and key.
- Ask it to run `bun src/receipt.ts`: bash always asks, whatever the mode, except `yolo`.

The same task headless, with no one to ask for approval:

```bash
bun run demo    # a fresh copy
bun run orx -- ask --agent --cwd <path> --permission-mode acceptEdits "rename fmtPrice to formatPrice everywhere"
```

The tool calls go to stderr as they happen, and the answer goes to stdout. With `--json`, stdout carries every event instead. On `z-ai/glm-5.3-flash` this takes about 5 seconds and costs about $0.001.

### What to look at in the code

| Area | Where |
| --- | --- |
| OpenRouter requests: attribution headers, `session_id`, `provider.require_parameters`, fallbacks and routing, Anthropic `cache_control` | `src/services/Llm.ts`, `runTurn` in `src/core/chat.ts` |
| The turn loop: streaming steps, tool calls, retry only before the first token, Retry-After, idle timeout, saving a partial reply on Ctrl+C | `src/core/chat.ts` |
| Mapping OpenRouter errors (402, 403, 404, 429, 503, mid-stream errors) to messages, exit codes, and `retryable` | `src/core/upstream.ts` |
| The models list: caching, tool-support check, `context_length` for context elision | `src/services/OpenRouterModels.ts`, `src/core/context.ts` |
| Token, cache, reasoning, and cost accounting | `src/core/chat.ts` (`llm call` log line), `src/core/format.ts` |
| The agent's tools and the approval gate | `src/tools/`, `src/services/permissions.ts`, `src/services/workspace.ts` |
| Tests against recorded OpenRouter streams | `tests/openrouter-replay.test.ts`, `tests/fixtures/openrouter/` |
| Real-model eval | `evals/`; results in `docs/rfcs/RFC001-bootstrap-agent-harness/phase-1-edits-code.md` |

`AGENTS.md` maps the code and its conventions. `docs/harness.md` covers how coding agents are kept on the rails in this repo (hooks, rules, reviewers). `docs/rfcs/RFC001-bootstrap-agent-harness/` has the roadmap: what phase 1 shipped and what phases 2 and 3 propose.

## Install

After the first release, install the binary with:

```bash
curl -fsSL https://github.com/rileyhilliard/orx/releases/latest/download/install.sh | bash
export OPENROUTER_API_KEY=sk-or-...
orx
```

The installer picks the build for your OS and CPU (macOS and glibc Linux, x64 and arm64), checks it against the release's `SHA256SUMS`, and puts it in `~/.local/bin` (`ORX_INSTALL_DIR` changes that). `orx update` replaces it the same way, and `orx update --check` only reports. From a checkout, `bun run build` makes `dist/orx` for your machine.

## Usage

```bash
orx                                          # the coding agent, in this directory
orx --cwd ~/code/app --model anthropic/claude-sonnet-5.5
orx --resume <id>                            # ids from `orx chats`
orx ask "what's a monad, in one sentence"
git diff | orx ask "review this diff"        # piped stdin is appended to the prompt
orx ask --json "hi" | jq -c .                # NDJSON: text, tool-call, tool-result, permission-denied, note, then done or error
orx ask --agent --permission-mode acceptEdits "fix the failing test"
orx models claude                            # search models; context and price per million tokens
orx chats                                    # saved chats
orx export <id> -o chat.md
orx doctor                                   # version, paths, whether the key is set, config errors (--tui checks the TUI)
```

Every reply is saved as a chat, and its id is printed after the reply on stderr. Results go to stdout and everything else (usage lines, logs, errors) goes to stderr, so a pipe only sees the answer. When stdin isn't a terminal, `ask` reads it to the end, so in a `while read` loop, or under a job runner whose stdin stays open, give it `< /dev/null`.

Plain `orx ask` sends no tools: it's a question and an answer. `--agent` gives it the session's tools.

## The coding agent

The model gets `read`, `glob`, `grep`, `write`, `edit`, and `bash`, plus `skill`, and orx only offers models whose OpenRouter listing says they support tool calling. File tools resolve every path inside the workspace (symlinks included) and refuse anything outside it. `bash` runs in the workspace with the API key scrubbed from its environment, but it isn't sandboxed: an approved command can touch anything your user can. For that reason orx won't start in your home directory or `/` unless `--cwd` names it explicitly.

What runs without asking depends on the permission mode:

| Mode | Reads | Writes and edits | bash |
|---|---|---|---|
| `default` | allowed | ask | ask |
| `acceptEdits` | allowed | allowed, except protected paths | ask |
| `plan` | allowed | denied | denied |
| `yolo` | allowed | allowed | allowed |

Shift+Tab or `/mode` switches between the first three. `--dangerously-skip-permissions` starts in `yolo`.

Two kinds of path always ask, in every mode except `yolo`:

- **Secret-shaped files.** `.env*`, `*.pem`, `*.key`, and `id_*` ask before they're read or written. `@` won't attach them, and `grep` never searches them; it tells the model how many it skipped.
- **Protected paths.** These ask before a write even in `acceptEdits`, because a later approved command would run or load them: anything under `.git/`, `.orx/commands/`, or `.orx/skills/`, plus any `package.json`, `lefthook.yml`, `AGENTS.md`, or `CLAUDE.md`. The comparison ignores case (on macOS, `.GIT/config` is `.git/config`).

"Always" isn't offered for compound shell commands (`;`, `&&`, pipes, redirects, substitution) or for secret and protected paths.

`orx ask --agent` has no one to ask, so anything that would ask is denied, and the model sees why. `--permission-mode` sets what may run; its default, `default`, denies every write, edit, and command. With `--json`, a denied call emits `{"type":"permission-denied","id","tool","message"}` just before that call's `tool-result`.

The session also supports these:

- **Memory.** The system prompt includes `~/.config/orx/AGENTS.md`, then the `AGENTS.md` of each directory from the git root down to the workspace, capped at 32 KiB. `CLAUDE.md` is used where a directory has no `AGENTS.md`.
- **Slash commands.** `/` lists the built-ins (`/help`, `/clear`, `/model`, `/mode`, `/export`, `/quit`), your custom commands, and your skills.
  - A custom command is a Markdown file in `.orx/commands/` or `~/.config/orx/commands/`. `/name args` sends its body with `$ARGUMENTS` filled in. A `model:` line in its frontmatter runs that turn on a different model.
  - A skill is a directory in `.orx/skills/` or `~/.config/orx/skills/` containing a `SKILL.md` with `name` and `description` in its frontmatter. The description goes in the system prompt, and the model loads the body with the `skill` tool when it needs it.
  - When a name exists in both places, the workspace's version wins.
- **`@` mentions.** Each `@path` in a message attaches that file (with line numbers, up to the first 2000 lines) or that directory's listing. The chat and its exports show only what you typed.
- **Context.** When a long chat nears the model's context window, old tool outputs and older attachments are replaced by one-line stubs.

Chats remember their workspace. Running `--resume` from a different directory exits 2 and names the chat's directory; pass `--cwd` explicitly to continue it somewhere else.

## Configuration

Environment variables win over the optional config file at `~/.config/orx/config.json` (or `$XDG_CONFIG_HOME/orx/config.json`). The file takes these keys: `model`, `systemPrompt`, `fallbackModels`, `providerSort`, `allowFallbacks`, `dataCollection`, `zdr`, `maxOutputTokens`, `maxToolSteps`, and `maxStreamSeconds`. An unknown key is an error, and the API key can't go in the file.

| Variable | What it does |
|---|---|
| `OPENROUTER_API_KEY` | Required for anything that calls a model; without it, those commands exit 3. Set a credit limit on the key at openrouter.ai. |
| `OPENROUTER_MODEL` | The default model (`openai/gpt-6-luna`). `--model` overrides it per run, and variants like `:online` work. |
| `OPENROUTER_BASE_URL` | OpenRouter's API base (default `https://openrouter.ai/api/v1`). The dev stub sets it. |
| `SYSTEM_PROMPT` | Replaces the default system prompt. In the agent session it replaces the base instructions; the environment block and `AGENTS.md` memory still follow. |
| `OPENROUTER_FALLBACK_MODELS` | Comma-separated model ids OpenRouter tries if the main one fails. |
| `OPENROUTER_PROVIDER_SORT` | `price`, `throughput`, or `latency`. Empty lets OpenRouter choose. |
| `OPENROUTER_ALLOW_FALLBACKS` | Whether OpenRouter may use other providers for the same model (default `true`). |
| `OPENROUTER_DATA_COLLECTION` / `OPENROUTER_ZDR` | `deny` routes only to providers that don't store prompts; `true` routes only to providers with zero data retention. |
| `MAX_OUTPUT_TOKENS` | Reply length (default 8192). OpenRouter checks your credit against the input plus `max_tokens` before the call, so lower this if you get a 402 "can only afford" error. |
| `MAX_TOOL_STEPS` | Model steps per turn (default 50). Hitting it ends the turn with a note. |
| `MAX_STREAM_SECONDS` | How long a reply may go without a chunk from the model (default 120). Time spent running tools doesn't count. |
| `LOG_LEVEL`, `ORX_LOG_FORMAT`, `ORX_LOG_FILE` | The log level (`warn` by default; `--log-level` sets it per run), `pretty` or `json` on stderr, and a file that JSON lines are also appended to. `NO_COLOR=1` turns color off and `FORCE_COLOR=1` forces it on. |
| `ORX_DATA_DIR` | Where chats are saved (default `$XDG_DATA_HOME/orx`, else `~/.local/share/orx`). |
| `ORX_RELEASES_REPO`, `ORX_RELEASES_URL` | Where `orx update` looks for releases (default `rileyhilliard/orx` on `https://api.github.com`). |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, including `--help` and quitting the session |
| 1 | A bug in orx (the log has the details) |
| 2 | Bad usage or input: an unknown flag, an empty prompt, an unknown model, a model without tool calling for the agent, an unknown chat id, bare `orx` without a terminal, or `--resume` from another workspace |
| 3 | Not configured: no API key, a bad env var or config file value (the message names it), or the terminal UI can't load here |
| 4 | OpenRouter or GitHub failed or timed out. `retryable` in the `--json` error says whether trying again can help |
| 6 | Permission denied writing a file: `orx update` into a directory you don't own, or a chat into a data dir you can't write |
| 130 | Interrupted (Ctrl+C during `ask`) |

Code 5 is retired: it belonged to a structured-output command that has been removed. With `--json`, errors are `{"error":{"tag","message","retryable"}}` on stderr.

## Logs

Each run logs one `command` line (the command, flag names, exit code, and duration). Each model turn logs one `llm call` line: requested and served model, tokens (including cache reads and writes, and reasoning tokens), cost, finish reason, steps, and time to first token. Both are logged at `info`, which the default level (`warn`) hides. `orx --log-level info ask hi` shows them for one run, and `ORX_LOG_FILE=~/orx.jsonl` keeps them. Prompts, replies, and the key are never logged.

## Development

The main commands:

| Command | What it does |
|---|---|
| `bun run orx -- <args>` | Runs orx from source, logging at `info` to the terminal, `logs/orx.jsonl`, and `logs/orx.log`. Chats go in `.orx/data` |
| `bun run stub` / `stub:stop` | Starts or stops the stub OpenRouter and stub GitHub releases on local ports; `stub` prints the env that points orx at them |
| `bun run demo [dir]` | Creates the demo project in a fresh git repo (a temp dir if you don't name one) |
| `bun run tui:capture -- --keys "hi<enter>"` | Runs orx in a pseudo-terminal, types the keys, and prints the screen as text |
| `bun run lint` / `format` / `typecheck` | Biome check / Biome fixes / tsc |
| `bun run test` | Every test under `tests/` (unit and TUI) with `bun test`; no network |
| `bun run e2e` | Builds `dist/orx` and tests the binary, including the TUI in a PTY |
| `bun run check` | The gate: lint, typecheck, test, and e2e. CI also runs `coverage` and `build:all` |
| `bun run coverage` | The same tests, with a coverage report in `coverage/` |
| `bun run eval --models a,b` | The coding eval against real models (needs a key; about $0.001 per model per case) |
| `bun run record:openrouter` | Re-records `tests/fixtures/openrouter/` from real OpenRouter streams (needs a key) |
| `bun run build` / `build:all` | `dist/orx` for this machine / every release target plus `SHA256SUMS` |
| `bun run clean` | Removes `dist/`, `coverage/`, and `logs/`. Dev chats in `.orx/` stay |

`bun test ./tests/<file>` runs one file. Tests never touch the network or your real config: a preload points everything at unreachable URLs and a temp HOME, and model calls go to the stub or to recorded OpenRouter streams.

To release, bump `version` in `package.json`, commit, and push a matching `v*` tag.

## License

Copyright (c) 2026 Riley Hilliard

# Reference

Configuration, machine-readable output, exit codes, and logs.

## Configuration

Environment variables win over the optional config file at `~/.config/orx/config.json` (or `$XDG_CONFIG_HOME/orx/config.json`). The file takes these keys: `model`, `systemPrompt`, `fallbackModels`, `providerSort`, `allowFallbacks`, `dataCollection`, `zdr`, `maxOutputTokens`, `maxToolSteps`, and `maxStreamSeconds`. An unknown key is an error, and the API key can't go in the file.

| Variable | What it does |
|---|---|
| `OPENROUTER_API_KEY` | Required for anything that calls a model; without it, those commands exit 3. Set a credit limit on the key at openrouter.ai. |
| `OPENROUTER_MODEL` | The default model (`z-ai/glm-5.3-flash`). `--model` overrides it per run, and variants like `:online` work. |
| `OPENROUTER_BASE_URL` | OpenRouter's API base (default `https://openrouter.ai/api/v1`). The dev stub sets it. |
| `SYSTEM_PROMPT` | Replaces the default system prompt. In the agent session it replaces the base instructions; the environment block and `AGENTS.md` memory still follow. |
| `OPENROUTER_FALLBACK_MODELS` | Comma-separated model ids OpenRouter tries if the main one fails. None by default; `.env.example` sets `openai/gpt-6-luna,deepseek/deepseek-v4-flash`. |
| `OPENROUTER_PROVIDER_SORT` | `price`, `throughput`, or `latency`. Empty lets OpenRouter choose. |
| `OPENROUTER_ALLOW_FALLBACKS` | Whether OpenRouter may use other providers for the same model (default `true`). |
| `OPENROUTER_DATA_COLLECTION` / `OPENROUTER_ZDR` | `deny` routes only to providers that don't store prompts; `true` routes only to providers with zero data retention. |
| `MAX_OUTPUT_TOKENS` | Reply length (default 8192). OpenRouter checks your credit against the input plus `max_tokens` before the call, so lower this if you get a 402 "can only afford" error. |
| `MAX_TOOL_STEPS` | Model steps per turn (default 50). Hitting it ends the turn with a note. |
| `MAX_STREAM_SECONDS` | How long a reply may go without a chunk from the model (default 120). Time spent running tools doesn't count. |
| `LOG_LEVEL`, `ORX_LOG_FORMAT`, `ORX_LOG_FILE` | The log level (`warn` by default; `--log-level` sets it per run), `pretty` or `json` on stderr, and a file that JSON lines are also appended to. `NO_COLOR=1` turns color off and `FORCE_COLOR=1` forces it on. |
| `ORX_DATA_DIR` | Where chats are saved (default `$XDG_DATA_HOME/orx`, else `~/.local/share/orx`). |
| `ORX_RELEASES_REPO`, `ORX_RELEASES_URL` | Where `orx update` looks for releases (default `rileyhilliard/orx` on `https://api.github.com`). |

## Output

Results go to stdout and everything else (usage lines, logs, errors) goes to stderr, so a pipe only sees the answer. Every reply is saved as a chat, and its id is printed after the reply on stderr. When stdin isn't a terminal, `ask` reads it to the end and appends it to the prompt, so in a `while read` loop, or under a job runner whose stdin stays open, give it `< /dev/null`.

`orx ask --json` writes NDJSON events to stdout: `text`, `tool-call`, `tool-result`, `permission-denied`, and `note` as they happen, then one `done` (with tokens and cost) or `error`. With `--json`, any command's error is `{"error":{"tag","message","retryable"}}` on stderr.

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

Code 5 is retired: it belonged to a structured-output command that has been removed.

## Logs

Each run logs one `command` line (the command, flag names, exit code, and duration). Each model turn logs one `llm call` line: requested and served model, tokens (including cache reads and writes, and reasoning tokens), cost, finish reason, steps, and time to first token. Both are logged at `info`, which the default level (`warn`) hides. `orx --log-level info ask hi` shows them for one run, and `ORX_LOG_FILE=~/orx.jsonl` keeps them. Prompts, replies, and the key are never logged.

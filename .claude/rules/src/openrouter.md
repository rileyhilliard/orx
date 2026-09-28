---
paths:
  - "src/services/Llm.ts"
  - "src/services/OpenRouterModels.ts"
  - "src/core/models.ts"
  - "src/core/chat.ts"
  - "src/core/upstream.ts"
  - "src/commands/models.ts"
  - "tests/fixtures/openrouter/**"
  - "scripts/record-openrouter.ts"
---

# OpenRouter

## Request settings

`openRouterSettings(config)` in `src/services/Llm.ts` builds them from Config and nothing else sets them. They go in every chat request body through `OpenRouterLanguageModel.make({ model, config })`:

- **Fallback models**: OpenRouter's `models` array (`OPENROUTER_FALLBACK_MODELS`), tried in order when the primary fails.
- **Provider routing**: `provider.sort` (price, throughput, latency), `allow_fallbacks`, `data_collection`, `zdr`.
- **Output cap**: `max_tokens` from `MAX_OUTPUT_TOKENS`.

Per turn, `runTurn` provides `OpenRouterLanguageModel.Config` over those: `session_id` (the chat id, for sticky routing and cache hits) and, for Anthropic ids (`/^~?anthropic\//`), top-level `cache_control: { type: "ephemeral" }`, which puts a breakpoint on the last cacheable block so it advances through a tool loop. `withCacheBreakpoints` (`core/context.ts`) keeps explicit ones on the system prompt and the last user message.

Usage and cost are always returned in the final SSE chunk (https://openrouter.ai/docs/guides/guides/usage-accounting), so no `usage: { include: true }` is needed; the provider puts them in each step's finish metadata (`metadata.openrouter.usage.cost`). Tests point the real provider at the stub OpenRouter and assert on the request body it received (`stub.chatRequests`, as in `tests/config.test.ts`). Give each new setting such a case, so a renamed option shows up as a failing test, not a silent no-op.

The client (`OpenRouterClient.make({ apiKey, apiUrl, ...attribution })`, with the app attribution headers from https://openrouter.ai/docs/app-attribution: `HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories: cli-agent`) is built once per process, on first use, because it needs the key and `--help` doesn't. No key is `NotConfigured` (exit 3) from `Llm.languageModel`, not from building the layer.

## Models list

- `OpenRouterModels.list` is `GET {OPENROUTER_BASE_URL}/models?output_modalities=text` over Effect's `HttpClient` (no key needed), decoded with a wire schema (a trust boundary), cached in a `Ref` for 10 minutes, with Effect retry and timeout.
- When the list can't be fetched, `listModels` reports `available: false` and commands fall back to the configured default model. A requested model that isn't in the list is `UnknownModel` (exit 2); `OPENROUTER_MODEL` applies only when no model was given.

## What to record per turn

One `llm call` log line from `finalize` in `runTurn`: requested model, served model and provider, finish reason, input and output tokens, cache read and write tokens, reasoning tokens, cost (summed across steps), tool count, `aborted` (the user stopped it), `errorTag` (`Defect` for a bug), time to first token, duration. Never the prompt or reply text, never the key.

## Recorded fixtures

`tests/fixtures/openrouter/` holds real OpenRouter SSE bodies (`*.sse`) and `meta.json`, replayed through the real provider by the stub. Don't hand-edit them (a hook denies it); re-record with `bun run record:openrouter` (needs a key, costs a little) after upgrading `effect` or `@effect/ai-openrouter`. The replay test reads expected values from the fixtures, so it needs no edits after a re-record.

## No key

`OPENROUTER_API_KEY` is optional. Without it, `orx --help`, `--version`, `models`, `chats`, `export`, `doctor`, and `update` work; `ask`, `extract`, the session (bare `orx`, which exits 3 before the TUI starts), and the model-backed MCP tools fail with `NotConfigured`. The test env has an empty key; `runCli` passes a dummy one, so pass `env: { OPENROUTER_API_KEY: "" }` to test the not-configured path.

To drive the real CLI with no key and no spend, `bun run stub` starts the stub OpenRouter and stub releases servers and prints the env to export; `bun run stub:stop` stops them.

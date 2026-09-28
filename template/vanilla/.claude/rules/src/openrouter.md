---
paths:
  - "src/services/Llm.ts"
  - "src/core/ask.ts"
  - "src/core/upstream.ts"
  - "src/commands/ask.ts"
  - "tests/helpers/stub-openrouter.ts"
---

# OpenRouter

## Request settings

`openRouterSettings(config)` in `src/services/Llm.ts` builds them from Config and nothing else sets them. They go in every request body through `OpenRouterLanguageModel.make({ model, config })`. Today that's only the output cap, `max_tokens` from `MAX_OUTPUT_TOKENS`. OpenRouter's routing options (`models` for fallbacks, `provider` for sort, fallbacks, and data policy) go here too when a command needs them, each with its env var in `config.ts` (`AGENTS.md`, Conventions).

There is no `usage: { include: true }` equivalent in the Effect provider; cost arrives in the finish part's metadata (`metadata.openrouter.usage.cost`). Tests point the real provider at the stub OpenRouter and can assert on the request body it received (`stub.chatRequests`). Give each new setting such a case, so a renamed option shows up as a failing test, not a silent no-op.

The client (`OpenRouterClient.make({ apiKey, apiUrl, siteTitle })`) is built once per process, on first use, because it needs the key and `--help` doesn't. No key is `NotConfigured` (exit 3) from `Llm.ready` or `Llm.languageModel`, not from building the layer.

## Models

A model id is whatever the user passes to `--model` or sets in `OPENROUTER_MODEL`; nothing checks it against OpenRouter's list first. An id with no endpoints comes back as a 404, which `toUpstreamError` turns into a non-retryable `UpstreamUnavailable` (exit 4). The stub still serves `GET /models` if you add a command that lists or validates models; decode that response with a wire schema (a trust boundary) and put Effect retry and a timeout around it.

## What to record per call

One `llm call` log line per model call: requested model, served model, finish reason, input and output tokens, cost (summed across steps if a call has several), and `errorTag`/`errorDetail` when it failed. Never the prompt or reply text, never the key.

## Stub drift

The stub is hand-written, so nothing checks that it still matches OpenRouter's real responses. After upgrading `effect` or `@effect/ai-openrouter`, run `bun run orx -- ask hi --json` once with a real key and check that text, tokens, and cost still arrive.

## No key

`OPENROUTER_API_KEY` is optional. Without it, `orx --help`, `--version`, `doctor`, and `update` work; `ask` fails with `NotConfigured` (exit 3) before reading stdin, and `ui` opens but shows the `NotConfigured` message in place of each reply. The test env has an empty key; `runCli` passes a dummy one, so pass `env: { OPENROUTER_API_KEY: "" }` to test the not-configured path.

To drive the real CLI with no key and no spend, `bun run stub` starts the stub OpenRouter and stub releases servers and prints the env to export; `bun run stub:stop` stops them.

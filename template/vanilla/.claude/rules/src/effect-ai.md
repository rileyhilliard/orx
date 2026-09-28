---
paths:
  - "src/core/ask.ts"
  - "src/core/upstream.ts"
  - "src/services/Llm.ts"
  - "src/schemas/ask.ts"
  - "src/commands/ask.ts"
---

# Effect AI: model calls

The model layer is Effect AI (`LanguageModel`, `Tool`, `Toolkit`, `Prompt`, `AiError` from `effect/unstable/ai`) with `@effect/ai-openrouter` as the provider. Read the installed `.d.ts` before writing against it (`node_modules/effect/dist/unstable/ai/*.d.ts`, `node_modules/@effect/ai-openrouter/dist/*.d.ts`); the `effect` skill has the verified shapes. Vercel AI SDK names (`streamText` options, `maxSteps`, `tool({ inputSchema })`, `useChat`) don't apply here.

## The example call

- `ask` in `src/core/ask.ts` is one non-streaming `LanguageModel.generateText({ prompt })`, with the model from `Llm.languageModel(id)` provided by `Effect.provideService(LanguageModel.LanguageModel, model)`. Around it, in this order: `Effect.mapError(toUpstreamError)`, `Effect.timeoutOrElse` (60 seconds, failing with `timedOut(...)`), and `Effect.retry` with `askRetrySchedule` while `error.retryable`. That's the one retry layer; the HTTP client has none of its own.
- Usage comes from `response.usage`, the served model from the `response-metadata` part, and OpenRouter's cost from the `finish` part's `metadata.openrouter.usage.cost` (`readCost`). The result is an `AskResult` (`src/schemas/ask.ts`), which is also the `--json` contract.
- Each call logs one `llm call` line: at `info` on success (requested and served model, tokens, cost, finish reason), at `warn` with `errorTag` and `errorDetail` when it fails. Never the prompt or reply text.
- Upstream failures are `AiError`s: map them once with `toUpstreamError` (`src/core/upstream.ts`), which decides the message and `retryable` by `error.reason._tag` (`AuthenticationError`, `ContentPolicyError`, and `InvalidRequestError` not retryable; `RateLimitError`, `QuotaExhaustedError`, and everything else retryable). For a rejected request (`InvalidRequestError` that isn't a 404 or a context-length error) the message includes OpenRouter's reason, capped at 200 characters, because that reason is what the user needs to fix the request. Never show a raw stack, response body, or headers; `detail` (`upstreamDetail`) carries the status and reason for logs.

## Adding streaming or tools

There is no streaming or tool code in the tree now. What to know before writing it:

- `LanguageModel.streamText({ prompt, toolkit })` resolves the tool calls of one model step (the stream emits `tool-call` and `tool-result` parts) and stops. It has no step loop: when a step finishes with `"tool-calls"`, append its parts (`Prompt.concat(prompt, Prompt.fromResponseParts(parts))`) and prompt again, up to a step cap. Sum usage and cost across steps, from each step's `finish` part.
- Retry only before the first part. Once text reached the user, a retry would repeat it. Track "something was emitted" in a flag checked inside `Stream.catchIf`; `Stream.retry` re-runs the stream from the start, duplicates output, and ignores the flag.
- A stream-duration cap is `Stream.interruptWhen(Effect.sleep(d).pipe(Effect.andThen(Effect.fail(timedOut(...)))))`; a bare `Stream.timeout` ends the stream without an error.
- `Stream.onExit` runs once however the stream ends (done, failed, Ctrl+C, the consumer stopping early): log the `llm call` line and save state there, nowhere else. A consumer that stops early (`iterator.return()` from the TUI) ends the stream with a `Success` exit, so "didn't finish" has to come from whether the final part was produced, not from the exit tag.
- A tool is `Tool.make(name, { description, parameters, success, failure?, failureMode? })` with Effect Schemas, grouped in a `Toolkit` and implemented with `toolkit.toLayer({ name: handler })`. Handlers get services from the context (`Clock`), so tests control them. `failureMode: "return"` sends a failure back to the model as the result so it can correct itself; without it, a failure fails the call.
- The JSON Schema a provider sees comes from `Tool.getJsonSchema(tool)`: objects are open (`additionalProperties: true`), and `Tool.Strict` only sets the request's `strict` flag; an `identifier` annotation on the parameters produces a top-level `$ref` into `$defs`; descriptions and examples come from annotations on the schema before any `.check(...)`. `@effect/ai-openrouter` then rewrites the schema by model id: `openai/*` (and `gpt-`, `o1-`, `o3-`, `o4-`) and `anthropic/*` (and `claude-`) get objects closed and `examples` dropped; other models get the open schema. A description must carry what an example would. Print `Tool.getJsonSchema(tool)` before a model sees a new tool, then pin it in a test.
- Structured output is `LanguageModel.generateObject({ prompt, schema, objectName })`. Decode `response.value` with the same schema again: model output is a trust boundary. A bad object needs its own tagged error and exit code (5 is free).

## Tests

Tests run the real provider against the stub OpenRouter (`tests/helpers/stub-openrouter.ts`) through `runCli` with `OPENROUTER_BASE_URL` pointed at it. There is no scripted `LanguageModel`: script the stub instead. It serves a fixed `completion` (text, model, usage, cost) streamed or not, `failCompletions` (an error status, optionally for the first `times` requests), `hangAfter`, `dropAfter`, and `toolCalls` (a queue of `{ name, arguments }`, one per request); `stub.chatRequests` holds the request bodies it received. `ask` is covered in `tests/cli-contract.test.ts`: reply and usage line, piped stdin, `--model` in the request, `--json`, the `llm call` line, retry then exit 4, a retry that recovers, and no retry for a rejected key. A new model call gets the same set, plus each `AiError` reason's exit code and `retryable` if it maps errors differently.

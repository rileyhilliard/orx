---
name: effect
description: Effect 4 (effect-ts, 4.0.0-rc) guidance for orx. Use before writing or changing Effect code (services, layers, errors, Schema, Config, logging, streams, the CLI framework in effect/unstable/cli, Effect AI and @effect/ai-openrouter, MCP, @effect/platform-bun, Effect code in bun tests) and before looking up Effect docs, because most training data, blog posts, and some doc indexes show Effect 3 APIs that no longer exist.
---

# Effect 4 in orx

The repo is on `effect`, `@effect/platform-bun`, and `@effect/ai-openrouter` 4.0.0-rc.117, all pinned exactly because RC releases still break APIs (plus an `overrides` pin on `@effect/platform-node-shared`, which `@effect/platform-bun` depends on with a caret range); bump them together. Tests run on `bun test`; there is no `@effect/vitest`. Repo conventions (`Context.Service` with a static `layer`, `AppLayer`, thin commands, the stdout contract, exit codes) are in `.claude/rules/src/` and `AGENTS.md`; this file is the Effect knowledge behind them.

Everything below was checked against the installed rc.117 (run in this repo or read from its `.d.ts`), except lines marked "(docs)", which come from the Effect docs only.

## Looking things up

- The installed truth: `node_modules/effect/dist/<Module>.d.ts` (and `dist/unstable/cli/`, `dist/unstable/ai/`, `dist/unstable/http/`, `dist/testing/**`), `node_modules/@effect/ai-openrouter/dist/*.d.ts`, `node_modules/@effect/platform-bun/dist/*.d.ts`. When a doc and the `.d.ts` disagree, the `.d.ts` wins; the `.js` next to it answers what a function does at runtime. A throwaway `bun ./probe.ts` from the repo root (delete it after) answers most questions in seconds.
- Context7: `/websites/effect_website_v4_api`. Don't use `/effect-ts/effect-smol`: effect-smol was archived at beta.98 and its index shows names that were renamed since (`Schema.TaggedErrorClass`, `TestClock` from `"effect"`, `Logger.pretty`, JSON Schema `additionalProperties: false` by default). `/effect-ts/effect/__branch__v3` and effect.website `/docs/v3/...` are Effect 3.
- GitHub: `Effect-TS/effect` main is v4: `LLMS.md`, `MIGRATION.md`, `migration/*.md`, `packages/effect/{SCHEMA,CONFIG,CHANGELOG}.md`, `ai-docs/src/**`. The `v3` branch is Effect 3.
- Most blog posts, answers, and "Effect patterns" sites are v3. Translate with the table below, then check the `.d.ts`.

## v3 names that no longer exist

If one of these shows up in a doc or your draft, it's v3. Use the v4 form.

| v3 (gone) | v4 (use this) |
| --- | --- |
| `Context.Tag("X")<X, Shape>()`, `Context.GenericTag`, `Effect.Tag`, `Effect.Service` | `class X extends Context.Service<X, Shape>()("orx/X") {}`; layers are statics you write (`static readonly layer = Layer.effect(X, make)`) |
| `Effect.runtime<R>()` + `Runtime.runFork(rt)(eff)` / `Runtime.runSync` | `const ctx = yield* Effect.context<R>()` + `Effect.runForkWith(ctx)(eff)` / `Effect.runSyncWith(ctx)` |
| `Layer.scoped`, `Layer.unwrapEffect` | `Layer.effect` (it handles `Scope` itself), `Layer.unwrap` |
| `Layer.fail(e)` | `Layer.effectDiscard(Effect.fail(e))` |
| `FiberRef`, `Effect.locally` | `Context.Reference(key, { defaultValue })`, `Effect.provideService(Ref, value)`; built-ins in `References.*` |
| `catchAll`, `catchAllCause`, `catchAllDefect`, `catchSome` (Effect and Stream) | `Effect.catch` / `Stream.catch`, `catchCause`, `catchDefect`, `catchFilter` / `catchIf` |
| `tapErrorCause` | `tapCause` |
| `Effect.either`, `Either` | `Effect.result`, `Result` (`Result.isSuccess`, `.success`, `.failure`) |
| `Effect.fork`, `forkDaemon` | `Effect.forkChild`, `forkDetach` |
| `Fiber.poll(fiber)` | `fiber.pollUnsafe()` (an `Exit` or `undefined`) |
| `Effect.async` | `Effect.callback` |
| `timeoutFail({ duration, onTimeout })` | `timeoutOrElse({ duration, orElse: () => Effect.fail(...) })` |
| `TimeoutException`, `UnknownException` | `Cause.TimeoutError`, `Cause.UnknownError` |
| `Schedule.intersect(b)` | `Schedule.max([a, b])` (recurs while both do, longer delay); `Schedule.min` is the union |
| `Cause.isInterruptedOnly`, `Cause.isEmpty` | `Cause.hasInterruptsOnly`, `cause.reasons.length === 0` |
| `Cause.pretty(c, { renderErrorCause })` | `Cause.pretty(c)` (renders `Error.cause` chains by default) |
| `Inspectable.stringifyCircular` | `Formatter.formatJson` (drops circular refs, redacts `Redacted`) |
| `.annotations({...})` | `.annotate({...})` |
| `Schema.filter(pred, {...})` | `.check(Schema.makeFilter(pred, annotations))` |
| `minLength`, `maxLength`, `minItems`, `pattern`, `int`, `greaterThan` | `.check(Schema.isMinLength(n, { message }))`, `isMaxLength`, `isPattern`, `isInt`, `isGreaterThan` |
| `Schema.UUID`, `Schema.NonEmptyTrimmedString` | `Schema.String.check(Schema.isUUID())`, `Schema.Trimmed.check(Schema.isNonEmpty())` |
| `Schema.Literal("a", "b")`, `Schema.Union(A, B)` | `Schema.Literals(["a", "b"])`, `Schema.Union([A, B])` (`Literal("a")` with one value is fine) |
| `Schema.Record({ key, value })`, `Struct(fields, Record(...))` | `Schema.Record(K, V)`, `Schema.StructWithRest(Struct, [Record(K, V)])` |
| `Schema.decodeUnknown`, `decodeUnknownEither` | `Schema.decodeUnknownEffect`, `decodeUnknownResult` / `decodeUnknownExit` (`decodeUnknownSync` and `encodeSync` keep their names) |
| `ParseResult.ParseError`, `TreeFormatter.formatErrorSync(e)` | `Schema.SchemaError` (`.issue`), `SchemaIssue.makeFormatterDefault()(error.issue)` |
| `Schema.standardSchemaV1(s)` | `Schema.toStandardSchemaV1(s)` |
| `JSONSchema.make(s)` | `Schema.toJsonSchemaDocument(s, opts)`, then `JsonSchema.toDocumentDraft07(doc)` if you need draft-07 |
| `Arbitrary.make(s)`, `FastCheck` | `Arbitrary.schema(s)` from `effect/unstable/arbitrary`; fast-check is no longer bundled |
| `Config.string`, `integer`, `redacted`, `literal`, ... | `Config.String`, `Int`, `Redacted`, `Literals`, ... (PascalCase) |
| `Config.mapOrFail`, `ConfigError.InvalidData` | `Config.mapEffect(f)` failing with `new Config.ConfigError(new ConfigProvider.SourceError({ message }))`, or `Config.schema(schema, name)` |
| `ConfigProvider.fromMap`, `Layer.setConfigProvider`, `Effect.withConfigProvider` | `ConfigProvider.fromEnv({ env })` / `fromUnknown(obj)`, `ConfigProvider.layer(p)`, `config.parse(p)` |
| `Logger.replace(defaultLogger, l)`, `Logger.add(l)` | `Logger.layer([l1, l2])` (replaces all loggers; `{ mergeWithExisting: true }` adds) |
| `Logger.minimumLogLevel(LogLevel.Warning)` | `Layer.succeed(References.MinimumLogLevel, "Warn")` |
| `LogLevel.Debug` objects, `logLevel.label` | string literals: `"Trace" "Debug" "Info" "Warn" "Error" "Fatal"` (`"Warn"`, not `"Warning"`) |
| `TestClock` from `"effect"` | `import { TestClock } from "effect/testing"` |
| `@effect/cli` (`Options`, `Args`, `CliApp`) | `effect/unstable/cli` (`Flag`, `Argument`, `Command`); see below |
| `@effect/platform` (`FileSystem`, `Path`, `HttpClient`, `Terminal`), `@effect/platform-node` v0.x | `FileSystem`, `Path`, `Stdio`, `Terminal` from `"effect"`, HTTP from `effect/unstable/http`; the runtime here is `@effect/platform-bun` 4.x |
| `@effect/ai` (`AiLanguageModel`, `AiTool`, `AiToolkit`) | `LanguageModel`, `Tool`, `Toolkit` from `effect/unstable/ai` |

Unchanged: `Schema.TaggedError<Self>()("Tag", fields)` (early v4 betas called it `TaggedErrorClass`; it was renamed back), `Schema.brand`, `Schema.Trim`, `Schema.NullOr`, `Effect.gen`, `Effect.fn`, `catchTag`, `tryPromise`, `annotateLogs`, `ManagedRuntime.make`/`dispose`, `Layer.succeed`/`sync`/`effectDiscard`/`mergeAll`/`provideMerge`, `Clock.currentTimeMillis`.

## v4 idioms

- A service: `class ChatStore extends Context.Service<ChatStore, ChatStoreShape>()("orx/ChatStore") { static readonly layer = Layer.effect(ChatStore, make) }`. Name the main layer `layer` and variants by what differs (`layerMemory`, `layerModel`). The id string is namespaced (`orx/...`).
- Tags and `Config` values are Effects: `Effect.map(AppConfig, f)`, `Layer.effect(AppConfig, appConfig)`, and `yield* ChatStore` all work without conversion. `Option`, `Result`, `Ref`, `Fiber` are not Effects (`Fiber.join`, `Ref.get`).
- Prefer `yield* Service` over `Service.use(...)` (docs).
- For new code, a named function that returns an Effect is `Effect.fn("Module.name")(function* (arg: A) { ... }, ...combinators)`: pass combinators as extra arguments rather than `.pipe` on the result (docs). `Effect.fnUntraced` skips the span. Existing functions here use `Effect.gen`; don't rewrite them just to match.
- `Effect.gen(function* (_) { yield* _(x) })` is the pre-3.0 adapter style. Write `yield* x`.

## Behavior that surprises

- `Effect.catch` catches typed failures only. Defects and interruption need `catchCause` or `catchDefect`.
- Streams mirror it: `Stream.catch(f)` switches to `f(error)`'s stream on a typed failure, `Stream.catchIf(refinement, f)` / `catchTag` for some errors, `Stream.catchCause` for defects and interruption too. `Stream.retry` re-runs the whole stream, so anything already emitted is emitted again. `Stream.timeout(d)` ends the stream quietly when no element arrives in time (no error); fail explicitly with `Stream.interruptWhen(Effect.sleep(d).pipe(Effect.andThen(Effect.fail(e))))`. `Stream.onExit(f)` runs once however the stream ends, including when the consumer stops early. `Stream.toAsyncIterableWith(context)` hands a stream to non-Effect code; its `return()` (a `break` in `for await`) stops the stream, but `Stream.onExit` then sees a `Success` exit, not an interruption (run on rc.117). Don't use the exit tag to tell "finished" from "the consumer stopped early"; track completion yourself (a `Ref` set when the last element is produced).
- `Effect.promise` turns a rejection into a defect, and a throw inside `Effect.sync` is a defect too. Use `Effect.tryPromise({ try, catch })` / `Effect.try({ try, catch })` with a tagged error in `catch`; without `catch` you get `Cause.UnknownError`.
- Fail from a generator with `return yield* new SomeTaggedError({...})`. Without `yield*` it's a floating value that does nothing.
- A fiber started with `Effect.runForkWith(ctx)` from a callback fails silently: nothing is logged. End every forked program with `Effect.catchCause((cause) => Effect.logError("...", cause))`. The captured context keeps the caller's log annotations and logger.
- Don't call `Effect.runPromise`/`runSync` inside Effect code. It drops the context, interruption, and annotations. At a non-Effect callback boundary, capture `Effect.context<R>()` and use `Effect.runForkWith`/`runSyncWith`.
- Layer memoization: a layer is reused only when an `Effect.provide` runs inside a scope where that same layer value is already live (a nested provide). Sequential or sibling provides, and separate `ManagedRuntime`s, each build fresh. `Effect.provide(layer, { local: true })` always builds fresh. Build services once into the runtime; never `Effect.provide(SomeLayer)` per request.
- `Logger.layer([...])` replaces every logger, including the default one. A custom logger gets `{ message, logLevel, cause, date, fiber }`: `message` is the array of logged arguments, and annotations aren't there; read them with `options.fiber.getRef(References.CurrentLogAnnotations)` (a plain record). Options carry a live fiber, so tests can't build them by hand: `logging.ts` converts them to its own `LogEntry` (`toEntry`) and formats that, and tests pass hand-built `LogEntry` values to `toRecord`.
- Config: the env providers treat `""` as absent (so `Config.option` gives `None`), but a whitespace-only value is present. `Config.withDefault` applies only to absent input, never to an invalid value (docs).
- The default `ConfigProvider` copies `process.env` once, on first use, and caches it for the process (it's a `Context.Reference` default). Env changed later (`stubEnv` in a test, a script setting a var) is invisible unless you provide `ConfigProvider.layer(ConfigProvider.fromEnv(...))` built after the change; `runCli` provides `ConfigProvider.fromEnv({ env })` per run for exactly this reason.
- `Effect.runPromise` rejects with the original (squashed) error, not a `FiberFailure` wrapper. Use `runPromiseExit` to inspect the whole cause.
- `Schema.decodeUnknownSync` throws a `SchemaError` whose `.message` is already the default-formatted issue (`"Missing key\n  at [\"a\"]"`); the structured issue is on `.issue` and `.cause` is `undefined`. With the `Effect`/`Result` decoders, format `error.issue` with `SchemaIssue.makeFormatterDefault()` (`formatIssue` in `src/core/input.ts`).
- The default formatter's wording differs from v3's `TreeFormatter`: "Missing key", `Expected "user"`, "Expected a UUID", each followed by a path line (`at ["message"]["role"]`). It doesn't print schema identifiers; give a check an explicit `message` when a name must appear.
- A `ManagedRuntime` rejects every run after `dispose()`. orx has none: `src/bin.ts` runs one program with `BunRuntime.runMain`, and tests run `main` with `Effect.runPromise`.
- A pending forked fiber keeps the process alive (docs). A script or test that never joins or interrupts a fiber can hang.

## Schema

- Use the `Unknown` decoders at trust boundaries: `decodeUnknownEffect` (in Effect code), `decodeUnknownResult` (sync, no throw), `decodeUnknownSync` (throws).
- Annotation order matters. `.annotate()` applies to the outermost node: after a `.check(...)` it annotates the filter, and filter annotations (`description`, `examples`) are dropped from JSON Schema. Annotate the base schema first, then check: `Schema.String.annotate({ description, examples }).check(Schema.makeFilter(pred, { message }))`.
- A filter's `toJsonSchema` output is merged into the base type's schema (`{ type, format }`, `{ type, minLength, pattern }`); it goes under `allOf` only when keys clash. It never replaces the base type the way v3's `jsonSchema` annotation did.
- `Schema.toJsonSchemaDocument(s)` returns `{ dialect: "draft-2020-12", schema, definitions }`, not a bare schema. Objects are open by default (`additionalProperties: true`); `{ onExcessProperty: "error" }` closes them. Effect AI builds tool schemas itself (`Tool.getJsonSchema`, below), so orx doesn't call this for tools.
- An `identifier` annotation on the root produces a top-level `$ref` plus a definition. Don't put one on tool parameters or structured-output schemas (`ConfigFile` has one; it never goes to a model).
- `isUUID()` emits `format: "uuid"` plus a long `pattern`; a brand adds nothing.
- `Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })` rejects unknown keys at decode time (the config file uses it so a typo, or an `apiKey`, is an error).
- `Schema.fromJsonString(S)` decodes JSON text straight to `S` (chat files, the config file) and encodes back with `Schema.encodeEffect`.
- Before putting a schema in front of a model, print the final JSON Schema and read it, then pin it in a test.

## Effect tests under bun test

Tests use `bun:test`; Effect bodies run through `runTest` in `tests/helpers/effect.ts`, which replaces `@effect/vitest`'s `it.effect`: `it("...", () => runTest(Effect.gen(function* () { ... })))`.

- `runTest` provides a fresh `Scope`, the TestClock, and the TestConsole (`TestClock.layer()` and `TestConsole.layer` from `"effect/testing"`), then `Effect.runPromise`. The default logger writes to the TestConsole, so `Effect.log` prints nothing; to assert on log records, provide your own logger with `Logger.layer`. A thrown `expect` inside the body is a defect, and the rejected promise fails the test. For the live clock, call `Effect.runPromise` yourself.
- The TestClock starts at 0 and only moves on `TestClock.adjust`. Fork first, adjust, then join:
  ```ts
  const fiber = yield* Effect.forkChild(program);
  yield* TestClock.adjust("1 second");
  const result = yield* Fiber.join(fiber);
  ```
  `Clock.currentTimeMillis` reads the TestClock; `Date.now()` doesn't, which is one reason app code reads time through `Clock`.
- The TestClock reaches only effects run in the test's own fiber and layers provided to it. Code run through its own `Effect.runPromise` (`runCli` in `tests/helpers/cli.ts`) uses the live clock. Test time-based behavior on the program or service inside `runTest`, with the layers it needs provided there.
- When a forked program waits on real I/O (a stub server) between clock steps, let the event loop run between adjustments: poll with `fiber.pollUnsafe()` and a short real yield, rather than a fixed sleep.
- For isolation, `Effect.provide(layer)` per test (sequential provides build fresh each time; `ChatStore.layerMemory` starts empty on every build).
- Assert a failure with `const exit = yield* Effect.exit(program)`, `Effect.result(program)`, or `Effect.flip(program)` for the error value.
- All test files share one bun process, so the default `ConfigProvider`'s cached copy of `process.env` (below) is shared too: provide `ConfigProvider.fromEnv({ env })` in any test that depends on env.

## The CLI framework (`effect/unstable/cli`)

Replaces v3's `@effect/cli`. Checked against the installed `dist/unstable/cli/*.d.ts` and `.js`.

- `Command.make(name, { ...flags, ...args }, handler)`; the handler gets the parsed config object and returns an Effect. Compose with `Command.withSubcommands([...])`, `Command.withDescription`, `Command.withAlias`, `Command.withExamples`, `Command.provide`/`provideEffect` (per-command layers). `cli.subcommands` lists the groups (`main` reads command names from it).
- Flags: `Flag.String`, `Boolean`, `Int`, `Literals`, `ChoiceWithValue`, `Path`, `File`, `Redacted`, `KeyValuePair`, then `Flag.withAlias("m")`, `withDescription`, `withDefault`, `optional` (gives an `Option`), `withSchema`, `map`/`mapEffect`, `withFallbackConfig` (read a Config when the flag is absent). Arguments: `Argument.String`, `Int`, `Path`, ..., `Argument.variadic()` (an array), `optional`, `withDescription`. A `Flag.Boolean` without `withDefault(false)` is required: omitting it fails with "Missing required flag".
- Running: `Command.run(cli, { version, renderErrors })` reads argv from the `Stdio` service's `args`; `Command.runWith(cli, { version, renderErrors })(argv)` takes argv directly (what `src/main.ts` uses, so tests pass argv). Both need `FileSystem | Path | Terminal | ChildProcessSpawner | Stdio` (`Command.Environment`); `BunServices.layer` provides all five.
- Built-in global flags: `--help`/`-h`, `--version`/`-v` (not verbose), `--completions <bash|zsh|fish|sh>`, `--log-level <all|trace|debug|info|warn|warning|error|fatal|none>` (sets `MinimumLogLevel` for the handler), `--wizard` (interactive). They are `GlobalFlag.BuiltIns`.
- Where output goes: help, `--version`, completions, and the wizard print with `Console.log`; on a parse error the framework prints the help doc with `Console.log` and the errors with `Console.error` (unless `renderErrors: false`, which skips the error rendering but still prints help). `Console.Console` is a `Context.Reference` whose default is the global console, so all of this goes to stdout unless you provide another `Console` (`Effect.provideService(Console.Console, c)`). `main` provides a holding console and flushes it by outcome.
- Errors: failures are `CliError.CliError` (`CliError.isCliError`), tagged `UnrecognizedOption`, `DuplicateOption`, `MissingOption`, `MissingArgument`, `UnexpectedArgument`, `InvalidValue`, `UnknownSubcommand`, `UserError`, and `ShowHelp` (with `errors`; empty for an explicit `--help` or a bare parent command). The framework's own exit code for `ShowHelp` with errors is 1; orx maps every `CliError` to 2 in `outcomeOf`.
- `Prompt` (`Prompt.String`, `Confirm`, `Select`, `AutoComplete`, ...; `Prompt.run`) drives interactive prompts through `Terminal`. It needs a TTY; check `Stdio.stdinIsTerminal` first.

## Effect AI (`effect/unstable/ai`) and `@effect/ai-openrouter`

Replaces v3's `@effect/ai`. Checked against the installed `.d.ts` and by running it.

- `LanguageModel.streamText({ prompt, toolkit?, toolChoice?, concurrency?, disableToolCallResolution? })` is a `Stream` of `Response.AnyPart` (`text-delta`, `tool-call`, `tool-result`, `response-metadata`, `finish`, ...). With a toolkit it resolves the step's tool calls and emits their results, then ends: there is no multi-step loop and no `maxSteps` (orx's loop is `runTurn` in `src/core/chat.ts`). `generateText` is the non-streaming form; `generateObject({ prompt, schema, objectName })` returns `response.value` (decode it again anyway) and `response.usage`.
- A model is a service: `Stream.provideService(LanguageModel.LanguageModel, model)` / `Effect.provideService(...)`. `LanguageModel.make` builds a custom one (tests script parts with it).
- `Prompt.make([{ role, content }, ...])`, `Prompt.concat(a, b)`, `Prompt.fromResponseParts(parts)` (turns a step's parts, including tool calls and results, into the messages for the next step).
- Usage: the `finish` part has `usage.inputTokens.total` / `usage.outputTokens.total` (possibly `undefined`) and `metadata`; OpenRouter's provider, cost, and raw usage are under `metadata.openrouter`.
- Errors are `AiError.AiError` (`AiError.isAiError`) with `isRetryable` and a `reason` tagged `AuthenticationError`, `RateLimitError`, `QuotaExhaustedError`, `ContentPolicyError`, `InvalidRequestError`, `NetworkError`, `TransportError`, `InternalProviderError`, `StructuredOutputError`, `InvalidOutputError`, `UnsupportedSchemaError`, the `Tool*` errors, and `UnknownError`; HTTP reasons carry `reason.http.response.status`.
- Tools: `Tool.make(name, { description, parameters, success, failure?, failureMode?: "error" | "return" })`; `Toolkit.make(...tools)`, `Toolkit.merge(a, b)`, `toolkit.toLayer({ name: handler })` (handlers get services from the context). `Tool.getJsonSchema(tool)` is what providers send: objects are open (`additionalProperties: true`), a tool with no `parameters` is `{ type: "object", additionalProperties: false }`, an `identifier` annotation gives a top-level `$ref`/`$defs`, and `.annotate(Tool.Strict, true)` sets only the request's `strict` flag, not the schema.
- `@effect/ai-openrouter`: `OpenRouterClient.make({ apiKey, apiUrl, siteTitle })` over the context's `HttpClient` (it POSTs `{apiUrl}/chat/completions`), then `OpenRouterLanguageModel.make({ model, config })`, where `config` is merged into the request body (`models`, `provider`, `max_tokens`, ...). It rewrites tool schemas per model id: `openai/*`, `gpt-`, `o1-`/`o3-`/`o4-` get `toCodecOpenAI` and `anthropic/*`, `claude-` get `toCodecAnthropic`, which close objects and drop `examples`; others get the schema as is. Provider-defined tools are unsupported.
- MCP: `McpServer.layerStdio({ name, version, protocols: [McpProtocol.v2025_11_25, ...] })` (a non-empty list) serves over the `Stdio` service; `McpServer.toolkit(toolkit)` registers a toolkit and needs its handler layer. `Layer.launch(...)` runs it until stdin closes. Nothing else may write stdout while it runs.

## @effect/platform-bun and the runtime defaults

- `BunRuntime.runMain(effect, { disableErrorReporting?, teardown? })` runs the program, interrupts it on SIGINT/SIGTERM, and calls `teardown(exit, onExit)` for the exit code. Without `disableErrorReporting: true` it logs an unreported failure with `Effect.logError`, and the default logger writes with `console.log`: stdout. orx disables it and maps the `Exit` itself (interrupt-only causes are 130).
- The default logger (`Logger.defaultLogger`) and `Logger.consolePretty` use `console.log` unless `Logger.LogToStderr` (a `Context.Reference<boolean>`) is `true`. orx replaces the loggers entirely (`Logger.layer([...])` in `src/logging.ts`, stderr and file sinks) at the outermost layer, so nothing logged before or after the command reaches stdout.
- `BunServices.layer` provides `ChildProcessSpawner | Crypto | FileSystem | Path | Terminal | Stdio`; `src/bin.ts` provides it, and so does `runCli` in tests. `FetchHttpClient.layer` (`effect/unstable/http`) is the `HttpClient`. In `src/`, only `src/bin.ts` imports `@effect/platform-bun`.
- `Stdio.Stdio` has `args`, `stdin` (a `Stream<Uint8Array>`), `stdout()`/`stderr()` sinks (`{ endOnDone: false }` to keep them open), `stdinIsTerminal`, `stdoutIsTerminal`. `Stdio.layerTest({ ...partial })` builds one for tests (`runCli` does).
- `Terminal` (`BunTerminal` is the shared Node implementation): building the layer only adds an `end` listener to stdin. The readline interface, which puts a TTY in raw mode, is acquired on the first read and released 10 ms after the last, so providing `Terminal` doesn't take stdin away from piped `ask` or `orx mcp`.


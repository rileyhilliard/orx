---
paths:
  - "src/services/**"
  - "src/core/**"
  - "src/runtime.ts"
  - "src/config.ts"
  - "src/errors.ts"
  - "src/logging.ts"
  - "src/main.ts"
---

# Services, config, errors (Effect)

Everything outside `src/tui/` and `src/bin.ts` is plain Effect with no platform of its own: `src/bin.ts` provides it, and tests provide the same `BunServices`. The Effect version and when to load the `effect` skill are in `effect.md`.

## Services and layers

- A service is a `Context.Service` class in `src/services/` with id `"orx/<Name>"` and its layers as statics: `static readonly layer` for the app, plus a test variant named by what differs (`ChatStore.layerMemory`) only where a test needs one. The model has no test layer: tests point the real `Llm.layer` at the stub OpenRouter (`testing.md`). Add it to `AppLayer` in `src/runtime.ts`.
- `AppLayer` never builds platform services. `FileSystem`, `Path`, `Stdio`, `Terminal`, `ChildProcessSpawner`, `HttpClient`, and `Host` come from outside: `BunServices.layer` + `FetchHttpClient.layer` in `src/bin.ts`, `BunServices.layer` + `Stdio.layerTest` in `tests/helpers/cli.ts`. A service that needs the platform yields the abstract service (`yield* FileSystem.FileSystem`), never a Bun or Node API.
- One process, one run: there is no hot reload and no `globalThis` state. A layer is built once per invocation. Caches (the models list's `Ref`, the OpenRouter client from `Effect.cached`) live inside the layer's closure.
- Services depend on other services through the context (`yield* OtherService`), never by providing another service's layer inside a constructor. Yield dependencies in the layer constructor, not in each method, so methods return `Effect<A, E, never>`.
- Building a layer must not read config that can fail. `AppConfig.load` is lazy and cached: a service yields `AppConfig` in its constructor and runs `load` inside the method that needs settings. That's what keeps `--help`, `--version`, `doctor`, and `update` working with a broken config file.

## Config

- Every env var is read in `src/config.ts` through Effect Config; empty counts as unset (`optionalString`). The key is `Config.Redacted`. Only `config.ts` and `src/bin.ts` (which clears `DEV`) touch `process.env`; the `guard-boundaries` hook denies it anywhere else.
- `AppConfig.load` layers env over the optional `$XDG_CONFIG_HOME/orx/config.json` (`ConfigProvider.orElse(env, fromUnknown(file))`), decoded with the `ConfigFile` schema and `onExcessProperty: "error"`. The file can't hold the key: `ConfigFile` has no key field and is closed, so an `apiKey` in it is `InvalidConfig`, and `tests/config.test.ts` proves it never reaches a request. A new setting that belongs in the file goes in `ConfigFile` and `fileToEnv`.
- Settings that must work with a broken file are read on their own, not through `AppConfig`: `releasesConfig` (update), `pathsConfig`, `logConfig`, `outputConfig`. A bad `LOG_LEVEL` falls back to the default instead of failing every command.
- A new var goes in `config.ts`, `.env.example`, and the table in `docs/reference.md`.

## Errors and exit codes

- Expected failures are `Schema.TaggedError` classes in `src/errors.ts`, each with a user-safe `message`. `exitCodeFor` and `retryableFor` switch exhaustively on the tag, so a new error needs a decision in both (and in the `AppError` union and `APP_ERROR_TAGS`). The codes are documented: 2 usage and input, 3 config, 4 upstream, 5 model output, 6 permission; 1 is a defect, 130 interrupted.
- Anything else is a defect: `main` logs it once with `Effect.logError` and prints a generic message (exit 1). Don't catch and swallow defects earlier, and don't turn one into a tagged error to make it "handled". Platform errors that mean a broken data dir are defects (`Effect.orDie` in `ChatStore`); ones the user can fix are tagged (`PermissionDenied` in `update` and `ChatStore.save`).
- `Effect.catch` catches typed failures only; defects and interruption need `Effect.catchCause`. `Effect.promise` and a throw inside `Effect.sync` are defects: wrap third-party promises with `Effect.tryPromise({ try, catch })` and throwing code with `Effect.try`, mapping to a tagged error. Fail with `return yield* new SomeError({...})`.

## Retry, timeout, limits

- Non-streaming calls (models list, releases) use `Effect.retry` with a jittered exponential `Schedule.max([exponential.jittered, recurs(2)])` and `Effect.timeoutOrElse`, retrying only what can succeed on retry (`UpstreamUnavailable` with `retryable`). Log a failure once, after the retries, not per attempt. The HTTP client has no retries of its own, so there is one retry layer.
- The streaming chat turn is different: see `effect-ai.md` (retry only before the first part, and a stream-duration cap via `Stream.interruptWhen`).
- Limits (`MAX_OUTPUT_TOKENS`, `MAX_TOOL_STEPS`, `MAX_STREAM_SECONDS`, prompt size in the `Prompt` schema) come from Config or schemas and are enforced before or during the call, never after.
- Time comes from `Clock`, not `Date.now()`, in anything a test drives with `TestClock` (the tool's clock, the models cache TTL, the turn's timings). `newChat` timestamps use `Date` because nothing tests their exact value.

## Runtimes and callbacks

- `src/bin.ts` runs one program with `BunRuntime.runMain(program, { disableErrorReporting: true, teardown })`. Don't add a second `runMain`, a `ManagedRuntime`, or `Effect.runPromise` inside Effect code: it drops the context, interruption, and log annotations.
- At a non-Effect boundary (the TUI bridge, a callback), capture `yield* Effect.context<R>()` and use `Effect.runPromiseWith(context)`, `Effect.runForkWith(context)`, or `Stream.toAsyncIterableWith(context)`. A forked program ends in `Effect.catchCause(... Effect.logError ...)`: a failing forked fiber prints nothing otherwise.
- `Layer.effect` handles scoped constructors (finalizers register on the layer's scope); there is no `Layer.scoped`. A resource that must be released on Ctrl+C (the renderer, a temp file) is `Effect.acquireRelease` inside `Effect.scoped`.

## Logging

`Effect.logInfo` / `logWarning` / `logError` with annotations, never `console.*` (denied in `src/`). `src/logging.ts` formats records: pretty or JSON lines on stderr, JSON lines appended to `ORX_LOG_FILE` (`logs/orx.jsonl` under `bun run orx`), never stdout. Annotation keys become top-level JSON keys, so use stable camelCase names and don't reuse `time`, `level`, `msg`, `detail`, or `error`. `main` logs one `command` line per invocation (command, flag names, exitCode, durationMs, runId, errorTag) and each turn logs one `llm call` line; don't add per-command access logging. Never log prompt or reply text, argument or flag values, or the key, and don't log whole third-party error objects: pass the error as a log argument and `logging.ts` keeps only its name, message, status, and stack. While the TUI owns the terminal, `TerminalLogging` is false and only the file sink writes.

---
description: Add an Effect service (a Context.Service with static layers) and wire it into the app layer
argument-hint: "<service name and responsibility>"
---

Add a service: $ARGUMENTS

Follow `.claude/rules/src/effect-services.md`, and look at an existing service in `src/services/` first (`ChatStore` for local state with a memory variant, `OpenRouterModels` or `Releases` for HTTP with retry and timeout).

1. **Interface.** `export interface <Name>Shape` with a small set of Effect-returning methods, and `export class <Name> extends Context.Service<<Name>, <Name>Shape>()("orx/<Name>") {}` in `src/services/<Name>.ts`. Failures it can produce are tagged errors in `src/errors.ts`, each with an exit code in `exitCodeFor` and a decision in `retryableFor`.
2. **Layer.** `static readonly layer = Layer.effect(<Name>, make)` on the class. `make` yields its dependencies once (platform services like `FileSystem.FileSystem` or `HttpClient.HttpClient`, other services, `AppConfig`) and must not fail on bad config while being built: run `load` inside the methods that need settings. New env vars go in `src/config.ts`, `.env.example`, and the table in `docs/reference.md`. No Bun or Node APIs: the core is platform-free and gets its platform services from `src/bin.ts`.
3. **Wire it** into `AppLayer` in `src/runtime.ts`. Tests get it through the same `AppLayer` (`runCli`); add a `static readonly layerMemory` (fresh state per build) or a scripted variant only if a test needs to replace what it talks to.
4. **Tests.** Test it with `bun:test`, running Effect bodies with `runTest` (`tests/helpers/effect.ts`), using its real `layer` where that's local, or pointed at a stub server where it calls a third party. Use `TestClock` for anything time-based. Then one `runCli` test for the command that uses it.
5. `/check`.

Keep the interface free of implementation details, so a different backing store later is a new layer, not a new interface.

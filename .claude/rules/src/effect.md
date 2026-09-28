---
paths:
  - "src/**"
  - "tests/**"
  - "scripts/**"
  - "evals/**"
---

# Effect version

This is Effect 4 (`effect`, `@effect/platform-bun`, and `@effect/ai-openrouter`, all 4.0.0-rc.117 and pinned exactly; `overrides` pins `@effect/platform-node-shared`, which `@effect/platform-bun` depends on with a caret range, too). Load the `effect` skill before writing or changing Effect code, or before looking up any Effect API: most training data and docs show Effect 3, and many of those names are gone. The CLI, AI, and platform modules (`effect/unstable/cli`, `effect/unstable/ai`, `@effect/ai-openrouter`, `@effect/platform-bun`) have their own sections there.

- Don't take API shapes from Context7 `/effect-ts/effect-smol` (archived at beta.98) or v3 docs. Use `/websites/effect_website_v4_api`, and check `node_modules/effect/dist/<Module>.d.ts` (and `dist/unstable/cli/`, `dist/unstable/ai/`) when in doubt.
- The v3 habits that slip through most: `Context.Tag` (now `Context.Service`), `Effect.catchAll` / `Stream.catchAll` (`Effect.catch` / `Stream.catch`), `Either` (`Result`), `.annotations` (`.annotate`), `Schema.filter` (`.check(Schema.makeFilter(...))`), `Effect.runtime` + `Runtime.runFork` (`Effect.context` + `Effect.runForkWith`), `Effect.fork` (`forkChild`), `TestClock` from `"effect"` (`"effect/testing"`), `LogLevel.Warning` (`"Warn"`), `@effect/cli` and `@effect/platform` (now `effect/unstable/cli` and the platform modules in `effect`), `@effect/ai` (`effect/unstable/ai`).

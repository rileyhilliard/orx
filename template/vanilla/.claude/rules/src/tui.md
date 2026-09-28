---
paths:
  - "src/tui/**"
  - "src/commands/ui.ts"
  - "src/commands/load-tui.ts"
  - "tests/tui/**"
  - "scripts/tui-capture.ts"
  - "DESIGN.md"
---

# TUI (OpenTUI + React)

`orx ui` is OpenTUI (`@opentui/core` + `@opentui/react`, pinned exactly `0.5.12`) with React 19. Today it's a placeholder screen (`src/tui/app.tsx`): a prompt input, the last reply or error, Enter sends, Ctrl+C quits. Load the `opentui` skill before changing anything here, and the `tui-design-slop` skill before adding a header, status line, empty state, or panel. `DESIGN.md` has the tokens, layout, keybindings, and states.

## The bridge

- `src/tui/launch.tsx` is the only TUI file that imports `effect`. `makeBridge` captures `Effect.context()` and hands components a `UiBridge` (`src/tui/types.ts`): plain data (`model`), promises (`ask(prompt)`, run with `Effect.runPromiseWith(context)`), and `quit`. Errors arrive already mapped to `{ message, retryable }`: `ask` never rejects, it resolves to an `error` reply. Components never import `effect`, `~/core`, or `~/services` (the `guard-boundaries` hook and the Grit rule deny `effect` imports under `src/tui/` outside `launch.tsx`).
- Something new a component needs goes on `UiBridge` as a plain function, built in `launch.tsx` from an Effect program. Keep the types in `types.ts` free of Effect types. A streaming reply would be an async iterable built with `Stream.toAsyncIterableWith(context)`; stopping it is `iterator.return()`, which the stream sees as a `Success` exit, not an interruption (`effect-ai.md`).
- `commands/ui.ts` and `commands/doctor.ts` (for `--tui`) load the bridge through `importTui` in `commands/load-tui.ts`, a dynamic `import("../tui/launch")` that turns a load failure into `TuiUnavailable`, so no other command, and no vitest test, loads OpenTUI. Keep it that way: a static import of anything under `src/tui/` from outside it would load OpenTUI on every run and into every vitest file that imports the command tree. The `guard-boundaries` hook and the Grit rule deny one (type-only imports included, so shared types live outside `src/tui/`).

## Terminal and signal ownership

- Effect owns signals and the exit code; OpenTUI must not. The renderer is created with `RENDERER_OPTIONS` (`exitOnCtrlC: false`, `exitSignals: []`, `consoleMode: "disabled"`), and `tests/tui/launch.test.ts` pins them. OpenTUI's defaults would call `process.exit` on Ctrl+C and on SIGINT/SIGTERM/SIGHUP (among others), skipping cleanup and returning the wrong exit code; `exitSignals: []` is honored (an empty array, not a fallback to the defaults).
- The renderer puts stdin in raw mode, so Ctrl+C arrives as a key, not a SIGINT. It's a `useKeyboard` binding that calls `bridge.quit()`, which resolves the handler normally (exit 0). A real signal (`kill -INT`) interrupts the Effect fiber; the renderer is an `Effect.acquireRelease` resource, so `destroy()` restores the terminal either way. A request still in flight when you quit is abandoned; if a future screen saves state, stop the request and save before calling `quit`.
- While a renderer exists it has installed `process.on` handlers for `uncaughtException` and `unhandledRejection` (they print the error and don't exit) and replaced `globalThis.requestAnimationFrame`. A floating promise in a component won't crash the process; its rejection prints over the screen. Every promise a component starts ends in `.catch(...)` or `.then(ok, fail)` that shows the error in the UI (`app.tsx` does this for `bridge.ask`). `try/finally` doesn't count: `finally` runs cleanup and lets the rejection through. The bridge (`launch.tsx`) logs defects, so a component only has to show them.
- Logs: `launchUi` provides `TerminalLogging` false, so while the TUI runs only the file sink writes. Never write to stdout or stderr from a component; show state in the UI.
- `src/bin.ts` deletes `DEV` before anything imports `@opentui/react`, which loads its devtools when `DEV=true`.

## Components

- Intrinsic elements are OpenTUI's (`box`, `text`, `span`, `input`, `textarea`, `select`, `scrollbox`, `markdown`, `code`), laid out with Yoga flexbox props (`flexDirection`, `flexGrow`, `padding*`, `border`). There is no DOM, no CSS, and no `onClick`.
- The input isn't controlled: `app.tsx` reads the value in `onSubmit` and remounts the input (a `key` bumped per send) to clear it (`AGENTS.md`, Build workarounds).
- Colors come from `theme` in `src/tui/theme.ts`; a hex literal anywhere else under `src/tui/` fails lint. Keys use `key.name` and modifier flags (`key.ctrl`, `key.shift`) from `useKeyboard`; a binding that should not fire in some state (a request pending, an overlay open) checks that state. New bindings go in `DESIGN.md`, the footer, and the command description.
- States to cover: empty, waiting, reply (usage line under it), error (retry offered only when `retryable`), and a bridge promise that rejects anyway.

## Tests

- TUI tests are `bun test` only (`bun run test:tui`, or `bun test ./tests/tui/<file>`): `testRender` from `@opentui/react/test-utils` needs Bun, and vitest excludes `tests/tui/`. `tests/tui/setup.ts` (bunfig preload) isolates the env the way vitest's setup does.
- Render with `render(<App bridge={fake} />, { width, height })` from `tests/tui/render.ts` (`testRender` with React's act warnings off), drive with `mockInput` (`typeText`, `pressEnter`, `pressKey`, `pressCtrlC`), and assert on `captureCharFrame()`. A fake `UiBridge` is a plain object with an `ask` that returns a promise; no Effect needed. `closed-loop.test.tsx` builds the real bridge over the stub OpenRouter.
- Wait with `waitForScreen(setup, predicate)` from `tests/tui/render.ts`, which renders until the frame matches or a deadline passes. `waitForFrame` stops as soon as the renderer has nothing scheduled, before React commits a state update that arrives from a promise, even a fake bridge's.
- Destroy the renderer after each test (`renderer.destroy()`), or its process handlers and raw-mode stdin leak into the next one.
- To see the real screen: `bun run tui:capture -- ui --keys "hi<enter>" --wait-for "in /"` runs orx in a PTY and prints the rendered screen as text. orx's own flags go after a second `--` (`bun run tui:capture -- --keys "hi<enter>" -- ui --log-level debug`).

---
paths:
  - "src/tui/**"
  - "src/commands/session.ts"
  - "src/commands/load-tui.ts"
  - "tests/tui/**"
  - "scripts/tui-capture.ts"
  - "DESIGN.md"
---

# TUI (OpenTUI + React)

The `orx` session TUI is OpenTUI (`@opentui/core` + `@opentui/react`, pinned exactly `0.5.12`) with React 19. Load the `opentui` skill before changing anything here, and the `tui-design-slop` skill before adding a header, status line, empty state, or panel. `DESIGN.md` has the tokens, layout, keybindings, and states.

## The bridge

- `src/tui/launch.tsx` is the only TUI file that imports `effect`. It captures `Effect.context()` and hands components a `ChatBridge` (`src/tui/types.ts`): plain data, promises (`listModels`, `exportMarkdown`), and an async iterable per turn (`send`, built with `Stream.toAsyncIterableWith(context)`). Errors arrive already mapped to `{ message, retryable }`, and the iterable yields an `error` event rather than throwing. Components never import `effect`, `~/core`, or `~/services` (the `guard-boundaries` hook and the Grit rule deny `effect` imports under `src/tui/` outside `launch.tsx`).
- Something new a component needs goes on `ChatBridge` as a plain function, built in `launch.tsx` from an Effect program. Keep the types in `types.ts` free of Effect types.
- Stopping a reply is `iterator.return()` on the turn's iterator: that stops the stream, `runTurn`'s `onExit` saves the partial reply, and `sendMessage`'s `onSaved` hands the bridge the chat as saved (it never reads it back). The stop arrives as a `Success` exit, not an interruption (see `effect-ai.md`), so a test should assert the saved reply is marked interrupted.
- `commands/session.ts` (bare `orx`) and `commands/doctor.ts` (for `--tui`) load the bridge through `importTui` in `commands/load-tui.ts`, a dynamic `import("../tui/launch")` that turns a load failure into `TuiUnavailable`, so no other command, and no test outside `tests/tui/`, loads OpenTUI. Keep it that way: a static import of anything under `src/tui/` from outside it would load OpenTUI on every run and into every test file that imports the command tree. The `guard-boundaries` hook and the Grit rule deny one (type-only imports included, so shared types live outside `src/tui/`).

## Terminal and signal ownership

- Effect owns signals and the exit code; OpenTUI must not. The renderer is created with `RENDERER_OPTIONS` (`exitOnCtrlC: false`, `exitSignals: []`, `consoleMode: "disabled"`), and `tests/tui/launch.test.ts` pins them. OpenTUI's defaults would call `process.exit` on Ctrl+C and on SIGINT/SIGTERM/SIGHUP (among others), skipping the chat save and returning the wrong exit code; `exitSignals: []` is honored (an empty array, not a fallback to the defaults).
- The renderer puts stdin in raw mode, so Ctrl+C arrives as a key, not a SIGINT. It's a `useKeyboard` binding that stops any reply, then calls `bridge.quit()`, which resolves the handler normally (exit 0). A real signal (`kill -INT`) interrupts the Effect fiber; the renderer is an `Effect.acquireRelease` resource, so `destroy()` restores the terminal either way.
- While a renderer exists it has installed `process.on` handlers for `uncaughtException` and `unhandledRejection` (they print the error and don't exit) and replaced `globalThis.requestAnimationFrame`. A floating promise in a component won't crash the process; its rejection prints over the screen. Every promise a component starts ends in `.catch(...)` or `.then(ok, fail)` that shows the error in the UI. `try/finally` doesn't count: `finally` runs cleanup and lets the rejection through. The bridge (`launch.tsx`) logs defects, so a component only has to show them.
- Logs: `launchChat` provides `TerminalLogging` false, so while the TUI runs only the file sink writes. Never write to stdout or stderr from a component; show state in the UI.
- `src/bin.ts` deletes `DEV` before anything imports `@opentui/react`, which loads its devtools when `DEV=true`.

## Components

- Intrinsic elements are OpenTUI's (`box`, `text`, `span`, `input`, `textarea`, `select`, `scrollbox`, `markdown`, `code`), laid out with Yoga flexbox props (`flexDirection`, `flexGrow`, `padding*`, `border`). There is no DOM, no CSS, and no `onClick`.
- Colors come from `theme` in `src/tui/theme.ts`; a hex literal anywhere else under `src/tui/` fails lint. Keys use `key.name` and modifier flags (`key.ctrl`, `key.shift`) from `useKeyboard`; a binding that should not fire while streaming or while the picker is open checks that state, as the existing ones do. New bindings go in `DESIGN.md` and the command description.
- States to cover: empty chat, streaming, tool call shown, a denied tool line (with the reason), finished (usage line under the reply), interrupted, error (Retry offered only when `retryable`), models list unavailable (picker falls back to the default), export done and failed. The approval panel: unarmed for `APPROVAL_ARM_MS` after it appears (y / a / n do nothing yet), a diff long enough to scroll, and "no" with a note for the model. The permission mode in the footer (shown when it isn't `default`), and its change on Shift+Tab or `/mode`. The slash command list and the `@` file list, each with matches and with "No matches".

## Tests

- TUI tests run with the rest (`bun run test`), or alone with `bun run test:tui` or `bun test ./tests/tui/<file>`. They share one process with the unit tests, after the same preload (`tests/setup.ts`), so destroy every renderer a test creates.
- Render with `testRender(<App bridge={fake} />, { width, height })`, drive with `mockInput` (`typeText`, `pressEnter`, `pressKey`, `pressCtrlC`), wait with `waitForFrame` / `renderOnce`, and assert on `captureCharFrame()`. A fake `ChatBridge` is plain objects and async generators; no Effect needed. The closed-loop test builds the real bridge over the stub OpenRouter.
- `waitForFrame` stops as soon as the renderer has nothing scheduled; it doesn't wait for I/O. That's fine with a fake bridge, whose events are microtasks, but with the real bridge (HTTP to the stub, the chat file's write) use `waitForScreen` from `tests/tui/render.ts`, which renders until the frame matches or a deadline passes. A turn's usage line appears before the chat is saved; the input leaving "Replying…" marks the end of the turn, save included.
- Destroy the renderer after each test (`renderer.destroy()`), or its process handlers and raw-mode stdin leak into the next one.
- To see the real screen: `bun run tui:capture -- --keys "hi<enter>"` runs orx in a PTY and prints the rendered screen as text. orx's own flags go after a second `--` (`bun run tui:capture -- --keys "hi<enter>" -- --resume <id>`).

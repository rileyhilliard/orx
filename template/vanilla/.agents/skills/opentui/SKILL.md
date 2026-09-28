---
name: opentui
description: OpenTUI (@opentui/core + @opentui/react 0.5.12) guidance for orx's terminal UI in src/tui/. Use before writing or changing a TUI component, the renderer setup in src/tui/launch.tsx, keybindings, or a test under tests/tui/, because OpenTUI is young, its docs lag the code, and it is not Ink or the DOM.
---

# OpenTUI in orx

`@opentui/core` and `@opentui/react` are pinned exactly to 0.5.12, with React 19. The repo rules (the bridge, signal ownership, states) are in `.claude/rules/src/tui.md`; `DESIGN.md` has the tokens, layout, and keybindings. This file is the OpenTUI knowledge behind them.

Everything below was checked against the installed 0.5.12 (`node_modules/@opentui/core/*.d.ts`, `node_modules/@opentui/react/src/**/*.d.ts`, and the bundled `.js`). When a doc and the `.d.ts` disagree, the `.d.ts` wins; when the `.d.ts` is silent, read the `.js` (`core/chunk-bun-*.js` is the Bun build).

## Not Ink, not the DOM

- Rendering is native (Zig, loaded over FFI from `@opentui/core-<os>-<arch>`, an optional dependency per platform; linux also has `-musl` variants selected by `OPENTUI_LIBC`). `resolveRenderLib()` loads it and throws when the package for the host is missing; `orx doctor --tui` calls it.
- JSX intrinsics (`jsxImportSource: "@opentui/react"`): `box`, `text`, `span`, `code`, `diff`, `markdown`, `input`, `textarea`, `select`, `tab-select`, `scrollbox`, `ascii-font`, `line-number`, `image`, plus the text children `span`, `b`/`strong`, `i`/`em`, `u`, `a` (link), `br` (`@opentui/react/src/components/index.d.ts`). Layout is Yoga flexbox props on the element (`flexDirection`, `flexGrow`, `padding`, `paddingLeft`, `width`, `height`, `border`, `borderColor`); colors are `fg`/`bg` props. There is no CSS, no `className`, no `div`, no `onClick`.
- `input` takes `focused`, `onInput`, `onChange`, `onSubmit(value)`, `placeholder`; `textarea` has `onSubmit()` without a value; `select` / `tab-select` take `options` and `onChange(index, option)` / `onSelect(index, option)`; `scrollbox` scrolls its children. Only a `focused` element receives typed keys; `autoFocus` (renderer config, default true) focuses the first focusable one.
- Text is strings or nested `span`s inside `text`. A number or boolean child renders as text; `undefined` renders nothing.

## The renderer

```ts
const renderer = await createCliRenderer(config) // from "@opentui/core"
createRoot(renderer).render(<App />)             // from "@opentui/react"
renderer.destroy()                                // restores the terminal; idempotent via isDestroyed
```

`CliRendererConfig` options that matter here, with their defaults from the source:

| Option | Default | orx |
| --- | --- | --- |
| `exitOnCtrlC` | `true`: Ctrl+C calls `process.exit` | `false` (Effect owns exit; Ctrl+C is a keybinding) |
| `exitSignals` | `SIGINT SIGTERM SIGQUIT SIGABRT SIGHUP SIGPIPE SIGBREAK SIGBUS`, each exiting the process | `[]` (read as `config.exitSignals \|\| defaults`, and `[]` is truthy, so it holds) |
| `consoleMode` | `"console-overlay"`: captures `console.*` into an in-TUI console | `"disabled"` |
| `screenMode` | `"alternate-screen"` (`"main-screen"`, `"split-footer"`) | default |
| `useMouse` | `true` | default |
| `targetFps` / `maxFps` | 30 / 60 | default |
| `stdin` / `stdout` | `process.stdin` / `process.stdout` | default |
| `onDestroy` | none | unused (the test renderer uses it) |

What creating a renderer does to the process (from the constructor's own docs and code), all undone by `destroy()`:

- Takes exclusive ownership of stdin and stdout; `setupTerminal()` (run by `createCliRenderer`) puts stdin in raw mode and resumes it. In raw mode Ctrl+C is a key event, not SIGINT.
- Adds `process.on` listeners for `SIGWINCH`, `warning`, `uncaughtException`, `unhandledRejection`, and each of `exitSignals`. The exception handlers `console.error` the error (and open the console overlay when `openConsoleOnError`); they don't exit, so a throw in a handler or a rejected promise doesn't crash the process while a renderer lives.
- Replaces `globalThis.requestAnimationFrame`.
- Registers the renderer in a process-wide tracker and allocates native memory.

Always create it through `createCliRenderer` (it destroys on a failed setup) and release it in a finalizer (`Effect.acquireRelease` in `launch.tsx`).

Environment variables OpenTUI reads on its own, so a user's shell can change behavior: `OTUI_USE_ALTERNATE_SCREEN` (overrides `screenMode`), `OTUI_OVERRIDE_STDOUT`, `OTUI_USE_CONSOLE`, `OTUI_DEBUG`, `OTUI_SHOW_STATS`, `OTUI_NO_NATIVE_RENDER`, `OPENTUI_LIBC`, `OPENTUI_FORCE_UNICODE`/`WCWIDTH`/`NOZWJ`, and a few more (`grep -o '"OTUI_[A-Z_]*"' node_modules/@opentui/core/chunk-bun-*.js`). `@opentui/react` loads its devtools when `DEV === "true"`, which is why `src/bin.ts` deletes `DEV`.

## React hooks (`@opentui/react`)

- `useKeyboard(handler, { release? })`: press events (repeats have `repeated: true`); `release: true` adds release events (`eventType: "release"`). A `KeyEvent` has `name` (`"c"`, `"escape"`, `"return"`, `"up"`), `ctrl`, `meta`, `shift`, `option`, `sequence`. Every mounted `useKeyboard` sees every key, including ones a focused `input` consumes; gate bindings on state (a request pending, an overlay open).
- `usePaste(handler)` (bracketed paste, `event.text`), `useRenderer()`, `useOnResize((w, h) => ...)`, `useTerminalDimensions()`, `useFocus` / `useBlur` (terminal window focus), `useSelectionHandler`, `useTimeline` (animation), `useAppContext`.
- `createRoot(renderer)` returns `{ render, unmount }`.
- State updates from an async iterable (a streaming reply) are ordinary `setState` calls; batch per event, not per character, if a stream is fast.

## Testing

`testRender(node, options)` from `@opentui/react/test-utils` renders into an in-memory test renderer and returns a `TestRendererSetup`:

- `renderer`, `renderOnce()`, `flush()`, `waitFor(predicate)`, `waitForFrame(frame => boolean)` (resolves with the frame), `waitForVisualIdle()`, `captureCharFrame()` (the screen as text), `captureSpans()` (with colors), `resize(w, h)`.
- `mockInput`: `typeText(text)`, `pressKey(key, { ctrl, shift, meta })`, `pressKeys([...])`, `pressEnter()`, `pressCtrlC()`, `pasteBracketedText(text)`. `mockMouse` for clicks.
- Options are `CliRendererConfig` plus `width`, `height`, `kittyKeyboard`.

It runs under `bun test` only in this repo: `@opentui/react/test-utils.js` is a Bun build (`// @bun`), `@opentui/core/testing` resolves its `bun` export condition, and vitest excludes `tests/tui/`. `testRender` sets `IS_REACT_ACT_ENVIRONMENT` and wraps the first render in `act`; its `onDestroy` unmounts the root. Call `renderer.destroy()` after each test: the test renderer installs the same process handlers as a real one, and they accumulate across tests otherwise.

A component test passes a fake `UiBridge` (a plain object whose `ask` returns a promise), types, waits for the frame, and asserts on `captureCharFrame()` text. Wait with `waitForScreen(setup, (f) => f.includes("..."))` from `tests/tui/render.ts`, not a fixed number of `renderOnce()` calls: `waitForFrame` gives up as soon as the renderer has nothing scheduled, before React commits a state update that arrives from a promise.

## Common mistakes

- Writing to stdout or stderr from a component: it lands on top of the rendered screen. Show it in the UI; logs go to the log file only while the TUI runs.
- Creating a renderer outside `launch.tsx`, or without releasing it: the terminal stays in raw mode and the alternate screen after exit.
- Leaving OpenTUI's defaults for `exitOnCtrlC`/`exitSignals`: the process exits before cleanup runs, with the wrong code.
- A hex color in a component instead of a `theme` token (lint fails).
- Ink habits: `<Box>`/`<Text>` components, `useInput`, `useApp().exit()`. None exist here.

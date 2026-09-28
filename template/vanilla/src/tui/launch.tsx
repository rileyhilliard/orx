import { type CliRendererConfig, createCliRenderer, resolveRenderLib } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Cause, Effect, Option } from "effect";
import { loadConfig } from "../config";
import { ask } from "../core/ask";
import { usageLine } from "../core/format";
import { isAppError, retryableFor, TuiUnavailable } from "../errors";
import { TerminalLogging } from "../logging";
import { App } from "./app";
import type { UiBridge, UiError, UiReply } from "./types";

/**
 * Effect owns signals and exit: OpenTUI must not exit the process on Ctrl+C or a signal, or
 * cleanup wouldn't run and the exit code would be wrong. Ctrl+C is a keybinding that quits
 * (app.tsx). The console overlay is off: nothing in src/ writes to console.
 * tests/tui/launch.test.ts pins these.
 */
export const RENDERER_OPTIONS = {
  exitOnCtrlC: false,
  exitSignals: [],
  consoleMode: "disabled",
} satisfies CliRendererConfig;

/** What the bridge's programs need. */
type LaunchServices = Effect.Services<ReturnType<typeof ask>>;

const toUiError = (cause: Cause.Cause<unknown>): UiError => {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  return isAppError(failure)
    ? { message: failure.message, retryable: retryableFor(failure) }
    : { message: "Something went wrong inside orx; the log has the details.", retryable: true };
};

/**
 * The UiBridge over the real programs, bound to the current services: what the components get
 * instead of Effect. `quit` is called when the user quits. A tagged error is shown in the UI;
 * anything else is logged once here, since components can't log.
 * tests/tui/closed-loop.test.tsx drives this with a test renderer.
 */
export const makeBridge = (quit: () => void) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<LaunchServices>();
    const { defaultModel } = yield* loadConfig;
    const bridge: UiBridge = {
      model: defaultModel,
      ask: (prompt) =>
        Effect.runPromiseWith(context)(
          ask(prompt).pipe(
            Effect.map(
              (result): UiReply => ({
                type: "reply",
                text: result.text,
                usage: usageLine(result),
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.as(
                isAppError(cause.reasons.find(Cause.isFailReason)?.error)
                  ? Effect.void
                  : Effect.logError("ui ask failed", cause),
                { type: "error", error: toUiError(cause) } satisfies UiReply,
              ),
            ),
          ),
        ),
      quit,
    };
    return bridge;
  });

const tuiUnavailable = (error: unknown) =>
  new TuiUnavailable({
    message: `The terminal UI couldn't start: ${String(error)}. \`orx doctor --tui\` checks it; \`orx ask\` works without it.`,
  });

const createRenderer = Effect.tryPromise({
  try: () => createCliRenderer(RENDERER_OPTIONS),
  catch: tuiUnavailable,
});

/**
 * `orx ui`: runs the TUI until the user quits. The renderer is a scoped resource, so it is
 * destroyed (and the terminal restored) however this ends, including interruption by SIGINT.
 * While it runs, logs go only to the log file: the TUI owns the terminal.
 */
export const launchUi = Effect.gen(function* () {
  let quit: () => void = () => {};
  const quitting = new Promise<void>((resolve) => {
    quit = resolve;
  });
  const bridge = yield* makeBridge(() => quit());
  const renderer = yield* Effect.acquireRelease(createRenderer, (r) =>
    Effect.sync(() => r.destroy()),
  );
  createRoot(renderer).render(<App bridge={bridge} />);
  yield* Effect.promise(() => quitting);
}).pipe(Effect.scoped, Effect.provideService(TerminalLogging, false));

/**
 * `orx doctor --tui`: loads OpenTUI's native library (the part a bad build or platform breaks)
 * and, at a terminal, creates and destroys a renderer.
 */
export const probeTui = (interactive: boolean) =>
  Effect.gen(function* () {
    yield* Effect.try({ try: () => resolveRenderLib(), catch: tuiUnavailable });
    if (!interactive) return { nativeLib: true, renderer: Option.none<boolean>() };
    yield* Effect.acquireRelease(createRenderer, (r) => Effect.sync(() => r.destroy()));
    return { nativeLib: true, renderer: Option.some(true) };
  }).pipe(Effect.scoped, Effect.provideService(TerminalLogging, false));

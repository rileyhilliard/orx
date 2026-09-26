import { type CliRendererConfig, createCliRenderer, resolveRenderLib } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Cause, Effect, FileSystem, Option, Stream } from "effect";
import type { ChatMessage, StoredChat } from "~/schemas";
import { loadChat, sendMessage, type TurnEvent } from "../core/chat";
import { chatToMarkdown } from "../core/export";
import { usageLine } from "../core/format";
import { listModels } from "../core/models";
import { isAppError, retryableFor } from "../errors";
import { TerminalLogging } from "../logging";
import { App } from "./app";
import type { ChatBridge, UiError, UiEvent, UiMessage } from "./types";

/**
 * Effect owns signals and exit: OpenTUI must not exit the process on Ctrl+C or a signal, or
 * the chat wouldn't be saved and the exit code would be wrong. Ctrl+C is a keybinding that
 * quits (app.tsx). The console overlay is off: nothing in src/ writes to console.
 * tests/tui/launch.test.ts pins these.
 */
export const RENDERER_OPTIONS = {
  exitOnCtrlC: false,
  exitSignals: [],
  consoleMode: "disabled",
} satisfies CliRendererConfig;

/** What a turn, the models list, and export need (whatever sendMessage requires, and more). */
type LaunchServices =
  | Stream.Services<ReturnType<typeof sendMessage>>
  | Effect.Services<typeof listModels>
  | Effect.Services<ReturnType<typeof loadChat>>
  | FileSystem.FileSystem;

const toUiMessage = (message: ChatMessage): UiMessage =>
  message.role === "user"
    ? { role: "user", text: message.text, tools: [] }
    : {
        role: "assistant",
        text: message.text,
        tools: message.tools.map((t) => ({ name: t.name, input: JSON.stringify(t.input) })),
        usage: usageLine(message),
      };

const toUiEvent = (event: TurnEvent): ReadonlyArray<UiEvent> => {
  switch (event.type) {
    case "text":
      return [{ type: "text", delta: event.delta }];
    case "tool-call":
      return [{ type: "tool", call: { name: event.name, input: JSON.stringify(event.input) } }];
    case "tool-result":
      return [];
    case "finish":
      return [{ type: "done", usage: usageLine(event.reply) }];
  }
};

const toUiError = (cause: Cause.Cause<unknown>): UiError => {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  return isAppError(failure)
    ? { message: failure.message, retryable: retryableFor(failure) }
    : { message: "Something went wrong inside orx; the log has the details.", retryable: true };
};

/**
 * The ChatBridge over the real programs, bound to the current services: what the components
 * get instead of Effect. `quit` is called when the user quits. tests/tui/closed-loop.test.tsx
 * drives this with a test renderer.
 */
export const makeBridge = (initial: StoredChat, quit: () => void) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<LaunchServices>();
    const fs = yield* FileSystem.FileSystem;
    const run = Effect.runPromiseWith(context);
    let chat = initial;
    const bridge: ChatBridge = {
      chatId: chat.id,
      initialModel: chat.model,
      history: chat.messages.map(toUiMessage),
      send: (text, model) =>
        Stream.suspend(() => sendMessage(chat, text, model)).pipe(
          Stream.flatMap((event) => Stream.fromIterable(toUiEvent(event))),
          Stream.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Stream.empty;
            const failed: UiEvent = { type: "error", error: toUiError(cause) };
            return Stream.make(failed);
          }),
          Stream.ensuring(
            loadChat(chat.id).pipe(
              Effect.tap((saved) =>
                Effect.sync(() => {
                  chat = saved;
                }),
              ),
              Effect.ignore,
            ),
          ),
          Stream.toAsyncIterableWith(context),
        ),
      listModels: () =>
        run(
          listModels.pipe(
            Effect.map((list) => ({
              available: list.available,
              models: list.models.map((m) => ({ id: m.id, name: m.name })),
            })),
            Effect.orElseSucceed(() => ({ available: false, models: [] })),
          ),
        ),
      exportMarkdown: () => {
        const file = `orx-chat-${chat.id.slice(0, 8)}.md`;
        return run(
          fs.writeFileString(file, chatToMarkdown(chat)).pipe(Effect.orDie, Effect.as(file)),
        );
      },
      quit,
    };
    return bridge;
  });

/**
 * `orx chat`: runs the TUI until the user quits. The renderer is a scoped resource, so it is
 * destroyed (and the terminal restored) however this ends, including interruption by SIGINT.
 * While it runs, logs go only to the log file: the TUI owns the terminal.
 */
export const launchChat = (initial: StoredChat) =>
  Effect.gen(function* () {
    let quit: () => void = () => {};
    const quitting = new Promise<void>((resolve) => {
      quit = resolve;
    });
    const bridge = yield* makeBridge(initial, () => quit());
    const renderer = yield* Effect.acquireRelease(
      Effect.promise(() => createCliRenderer(RENDERER_OPTIONS)),
      (r) => Effect.sync(() => r.destroy()),
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
    yield* Effect.try({
      try: () => resolveRenderLib(),
      catch: (error) => new Error(`OpenTUI's native library didn't load: ${String(error)}`),
    });
    if (!interactive) return { nativeLib: true, renderer: Option.none<boolean>() };
    yield* Effect.acquireRelease(
      Effect.promise(() => createCliRenderer(RENDERER_OPTIONS)),
      (r) => Effect.sync(() => r.destroy()),
    );
    return { nativeLib: true, renderer: Option.some(true) };
  }).pipe(Effect.scoped, Effect.provideService(TerminalLogging, false));

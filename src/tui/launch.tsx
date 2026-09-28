import { type CliRendererConfig, createCliRenderer, resolveRenderLib } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Cause, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChatId, type ChatMessage, type StoredChat } from "~/schemas";
import { loadChat, newChat, sendMessage, type TurnEvent } from "../core/chat";
import { expandCommand } from "../core/commands";
import { chatToMarkdown } from "../core/export";
import { writeUserFile } from "../core/files";
import { usageLine } from "../core/format";
import { listModels } from "../core/models";
import { expandSkill, loadSlash } from "../core/skills";
import { isAppError, retryableFor, TuiUnavailable } from "../errors";
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
  | Effect.Services<ReturnType<typeof loadSlash>>
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

/** Whatever failed a turn, as the log line for a defect (a tagged error is shown, not logged). */
const logDefect = (cause: Cause.Cause<unknown>) =>
  isAppError(cause.reasons.find(Cause.isFailReason)?.error)
    ? Effect.void
    : Effect.logError("chat turn failed", cause);

/**
 * The ChatBridge over the real programs, bound to the current services: what the components
 * get instead of Effect. `quit` is called when the user quits. `stopTurns` ends any reply still
 * streaming (saved as interrupted); launchChat calls it when its scope closes, so a signal
 * saves the reply too. tests/tui/closed-loop.test.tsx drives this with a test renderer.
 * `root` is where custom commands and skills load from (`<root>/.orx/`).
 */
export const makeBridge = (initial: StoredChat, quit: () => void, root: string = process.cwd()) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<LaunchServices>();
    const fs = yield* FileSystem.FileSystem;
    const run = Effect.runPromiseWith(context);
    let chat = initial;
    // Commands and skills load once per session; the loader logs its warnings.
    const slash = yield* Effect.cached(
      loadSlash(root).pipe(
        Effect.catchCause((cause) =>
          Effect.as(Effect.logError("loading commands and skills failed", cause), {
            commands: [],
            skills: [],
            warnings: [],
          }),
        ),
      ),
    );
    // The turns' iterators run on their own fibers, outside launchChat's scope.
    const active = new Set<AsyncIterator<UiEvent>>();
    const tracked = (iterable: AsyncIterable<UiEvent>): AsyncIterable<UiEvent> => ({
      [Symbol.asyncIterator]: () => {
        const it = iterable[Symbol.asyncIterator]();
        active.add(it);
        const done = <T,>(result: T) => {
          active.delete(it);
          return result;
        };
        return {
          next: () => it.next().then((r) => (r.done ? done(r) : r)),
          return: () =>
            (it.return?.() ?? Promise.resolve({ done: true, value: undefined })).then(done),
        };
      },
    });
    const stopTurns = () =>
      Promise.allSettled([...active].map((it) => it.return?.())).then(() => active.clear());
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
            return Stream.unwrap(Effect.as(logDefect(cause), Stream.make(failed)));
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
          tracked,
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
          Effect.gen(function* () {
            const existed = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
            yield* writeUserFile(file, chatToMarkdown(chat));
            return `${existed ? "Overwrote" : "Exported to"} ${file}`;
          }).pipe(
            Effect.catchCause((cause) => {
              const error = cause.reasons.find(Cause.isFailReason)?.error;
              if (isAppError(error)) return Effect.succeed(`Export failed: ${error.message}`);
              return Effect.as(
                Effect.logError("chat export failed", cause),
                "Export failed; the log has the details.",
              );
            }),
          ),
        );
      },
      quit,
      listCommands: () =>
        run(
          Effect.map(slash, (s) =>
            s.commands.map((c) => ({ name: c.name, description: c.description })),
          ),
        ),
      listSkills: () =>
        run(
          Effect.map(slash, (s) =>
            s.skills.map((k) => ({ name: k.name, description: k.description })),
          ),
        ),
      expandCommand: (name, args) =>
        run(
          Effect.map(slash, (s) => {
            const command = s.commands.find((c) => c.name === name);
            if (command) return expandCommand(command, args);
            const skill = s.skills.find((k) => k.name === name);
            return skill ? { text: expandSkill(skill, args) } : undefined;
          }),
        ),
      newChat: () =>
        run(
          Effect.sync(() => {
            chat = newChat(Schema.decodeSync(ChatId)(crypto.randomUUID()), chat.model);
            return chat.id;
          }),
        ),
    };
    return { bridge, stopTurns };
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
    const { bridge, stopTurns } = yield* makeBridge(initial, () => quit());
    const renderer = yield* Effect.acquireRelease(createRenderer, (r) =>
      Effect.sync(() => r.destroy()),
    );
    // Released before the renderer: a reply still streaming is stopped and saved first.
    yield* Effect.addFinalizer(() => Effect.promise(stopTurns));
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

import { type CliRendererConfig, createCliRenderer, resolveRenderLib } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Cause, Effect, Fiber, FileSystem, Option, Schema, Stream } from "effect";
import { ChatId, type ChatMessage, type StoredChat } from "~/schemas";
import { loadChat, newChat, sendMessage, type TurnEvent, type TurnToolkit } from "../core/chat";
import { expandSessionCommand } from "../core/commands";
import { chatToMarkdown } from "../core/export";
import { writeUserFile } from "../core/files";
import { usageLine } from "../core/format";
import { listModels } from "../core/models";
import { expandSkill, loadSlash } from "../core/skills";
import { isAppError, retryableFor, TuiUnavailable } from "../errors";
import { TerminalLogging } from "../logging";
import { FileState } from "../services/file-state";
import { Permissions } from "../services/permissions";
import { App } from "./app";
import { summarizeTool, toolStatus } from "./tool-summary";
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

/**
 * A coding session's root, tools, and system prompt (see `prepareSession`), and the `@` file
 * mention programs, which need the session's Workspace and FileState (M).
 */
export interface SessionOptions<R, M = never> {
  readonly root: string;
  readonly toolkit: TurnToolkit<R>;
  readonly systemPrompt: string;
  readonly listFiles: Effect.Effect<ReadonlyArray<string>, never, M>;
  /** The `@path` attachments for a message (`mentionAttachments`), `""` for none. */
  readonly attachFiles: (text: string) => Effect.Effect<string, never, M>;
}

/**
 * What a turn, the models list, and export need (whatever sendMessage requires besides the
 * session's tools, and more).
 */
type LaunchServices =
  | Stream.Services<ReturnType<typeof sendMessage<never>>>
  | Effect.Services<typeof listModels>
  | Effect.Services<ReturnType<typeof loadChat>>
  | Effect.Services<ReturnType<typeof loadSlash>>
  | Effect.Services<ReturnType<typeof expandSessionCommand>>
  | Permissions
  | FileState
  | FileSystem.FileSystem;

const toUiMessage = (message: ChatMessage): UiMessage =>
  message.role === "user"
    ? { role: "user", text: message.text, tools: [] }
    : {
        role: "assistant",
        text: message.text,
        tools: message.tools.map((t) => ({
          name: t.name,
          input: JSON.stringify(t.input),
          status: toolStatus(t.output, t.isFailure),
          ...summarizeTool(t.name, t.input, t.output, t.isFailure),
        })),
        usage: usageLine(message),
      };

/**
 * A turn's events for the components. `inputs` holds each tool call's input until its result
 * arrives, for the result's summary line; the caller gives each turn a fresh map.
 */
const toUiEvent =
  (inputs: Map<string, unknown>) =>
  (event: TurnEvent): ReadonlyArray<UiEvent> => {
    switch (event.type) {
      case "text":
        return [{ type: "text", delta: event.delta }];
      case "tool-call":
        inputs.set(event.id, event.input);
        return [
          {
            type: "tool",
            call: {
              id: event.id,
              name: event.name,
              input: JSON.stringify(event.input),
              status: "running",
            },
          },
        ];
      case "tool-result": {
        const summary = summarizeTool(
          event.name,
          inputs.get(event.id),
          event.output,
          event.isFailure,
        );
        inputs.delete(event.id);
        const status = toolStatus(event.output, event.isFailure);
        return [{ type: "tool-result", id: event.id, status, ...summary }];
      }
      case "note":
        return [{ type: "note", message: event.message }];
      case "approval-request": {
        const { type: _, ...request } = event;
        return [{ type: "approval", request }];
      }
      case "approval-cancelled":
        return [{ type: "approval-cancelled", id: event.id }];
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
 * `session` is the coding session (`prepareSession`): its root is where custom commands and
 * skills load from (`<root>/.orx/`), and turns use its tools and system prompt.
 */
export const makeBridge = <R = never, M = never>(
  initial: StoredChat,
  quit: () => void,
  session: SessionOptions<R, M>,
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<LaunchServices | R | M>();
    const fs = yield* FileSystem.FileSystem;
    const run = Effect.runPromiseWith(context);
    // The session's approval gate, and what its model has read (a new chat starts unread).
    const permissions = yield* Permissions;
    const fileState = yield* FileState;
    let chat = initial;
    // Commands and skills load once per session; the loader logs its warnings.
    const slash = yield* Effect.cached(
      loadSlash(session.root).pipe(
        Effect.catchCause((cause) =>
          Effect.as(Effect.logError("loading commands and skills failed", cause), {
            commands: [],
            skills: [],
            warnings: [],
          }),
        ),
      ),
    );
    // The `@` picker's file list: the last walk answers at once, and each open refreshes it.
    let files: Promise<ReadonlyArray<string>> | undefined;
    const walkFiles = () =>
      run(
        session.listFiles.pipe(
          Effect.catchCause((cause) =>
            Effect.as(Effect.logError("listing workspace files failed", cause), []),
          ),
        ),
      );
    // A message's `@path` attachments; a failure to read them sends the message without them.
    const attach = (text: string) =>
      session
        .attachFiles(text)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.as(Effect.logError("attaching @ files failed", cause), ""),
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
      // The chat keeps what was typed; the model also gets the `@path` files' contents,
      // saved beside the text as the message's attachments.
      send: (text, model) => {
        // This turn's tool inputs, so no call outlives its turn (an interrupted one included).
        const inputs = new Map<string, unknown>();
        return Stream.unwrap(
          Effect.map(attach(text), (attachments) =>
            sendMessage<R>(chat, text, model, {
              toolkit: session.toolkit,
              systemPrompt: session.systemPrompt,
              ...(attachments === "" ? {} : { attachments }),
            }),
          ),
        ).pipe(
          Stream.flatMap((event) => Stream.fromIterable(toUiEvent(inputs)(event))),
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
              // The turn's own outcome is already shown; a failed reload keeps the old chat.
              Effect.catchCause((cause) =>
                Effect.logWarning("reloading the chat after a turn failed", cause),
              ),
            ),
          ),
          Stream.toAsyncIterableWith(context),
          tracked,
        );
      },
      listModels: () =>
        run(
          listModels.pipe(
            Effect.map((list) => ({
              available: list.available,
              // The session needs tool calling: models without it aren't offered.
              models: list.models
                .filter((m) => m.supportsTools)
                .map((m) => ({ id: m.id, name: m.name })),
            })),
            // The picker falls back to the current model; the log says why.
            Effect.catchCause((cause) =>
              Effect.as(Effect.logWarning("listing models failed", cause), {
                available: false,
                models: [],
              }),
            ),
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
          Effect.gen(function* () {
            const { commands, skills } = yield* slash;
            const command = commands.find((c) => c.name === name);
            if (command) {
              // A command's own model must be able to call tools, like the session's.
              return yield* expandSessionCommand(command, args).pipe(
                Effect.catchCause((cause) => {
                  const error = cause.reasons.find(Cause.isFailReason)?.error;
                  if (isAppError(error))
                    return Effect.succeed({ error: `/${name}: ${error.message}` });
                  return Effect.as(Effect.logError("expanding a command failed", cause), {
                    error: `/${name} failed; the log has the details.`,
                  });
                }),
              );
            }
            const skill = skills.find((k) => k.name === name);
            return skill ? { text: expandSkill(skill, args) } : undefined;
          }),
        ),
      listFiles: () => {
        const last = files;
        const next = walkFiles();
        files = next;
        return last ?? next;
      },
      answer: (id, decision) => run(permissions.answer(id, decision)),
      setMode: (mode) => run(permissions.setMode(mode)),
      watchMode: (onMode) => {
        const fiber = Effect.runForkWith(context)(
          permissions.modeChanges.pipe(
            Stream.runForEach((mode) => Effect.sync(() => onMode(mode))),
          ),
        );
        return () => void run(Fiber.interrupt(fiber));
      },
      newChat: () =>
        run(
          Effect.andThen(
            fileState.reset,
            Effect.sync(() => {
              chat = newChat(Schema.decodeSync(ChatId)(crypto.randomUUID()), chat.model, chat.cwd);
              return chat.id;
            }),
          ),
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
 * Bare `orx`: runs the TUI until the user quits. The renderer is a scoped resource, so it is
 * destroyed (and the terminal restored) however this ends, including interruption by SIGINT.
 * While it runs, logs go only to the log file: the TUI owns the terminal.
 */
export const launchChat = <R = never, M = never>(
  initial: StoredChat,
  session: SessionOptions<R, M>,
) =>
  Effect.gen(function* () {
    let quit: () => void = () => {};
    const quitting = new Promise<void>((resolve) => {
      quit = resolve;
    });
    const { bridge, stopTurns } = yield* makeBridge(initial, () => quit(), session);
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

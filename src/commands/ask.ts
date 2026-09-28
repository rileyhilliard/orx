import { Effect, Option, Stream } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { AskEvent } from "~/schemas";
import { Prompt } from "~/schemas";
import { newChat, sendMessage, type TurnEvent } from "../core/chat";
import { noteLine, usageLine } from "../core/format";
import { decodeInput } from "../core/input";
import { resolveModel } from "../core/models";
import { prepareSession } from "../core/session";
import { readPipedStdin } from "../core/stdin";
import { errorBody } from "../errors";
import { Llm } from "../services/Llm";
import { Output } from "../services/Output";
import { PERMISSION_MODES } from "../services/permissions";
import { cwdFlag, jsonFlag, modelFlag, newChatId } from "./shared";

const words = Argument.String("prompt").pipe(
  Argument.withDescription("The prompt (or pipe it on stdin)"),
  Argument.variadic(),
);

const agent = Flag.Boolean("agent").pipe(
  Flag.withDescription("Give the model the workspace tools (read, edit, bash, ...), as in `orx`"),
  Flag.withDefault(false),
);

const permissionMode = Flag.Literals("permission-mode", PERMISSION_MODES).pipe(
  Flag.withDescription(
    "With --agent: what runs without asking. Nobody can be asked here, so `default` denies every write, edit, and command",
  ),
  Flag.withDefault("default"),
);

/**
 * One-shot, pipe-friendly: streams the reply to stdout, a usage line to stderr, and saves the
 * exchange as a chat (`orx export <id>`). With --json, NDJSON AskEvents on stdout. With
 * --agent, the model gets the session's tools in the workspace (`--cwd`), and whatever would
 * ask for approval is decided by --permission-mode instead.
 */
export const ask = Command.make(
  "ask",
  {
    words,
    json: jsonFlag,
    model: modelFlag,
    cwd: cwdFlag,
    agent,
    permissionMode,
  },
  ({ words, json, model, cwd, agent, permissionMode }) =>
    Effect.gen(function* () {
      const out = yield* Output;
      yield* (yield* Llm).ready;
      const piped = yield* readPipedStdin;
      const text = yield* decodeInput(Prompt)(
        [words.join(" "), piped].filter((part) => part && part.trim() !== "").join("\n\n"),
      );
      const modelId = yield* resolveModel(Option.getOrUndefined(model));
      const chat = newChat(yield* newChatId, modelId);
      const emit = (event: AskEvent) => out.json(event);

      const onEvent = (event: TurnEvent): Effect.Effect<void> => {
        // Headless permissions never ask, so these don't occur; nothing to show if they did.
        if (event.type === "approval-request" || event.type === "approval-cancelled") {
          return Effect.void;
        }
        if (json) {
          if (event.type === "finish") {
            const { reply } = event;
            return emit({
              type: "done",
              chatId: chat.id,
              model: reply.model,
              provider: reply.provider,
              finishReason: reply.finishReason ?? "unknown",
              usage: reply.usage ?? { inputTokens: 0, outputTokens: 0 },
            });
          }
          return emit(event);
        }
        switch (event.type) {
          case "text":
            return out.write(event.delta);
          case "tool-call":
            return out.note(noteLine(`→ ${event.name}(${JSON.stringify(event.input)})`, out.color));
          case "tool-result":
            return Effect.void;
          case "note":
            return out.note(noteLine(event.message, out.color));
          case "finish":
            return out
              .write(event.reply.text.endsWith("\n") ? "" : "\n")
              .pipe(
                Effect.andThen(
                  out.note(noteLine(`${usageLine(event.reply)} · chat ${chat.id}`, out.color)),
                ),
              );
        }
      };

      if (agent) {
        const session = yield* prepareSession(cwd, { mode: permissionMode, headless: true });
        yield* sendMessage(chat, text, modelId, {
          toolkit: session.toolkit,
          systemPrompt: session.systemPrompt,
        }).pipe(Stream.runForEach(onEvent), Effect.provide(session.layer));
      } else {
        yield* sendMessage(chat, text, modelId).pipe(Stream.runForEach(onEvent));
      }
    }).pipe(
      // Every failure after parsing ends --json output with one `error` event (AskEvent).
      Effect.tapError((error) =>
        json
          ? Effect.gen(function* () {
              const event: AskEvent = { type: "error", error: errorBody(error) };
              yield* (yield* Output).json(event);
            })
          : Effect.void,
      ),
    ),
).pipe(Command.withDescription("Send one prompt and stream the reply (pipe-friendly)"));

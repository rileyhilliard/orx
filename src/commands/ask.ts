import { Effect, Option, Stream } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import type { AskEvent } from "~/schemas";
import { Prompt } from "~/schemas";
import { newChat, sendMessage } from "../core/chat";
import { noteLine, usageLine } from "../core/format";
import { decodeInput } from "../core/input";
import { resolveModel } from "../core/models";
import { readPipedStdin } from "../core/stdin";
import { errorBody } from "../errors";
import { Llm } from "../services/Llm";
import { Output } from "../services/Output";
import { jsonFlag, modelFlag, newChatId } from "./shared";

const words = Argument.String("prompt").pipe(
  Argument.withDescription("The prompt (or pipe it on stdin)"),
  Argument.variadic(),
);

/**
 * One-shot, pipe-friendly: streams the reply to stdout, a usage line to stderr, and saves the
 * exchange as a chat (`orx export <id>`). With --json, NDJSON AskEvents on stdout.
 */
export const ask = Command.make(
  "ask",
  { words, json: jsonFlag, model: modelFlag },
  ({ words, json, model }) =>
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

      yield* sendMessage(chat, text, modelId).pipe(
        Stream.runForEach((event) => {
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
              return out.note(
                noteLine(`→ ${event.name}(${JSON.stringify(event.input)})`, out.color),
              );
            case "tool-result":
              return Effect.void;
            case "finish":
              return out
                .write(event.reply.text.endsWith("\n") ? "" : "\n")
                .pipe(
                  Effect.andThen(
                    out.note(noteLine(`${usageLine(event.reply)} · chat ${chat.id}`, out.color)),
                  ),
                );
          }
        }),
      );
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

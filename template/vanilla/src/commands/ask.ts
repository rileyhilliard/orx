import { Effect, Option } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { Prompt } from "~/schemas";
import { ask as askModel } from "../core/ask";
import { noteLine, usageLine } from "../core/format";
import { decodeInput } from "../core/input";
import { readPipedStdin } from "../core/stdin";
import { Llm } from "../services/Llm";
import { Output } from "../services/Output";
import { jsonFlag, modelFlag } from "./shared";

const words = Argument.String("prompt").pipe(
  Argument.withDescription("The prompt (or pipe it on stdin)"),
  Argument.variadic(),
);

/**
 * The example model command: one prompt, one reply on stdout, a usage line on stderr. With
 * --json, one AskResult object on stdout.
 */
export const ask = Command.make(
  "ask",
  { words, json: jsonFlag, model: modelFlag },
  ({ words, json, model }) =>
    Effect.gen(function* () {
      const out = yield* Output;
      yield* (yield* Llm).ready;
      const piped = yield* readPipedStdin;
      const prompt = yield* decodeInput(Prompt)(
        [words.join(" "), piped].filter((part) => part && part.trim() !== "").join("\n\n"),
      );
      const result = yield* askModel(prompt, Option.getOrUndefined(model));
      if (json) return yield* out.json(result);
      yield* out.write(result.text.endsWith("\n") ? result.text : `${result.text}\n`);
      yield* out.note(noteLine(usageLine(result), out.color));
    }),
).pipe(Command.withDescription("Send one prompt to a model and print the reply"));

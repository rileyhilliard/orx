import { Effect, Option } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { ExtractText } from "~/schemas";
import { extractContact } from "../core/extract";
import { decodeInput } from "../core/input";
import { resolveModel } from "../core/models";
import { readPipedStdin } from "../core/stdin";
import { Llm } from "../services/Llm";
import { Output } from "../services/Output";
import { jsonFlag, modelFlag } from "./shared";

const words = Argument.String("text").pipe(
  Argument.withDescription("Free text with contact details (or pipe it on stdin)"),
  Argument.variadic(),
);

/** The structured-output example: prints the Contact the model pulled out of the text. */
export const extract = Command.make(
  "extract",
  { words, json: jsonFlag, model: modelFlag },
  ({ words, json, model }) =>
    Effect.gen(function* () {
      const out = yield* Output;
      yield* (yield* Llm).ready;
      const piped = yield* readPipedStdin;
      const text = yield* decodeInput(ExtractText)([words.join(" "), piped ?? ""].join("\n"));
      const modelId = yield* resolveModel(Option.getOrUndefined(model));
      const { contact } = yield* extractContact(text, modelId);
      if (json) return yield* out.json(contact);
      for (const [key, value] of Object.entries(contact)) {
        yield* out.line(`${key.padEnd(8)} ${value ?? "-"}`);
      }
    }),
).pipe(Command.withDescription("Extract contact details from text (structured output)"));

import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { modelsTable, noteLine } from "../core/format";
import { listModels, searchModels } from "../core/models";
import { Output } from "../services/Output";
import { jsonFlag } from "./shared";

const query = Argument.String("query").pipe(
  Argument.withDescription("Words that must all appear in the model id or name"),
  Argument.variadic(),
);

export const models = Command.make("models", { query, json: jsonFlag }, ({ query, json }) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const list = yield* listModels;
    const matches = searchModels(list.models, query.join(" "));
    if (json) return yield* out.json({ ...list, models: matches });
    if (!list.available) {
      yield* out.note(`Couldn't fetch the models list; the default is ${list.defaultModel}.`);
      return;
    }
    if (matches.length === 0) {
      yield* out.note(`No model matches "${query.join(" ")}".`);
      return;
    }
    yield* out.line(modelsTable(matches, list.defaultModel));
    yield* out.note(
      noteLine(`${matches.length} models · * is the default (OPENROUTER_MODEL)`, out.color),
    );
  }),
).pipe(Command.withDescription("List or search OpenRouter models"));

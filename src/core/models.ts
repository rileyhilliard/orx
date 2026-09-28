import { Effect } from "effect";
import type { ModelInfo, ModelsList } from "~/schemas";
import { loadConfig } from "../config";
import { UnknownModel } from "../errors";
import { OpenRouterModels } from "../services/OpenRouterModels";

/**
 * The models list for `orx models` and the TUI picker. When OpenRouter can't be reached it
 * holds only the default model, so the picker still works offline.
 */
export const listModels = Effect.gen(function* () {
  const config = yield* loadConfig;
  const openRouter = yield* OpenRouterModels;
  return yield* openRouter.list.pipe(
    Effect.map(
      (models): ModelsList => ({ models, defaultModel: config.defaultModel, available: true }),
    ),
    Effect.catchTag("UpstreamUnavailable", (error) =>
      Effect.logWarning("Models list unavailable", error.message).pipe(
        Effect.as<ModelsList>({ models: [], defaultModel: config.defaultModel, available: false }),
      ),
    ),
  );
});

/** Edit distance, for "did you mean" on a mistyped model id. */
const distance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
};

/** Up to three ids that match the words of `requested`, or else are a few typos away from it. */
const closestIds = (models: ReadonlyArray<ModelInfo>, requested: string) => {
  const matches = searchModels(models, requested);
  if (matches.length > 0) return matches.slice(0, 3).map((model) => model.id);
  const limit = Math.max(2, Math.floor(requested.length / 4));
  return models
    .map((model) => ({ id: model.id, d: distance(model.id, requested) }))
    .filter(({ d }) => d <= limit)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ id }) => id);
};

/**
 * Models whose id or name contains every word of the query (case-insensitive), best first:
 * an id that starts with the query, then id matches, then name-only matches.
 */
export const searchModels = (
  models: ReadonlyArray<ModelInfo>,
  query: string,
): ReadonlyArray<ModelInfo> => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return models;
  const q = query.toLowerCase().trim();
  const rank = (model: ModelInfo) => {
    const id = model.id.toLowerCase();
    if (id.startsWith(q) || id.split("/")[1]?.startsWith(q)) return 0;
    return words.every((word) => id.includes(word)) ? 1 : 2;
  };
  return models
    .filter((model) => {
      const haystack = `${model.id} ${model.name}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .map((model, index) => ({ model, index, rank: rank(model) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
};

/**
 * The model a command runs on. No model given: OPENROUTER_MODEL. A named model must be in
 * OpenRouter's list, where a variant suffix (`:online`, `:nitro`, `:floor`) counts as its base
 * id. The default is always accepted, and when the list can't be fetched a named model is
 * passed through with a warning (OpenRouter rejects an unknown one itself).
 */
export const resolveModel = (requested: string | undefined) =>
  Effect.gen(function* () {
    const config = yield* loadConfig;
    if (requested === undefined || requested === config.defaultModel) return config.defaultModel;
    const openRouter = yield* OpenRouterModels;
    const listed = yield* openRouter.list.pipe(
      Effect.map((models) => ({ models })),
      Effect.catchTag("UpstreamUnavailable", (error) =>
        Effect.as(
          Effect.logWarning("Models list unavailable; using the model as given", error.message),
          undefined,
        ),
      ),
    );
    if (listed === undefined) return requested;
    const { models } = listed;
    const base = requested.split(":", 1)[0];
    if (!models.some((model) => model.id === requested || model.id === base)) {
      const close = closestIds(models, requested);
      return yield* new UnknownModel({
        message: `Unknown model: ${requested}.${close.length > 0 ? ` Did you mean ${close.join(", ")}?` : ""} \`orx models\` lists them.`,
        model: requested,
      });
    }
    return requested;
  });

/**
 * `resolveModel` for the coding agent (the session and `ask --agent`), which needs tool
 * calling: a model whose `supported_parameters` lack `tools` is UnknownModel (exit 2) with the
 * reason, the default model included. When the models list is unavailable (logged as a
 * warning), or doesn't have the model (the default is trusted), the model is used as resolved.
 */
export const resolveToolModel = (requested: string | undefined) =>
  Effect.gen(function* () {
    const modelId = yield* resolveModel(requested);
    const models = yield* (yield* OpenRouterModels).list.pipe(
      Effect.catchTag("UpstreamUnavailable", (error) =>
        Effect.as(
          Effect.logWarning(
            `Models list unavailable; can't check that ${modelId} supports tool calling`,
            error.message,
          ),
          [],
        ),
      ),
    );
    const base = modelId.split(":", 1)[0];
    const model = models.find((m) => m.id === modelId) ?? models.find((m) => m.id === base);
    if (model !== undefined && !model.supportsTools) {
      return yield* new UnknownModel({
        message: `${modelId} doesn't support tool calling, which the coding agent needs. Pick another with --model or OPENROUTER_MODEL.`,
        model: modelId,
      });
    }
    return modelId;
  });

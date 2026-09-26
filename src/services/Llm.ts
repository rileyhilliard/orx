import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Option } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import type { HttpClient } from "effect/unstable/http";
import { AppConfig, type AppConfigShape } from "../config";
import { type InvalidConfig, NotConfigured } from "../errors";

export interface LlmShape {
  /**
   * The language model for an OpenRouter model id, with the routing settings from config.
   * Fails with NotConfigured when there's no API key. Tests swap the whole service for a
   * scripted model (tests/helpers/mock-model.ts).
   */
  readonly languageModel: (
    modelId: string,
  ) => Effect.Effect<LanguageModel.LanguageModel, NotConfigured | InvalidConfig>;
}

/**
 * OpenRouter-specific request settings, all from config: fallback models (OpenRouter's `models`
 * array), provider routing, and the output cap. They go in every chat request body.
 */
export const openRouterSettings = (config: AppConfigShape) => ({
  ...(config.routing.fallbackModels.length > 0
    ? { models: [...config.routing.fallbackModels] }
    : {}),
  provider: {
    allow_fallbacks: config.routing.allowFallbacks,
    data_collection: config.routing.dataCollection,
    ...(Option.isSome(config.routing.providerSort)
      ? { sort: config.routing.providerSort.value }
      : {}),
    ...(config.routing.zdr ? { zdr: true } : {}),
  },
  max_tokens: config.limits.maxOutputTokens,
});

const make = Effect.gen(function* () {
  const { load } = yield* AppConfig;
  const http = yield* Effect.context<HttpClient.HttpClient>();
  // One client per process, built on first use (it needs the key, which --help doesn't).
  const client = yield* Effect.cached(
    Effect.gen(function* () {
      const config = yield* load;
      if (Option.isNone(config.apiKey)) {
        return yield* new NotConfigured({
          message:
            "OPENROUTER_API_KEY isn't set. Export it (or put it in .env when running from source) and run again.",
        });
      }
      return yield* OpenRouterClient.make({
        apiKey: config.apiKey.value,
        apiUrl: config.baseUrl,
        siteTitle: "orx",
      }).pipe(Effect.provideContext(http));
    }),
  );
  return {
    languageModel: (modelId: string) =>
      Effect.gen(function* () {
        const config = yield* load;
        const service = yield* client;
        return yield* OpenRouterLanguageModel.make({
          model: modelId,
          config: openRouterSettings(config),
        }).pipe(Effect.provideService(OpenRouterClient.OpenRouterClient, service));
      }),
  } satisfies LlmShape;
});

export class Llm extends Context.Service<Llm, LlmShape>()("orx/Llm") {
  static readonly layer = Layer.effect(Llm, make);

  /** Every model id resolves to the same (scripted) model. Records the ids asked for. */
  static readonly layerModel = (model: LanguageModel.LanguageModel, requested?: string[]) =>
    Layer.succeed(Llm, {
      languageModel: (modelId: string) =>
        Effect.sync(() => {
          requested?.push(modelId);
          return model;
        }),
    });
}

import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Option } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AppConfig, type AppConfigShape, DEFAULT_RELEASES_REPO } from "../config";
import { type InvalidConfig, NotConfigured } from "../errors";

export interface LlmShape {
  /**
   * The language model for an OpenRouter model id, with the routing settings from config.
   * Fails with NotConfigured when there's no API key. Tests use the real service against the
   * stub OpenRouter (tests/helpers/stub-openrouter.ts).
   */
  readonly languageModel: (
    modelId: string,
  ) => Effect.Effect<LanguageModel.LanguageModel, NotConfigured | InvalidConfig>;
  /**
   * Fails the way `languageModel` would without a key or with bad config, before a command
   * does anything slow (reading piped stdin, fetching the models list).
   */
  readonly ready: Effect.Effect<void, NotConfigured | InvalidConfig>;
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
    // Only endpoints that support every parameter sent. Every request orx makes needs this:
    // chat turns send tools (plain `ask` too: currentTime, unless the models list says the model
    // can't call them), extract sends a JSON response format.
    require_parameters: true,
    allow_fallbacks: config.routing.allowFallbacks,
    data_collection: config.routing.dataCollection,
    ...(Option.isSome(config.routing.providerSort)
      ? { sort: config.routing.providerSort.value }
      : {}),
    ...(config.routing.zdr ? { zdr: true } : {}),
  },
  max_tokens: config.limits.maxOutputTokens,
});

/**
 * App attribution (https://openrouter.ai/docs/app-attribution). The provider sets HTTP-Referer
 * and the legacy X-Title; the current title header and the category are added here.
 */
const attribution = {
  siteReferrer: `https://github.com/${DEFAULT_RELEASES_REPO}`,
  siteTitle: "orx",
  transformClient: HttpClient.mapRequest(
    HttpClientRequest.setHeaders({
      "X-OpenRouter-Title": "orx",
      "X-OpenRouter-Categories": "cli-agent",
    }),
  ),
};

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
        ...attribution,
      }).pipe(Effect.provideContext(http));
    }),
  );
  return {
    ready: Effect.asVoid(client),
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
}

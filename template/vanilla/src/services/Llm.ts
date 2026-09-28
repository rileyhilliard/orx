import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Option } from "effect";
import type { LanguageModel } from "effect/unstable/ai";
import type { HttpClient } from "effect/unstable/http";
import { AppConfig, type AppConfigShape } from "../config";
import { type InvalidConfig, NotConfigured } from "../errors";

export interface LlmShape {
  /**
   * The language model for an OpenRouter model id, with the request settings from config.
   * Fails with NotConfigured when there's no API key. Tests use the real service against the
   * stub OpenRouter (tests/helpers/stub-openrouter.ts).
   */
  readonly languageModel: (
    modelId: string,
  ) => Effect.Effect<LanguageModel.LanguageModel, NotConfigured | InvalidConfig>;
  /**
   * Fails the way `languageModel` would without a key or with bad config, before a command
   * does anything slow (reading piped stdin).
   */
  readonly ready: Effect.Effect<void, NotConfigured | InvalidConfig>;
}

/**
 * OpenRouter-specific request settings from config. They go in every request body; add
 * OpenRouter's routing options (`models`, `provider`) here when a command needs them.
 */
export const openRouterSettings = (config: AppConfigShape) => ({
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

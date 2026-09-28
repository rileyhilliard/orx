import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  SchemaTransformation,
} from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import type { ModelInfo } from "~/schemas";
import { AppConfig } from "../config";
import { type InvalidConfig, UpstreamUnavailable } from "../errors";

export interface OpenRouterModelsShape {
  /** OpenRouter's models list, cached in memory with a TTL. Needs no API key. */
  readonly list: Effect.Effect<ReadonlyArray<ModelInfo>, UpstreamUnavailable | InvalidConfig>;
}

export const MODELS_FETCH_TIMEOUT = Duration.seconds(10);
/** Two retries, jittered exponential from 500ms. */
export const modelsRetrySchedule = Schedule.max([
  Schedule.exponential(Duration.millis(500)).pipe(Schedule.jittered),
  Schedule.recurs(2),
]);

/** A per-token price as OpenRouter sends it: a numeric string, "-1" when it varies (null here). */
const WirePrice = Schema.FiniteFromString.pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.Number),
    SchemaTransformation.transform({
      decode: (price) => (price < 0 ? null : price),
      encode: (price) => price ?? -1,
    }),
  ),
);

/** GET /models as OpenRouter sends it (only the fields orx uses). A trust boundary: decoded. */
const WireModels = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      canonical_slug: Schema.optional(Schema.NullOr(Schema.String)),
      name: Schema.String,
      context_length: Schema.optional(Schema.NullOr(Schema.Number)),
      supported_parameters: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      pricing: Schema.Struct({ prompt: WirePrice, completion: WirePrice }),
      top_provider: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
          }),
        ),
      ),
    }),
  ),
});
const decodeWire = Schema.decodeUnknownEffect(WireModels);

const toModelInfo = (model: (typeof WireModels.Type)["data"][number]): ModelInfo => ({
  id: model.id,
  canonicalSlug: model.canonical_slug ?? model.id,
  name: model.name,
  provider: model.id.split("/")[0] ?? "other",
  contextLength: model.context_length ?? null,
  supportsTools: model.supported_parameters?.includes("tools") ?? false,
  promptPrice: model.pricing.prompt,
  completionPrice: model.pricing.completion,
  maxCompletionTokens: model.top_provider?.max_completion_tokens ?? null,
});

/** OpenRouter's status (or what failed on the way), for the log and UpstreamUnavailable.detail. */
const detailOf = (cause: unknown): string => {
  const status = HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined;
  const text = String(cause).replace(/\s+/g, " ").slice(0, 200);
  return status === undefined ? text : `HTTP ${status}: ${text}`;
};

const make = Effect.gen(function* () {
  const { load } = yield* AppConfig;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const cache = yield* Ref.make(
    Option.none<{ readonly at: number; readonly models: ReadonlyArray<ModelInfo> }>(),
  );

  const fetchModels = (baseUrl: string) =>
    http
      .execute(
        HttpClientRequest.get(`${baseUrl}/models`, { urlParams: { output_modalities: "text" } }),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeWire),
        Effect.map((wire) => wire.data.map(toModelInfo)),
        Effect.mapError(
          (cause) =>
            new UpstreamUnavailable({
              message: "Couldn't fetch the OpenRouter models list.",
              retryable: true,
              detail: detailOf(cause),
            }),
        ),
        Effect.timeoutOrElse({
          duration: MODELS_FETCH_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new UpstreamUnavailable({
                message: "Timed out fetching the OpenRouter models list.",
                retryable: true,
              }),
            ),
        }),
        Effect.retry(modelsRetrySchedule),
        // Once, after the retries: the attempts before the last one are only noise.
        Effect.tapError((error) =>
          Effect.logWarning("Models list fetch failed", error.detail ?? error.message),
        ),
      );

  const list = Effect.gen(function* () {
    const config = yield* load;
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    if (Option.isSome(cached) && now - cached.value.at < Duration.toMillis(config.modelsCacheTtl)) {
      return cached.value.models;
    }
    const models = yield* fetchModels(config.baseUrl);
    yield* Ref.set(cache, Option.some({ at: yield* Clock.currentTimeMillis, models }));
    return models;
  });

  return { list } satisfies OpenRouterModelsShape;
});

/** OpenRouter's non-streaming API (the models list), over Effect's HttpClient. */
export class OpenRouterModels extends Context.Service<OpenRouterModels, OpenRouterModelsShape>()(
  "orx/OpenRouterModels",
) {
  static readonly layer = Layer.effect(OpenRouterModels, make);
}

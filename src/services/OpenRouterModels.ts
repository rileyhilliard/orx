import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
  SchemaTransformation,
  Semaphore,
} from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";
import type { ModelInfo } from "~/schemas";
import { AppConfig } from "../config";
import { type InvalidConfig, UpstreamUnavailable } from "../errors";

export interface OpenRouterModelsShape {
  /**
   * OpenRouter's models list, cached in memory with a TTL (MODELS_CACHE_TTL), and a failure for
   * MODELS_FAILURE_TTL. Concurrent callers share one fetch. Needs no API key. Logs nothing: a
   * caller that goes on without the list says what that means.
   */
  readonly list: Effect.Effect<ReadonlyArray<ModelInfo>, UpstreamUnavailable | InvalidConfig>;
}

export const MODELS_FETCH_TIMEOUT = Duration.seconds(10);
/**
 * How long a failed fetch answers for the list: one run's callers (the model check, each turn's
 * context window, the picker) don't each wait out the timeout and retries again.
 */
export const MODELS_FAILURE_TTL = Duration.seconds(30);
/** Two retries, jittered exponential from 500ms. */
export const modelsRetrySchedule = Schedule.max([
  Schedule.exponential(Duration.millis(500)).pipe(Schedule.jittered),
  Schedule.recurs(2),
]);

/**
 * A per-token price as OpenRouter sends it: a numeric string, "-1" when it varies. Null here when
 * it varies or isn't a number, so one odd price doesn't fail the whole list.
 */
const WirePrice = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.Number),
    SchemaTransformation.transform({
      decode: (wire) => {
        const price = Number(wire);
        return wire.trim() !== "" && Number.isFinite(price) && price >= 0 ? price : null;
      },
      encode: (price) => String(price ?? -1),
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

/**
 * Only failures another try can fix are retryable: the network, a 429, a 5xx. Another 4xx or a
 * response that doesn't decode would fail the same way again.
 */
const isRetryable = (cause: unknown): boolean => {
  if (!HttpClientError.isHttpClientError(cause)) return false;
  const status = cause.response?.status;
  return status === undefined || status === 429 || status >= 500;
};

/** The last fetch's outcome, and when it came. */
interface Fetched {
  readonly at: number;
  readonly result: Result.Result<ReadonlyArray<ModelInfo>, UpstreamUnavailable>;
}

const make = Effect.gen(function* () {
  const { load } = yield* AppConfig;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const cache = yield* Ref.make(Option.none<Fetched>());
  // One fetch at a time: a caller that waited finds the cache the fetch it waited on filled.
  const fetching = yield* Semaphore.make(1);

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
              retryable: isRetryable(cause),
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
        Effect.retry({ schedule: modelsRetrySchedule, while: (error) => error.retryable }),
      );

  const list = Effect.gen(function* () {
    const config = yield* load;
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    const fresh = Option.filter(cached, ({ at, result }) => {
      const ttl = Result.isSuccess(result) ? config.modelsCacheTtl : MODELS_FAILURE_TTL;
      return now - at < Duration.toMillis(ttl);
    });
    const result = Option.isSome(fresh)
      ? fresh.value.result
      : yield* Effect.result(fetchModels(config.baseUrl)).pipe(
          Effect.tap((result) =>
            Effect.flatMap(Clock.currentTimeMillis, (at) =>
              Ref.set(cache, Option.some({ at, result })),
            ),
          ),
        );
    return Result.isSuccess(result) ? result.success : yield* Effect.fail(result.failure);
  }).pipe(fetching.withPermit);

  return { list } satisfies OpenRouterModelsShape;
});

/** OpenRouter's non-streaming API (the models list), over Effect's HttpClient. */
export class OpenRouterModels extends Context.Service<OpenRouterModels, OpenRouterModelsShape>()(
  "orx/OpenRouterModels",
) {
  static readonly layer = Layer.effect(OpenRouterModels, make);
}

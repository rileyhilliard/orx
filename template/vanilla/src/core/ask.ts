import { Duration, Effect, Schedule } from "effect";
import { LanguageModel, type Response } from "effect/unstable/ai";
import type { AskResult } from "~/schemas";
import { loadConfig } from "../config";
import { Llm } from "../services/Llm";
import { timedOut, toUpstreamError } from "./upstream";

export const ASK_TIMEOUT = Duration.seconds(60);
/** Retries transient upstream failures only (rate limits, 5xx, timeouts), twice. */
export const askRetrySchedule = Schedule.max([
  Schedule.exponential(Duration.millis(500)).pipe(Schedule.jittered),
  Schedule.recurs(2),
]);

/** OpenRouter's cost in USD, from a finish part's metadata, when it reported one. */
export const readCost = (part: Response.FinishPart): number | undefined => {
  const openrouter = (part.metadata as Record<string, unknown> | undefined)?.openrouter as
    | { usage?: { cost?: unknown } }
    | undefined;
  return typeof openrouter?.usage?.cost === "number" ? openrouter.usage.cost : undefined;
};

/**
 * One prompt, one reply: the example model call. Not streamed; `modelId` defaults to
 * OPENROUTER_MODEL. Logs one `llm call` line with the model, tokens, and cost.
 */
export const ask = (prompt: string, modelId?: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig;
    const requested = modelId ?? config.defaultModel;
    const model = yield* (yield* Llm).languageModel(requested);
    const response = yield* LanguageModel.generateText({
      prompt: [{ role: "user", content: prompt }],
    }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model),
      Effect.mapError(toUpstreamError),
      Effect.timeoutOrElse({
        duration: ASK_TIMEOUT,
        orElse: () => Effect.fail(timedOut("The model call")),
      }),
      Effect.retry({ schedule: askRetrySchedule, while: (error) => error.retryable }),
      Effect.tapError((error) =>
        Effect.logWarning("llm call").pipe(
          Effect.annotateLogs({
            requestedModel: requested,
            errorTag: error._tag,
            errorDetail: error.detail,
          }),
        ),
      ),
    );
    const finish = response.content.find((part) => part.type === "finish");
    const cost = finish ? readCost(finish) : undefined;
    const served = response.content.find((part) => part.type === "response-metadata")?.modelId;
    const result: AskResult = {
      text: response.text,
      ...(served === undefined ? {} : { model: served }),
      usage: {
        inputTokens: response.usage.inputTokens.total ?? 0,
        outputTokens: response.usage.outputTokens.total ?? 0,
        ...(cost === undefined ? {} : { cost }),
      },
    };
    yield* Effect.logInfo("llm call").pipe(
      Effect.annotateLogs({
        requestedModel: requested,
        servedModel: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cost: result.usage.cost,
        finishReason: response.finishReason,
      }),
    );
    return result;
  });

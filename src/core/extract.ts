import { OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Duration, Effect, Schedule, Schema } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { Contact, type Usage } from "~/schemas";
import { loadConfig } from "../config";
import { InvalidModelOutput, type UpstreamUnavailable } from "../errors";
import { Llm } from "../services/Llm";
import { readOpenRouter } from "./chat";
import { formatIssue } from "./input";
import { isRetryableUpstream, timedOut, toUpstreamError } from "./upstream";

export const EXTRACT_TIMEOUT = Duration.seconds(30);
/** A rate limit asking for a longer wait than this isn't retried: the user gets it now. */
export const EXTRACT_MAX_RETRY_AFTER = Duration.seconds(5);

/** How long a RateLimitError asks callers to wait, when it says. */
const retryAfterOf = (error: unknown): Duration.Duration | undefined =>
  AiError.isAiError(error) && error.reason._tag === "RateLimitError"
    ? error.reason.retryAfter
    : undefined;

/**
 * Two retries, jittered exponential from 500ms, each at least the Retry-After OpenRouter sent
 * with a 429.
 */
export const extractRetrySchedule = Schedule.max([
  Schedule.exponential(Duration.millis(500)).pipe(Schedule.jittered),
  Schedule.recurs(2),
]).pipe(
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(Duration.max(duration, retryAfterOf(input) ?? Duration.zero)),
  ),
);

export interface ExtractResult {
  readonly contact: Contact;
  readonly usage: Usage;
  /** The model OpenRouter says served the request, when it said. */
  readonly model: string | undefined;
}

const isOutputError = (error: AiError.AiError) =>
  error.reason._tag === "StructuredOutputError" || error.reason._tag === "InvalidOutputError";

/** Transient upstream failures only; a bad model output or a long Retry-After isn't retried. */
const shouldRetry = (error: AiError.AiError | UpstreamUnavailable) => {
  if (!AiError.isAiError(error)) return error.retryable;
  const retryAfter = retryAfterOf(error);
  return (
    !isOutputError(error) &&
    isRetryableUpstream(error) &&
    (retryAfter === undefined || Duration.isLessThanOrEqualTo(retryAfter, EXTRACT_MAX_RETRY_AFTER))
  );
};

const notAContact = () =>
  new InvalidModelOutput({ message: "The model returned output that isn't a contact." });

/**
 * Structured-output example: pull contact details out of free text, with a strict JSON schema
 * (https://openrouter.ai/docs/guides/features/structured-outputs). The model's output is a
 * trust boundary, so it's decoded again with the same schema that described it. `modelId`
 * defaults to OPENROUTER_MODEL; evals pass others.
 */
export const extractContact = (text: string, modelId?: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig;
    const model = yield* (yield* Llm).languageModel(modelId ?? config.defaultModel);
    const generate = LanguageModel.generateObject({
      prompt: [
        {
          role: "system",
          content:
            "Extract the contact details from the user's text. Use null for anything not present.",
        },
        { role: "user", content: text },
      ],
      schema: Contact,
      objectName: "Contact",
    }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model),
      OpenRouterLanguageModel.withConfigOverride({ strictJsonSchema: true }),
      Effect.timeoutOrElse({
        duration: EXTRACT_TIMEOUT,
        orElse: () => Effect.fail(timedOut("The model call")),
      }),
      Effect.retry({ schedule: extractRetrySchedule, while: shouldRetry }),
      // Once, after the retries (effect-services.md).
      Effect.tapError((error) => Effect.logWarning("Extract model call failed", String(error))),
      Effect.mapError((error): UpstreamUnavailable | InvalidModelOutput =>
        !AiError.isAiError(error)
          ? error
          : isOutputError(error)
            ? notAContact()
            : toUpstreamError(error),
      ),
    );
    const response = yield* generate;
    const contact = yield* Schema.decodeUnknownEffect(Contact)(response.value).pipe(
      Effect.mapError(
        (error) =>
          new InvalidModelOutput({
            message: `The model's output didn't match the schema: ${formatIssue(error.issue)}`,
          }),
      ),
    );
    const finish = response.content.find((part) => part.type === "finish");
    const cost = finish ? readOpenRouter(finish).cost : undefined;
    const served = response.content.find((part) => part.type === "response-metadata");
    const result: ExtractResult = {
      contact,
      usage: {
        inputTokens: response.usage.inputTokens.total ?? 0,
        outputTokens: response.usage.outputTokens.total ?? 0,
        ...(cost === undefined ? {} : { cost }),
      },
      model: served?.modelId,
    };
    return result;
  });

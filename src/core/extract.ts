import { Duration, Effect, Schedule, Schema } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { Contact, type Usage } from "~/schemas";
import { loadConfig } from "../config";
import { InvalidModelOutput, type UpstreamUnavailable } from "../errors";
import { Llm } from "../services/Llm";
import { readOpenRouter } from "./chat";
import { formatIssue } from "./input";
import { timedOut, toUpstreamError } from "./upstream";

export const EXTRACT_TIMEOUT = Duration.seconds(30);
/** Retries transient upstream failures only; a bad model output isn't retried. */
export const extractRetrySchedule = Schedule.max([
  Schedule.exponential(Duration.millis(500)).pipe(Schedule.jittered),
  Schedule.recurs(2),
]);

export interface ExtractResult {
  readonly contact: Contact;
  readonly usage: Usage;
  /** The model OpenRouter says served the request, when it said. */
  readonly model: string | undefined;
}

const isOutputError = (error: AiError.AiError) =>
  error.reason._tag === "StructuredOutputError" || error.reason._tag === "InvalidOutputError";

/**
 * Structured-output example: pull contact details out of free text. The model's output is a
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
      Effect.tapError((error) => Effect.logWarning("Extract model call failed", String(error))),
      Effect.mapError((error): UpstreamUnavailable | InvalidModelOutput =>
        AiError.isAiError(error) && isOutputError(error)
          ? new InvalidModelOutput({ message: "The model returned output that isn't a contact." })
          : AiError.isAiError(error)
            ? toUpstreamError(error)
            : new InvalidModelOutput({
                message: "The model returned output that isn't a contact.",
              }),
      ),
      Effect.timeoutOrElse({
        duration: EXTRACT_TIMEOUT,
        orElse: () => Effect.fail(timedOut("The model call")),
      }),
      Effect.retry({
        schedule: extractRetrySchedule,
        while: (error) => error._tag === "UpstreamUnavailable" && error.retryable,
      }),
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

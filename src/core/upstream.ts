import { Option, Schema } from "effect";
import type { AiError } from "effect/unstable/ai";
import { UpstreamUnavailable } from "../errors";

/**
 * OpenRouter's status for a failure: the HTTP status, or for an error it sent after the stream
 * started, the code in the error chunk (`streamErrorReason` in chat.ts keeps it in the reason's
 * metadata), so a mid-stream 503 reads like one before the stream.
 */
const statusOf = (reason: AiError.AiErrorReason): number | undefined => {
  const status = "http" in reason ? reason.http?.response?.status : undefined;
  if (status !== undefined) return status;
  const openrouter = "metadata" in reason ? reason.metadata.openrouter : undefined;
  const code =
    typeof openrouter === "object" && openrouter !== null && !Array.isArray(openrouter)
      ? openrouter.errorCode
      : undefined;
  return typeof code === "number" ? code : undefined;
};

/** OpenRouter's own reason, on one line and capped, for logs and evals. Never headers. */
export const upstreamDetail = (error: AiError.AiError): string => {
  const status = statusOf(error.reason);
  const text = error.reason.message.replace(/\s+/g, " ").trim().slice(0, 200);
  return status === undefined ? `${error.reason._tag}: ${text}` : `HTTP ${status}: ${text}`;
};

const CONTEXT_LENGTH = /context length|maximum context|too many tokens|context window/i;

/** The provider rejected the request as longer than the model's context window. */
export const isContextLengthError = (error: AiError.AiError) =>
  error.reason._tag === "InvalidRequestError" && CONTEXT_LENGTH.test(error.reason.message);

/** OpenRouter's error body: `{ error: { message, metadata: { reasons } } }` (moderation). */
const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      message: Schema.optional(Schema.String),
      metadata: Schema.optional(
        Schema.NullOr(Schema.Struct({ reasons: Schema.optional(Schema.Array(Schema.String)) })),
      ),
    }),
  }),
);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

const bodyOf = (reason: AiError.AiErrorReason) =>
  "http" in reason && reason.http?.body !== undefined
    ? Option.map(decodeErrorBody(reason.http.body), (body) => body.error)
    : Option.none();

const ROUTING =
  "No provider meets the routing settings (OPENROUTER_ZDR / OPENROUTER_DATA_COLLECTION / require_parameters / OPENROUTER_ALLOW_FALLBACKS=false), or none serving this model is up right now. Relax them or pick another model.";

/** A 403: a key without permission says so; anything else is moderation or a guardrail. */
const forbidden = (reason: AiError.AiErrorReason): string => {
  const body = bodyOf(reason);
  const message = Option.getOrUndefined(Option.flatMapNullishOr(body, (b) => b.message));
  if (message !== undefined && /\bkey\b/i.test(message)) {
    return `OpenRouter refused the API key: ${message.slice(0, 200)}. Check OPENROUTER_API_KEY and its limits.`;
  }
  const reasons = Option.getOrElse(
    Option.flatMapNullishOr(body, (b) => b.metadata?.reasons),
    () => [],
  );
  return `OpenRouter blocked this request (moderation/guardrail)${reasons.length > 0 ? `: ${reasons.join(", ")}` : ""}.`;
};

/**
 * An Effect AI failure as the user sees it. OpenRouter's HTTP status decides first
 * (https://openrouter.ai/docs/api/reference/errors-and-debugging), then the reason. What a
 * retry can't fix (a rejected key, no credits, a blocked or rejected request, routing no
 * provider can meet) is not retryable; rate limits, timeouts, and 5xx are. Anything else
 * follows the AiError's own retryability.
 */
export const toUpstreamError = (error: AiError.AiError): UpstreamUnavailable => {
  const detail = upstreamDetail(error);
  const reason = error.reason;
  const fail = (message: string, retryable: boolean) =>
    new UpstreamUnavailable({ message, retryable, detail });
  switch (statusOf(reason)) {
    case 402:
      return fail(
        "Out of OpenRouter credits, or MAX_OUTPUT_TOKENS reserves more than the remaining balance. Add credits or lower it.",
        false,
      );
    case 403:
      return fail(forbidden(reason), false);
    case 404:
      // Every request sets require_parameters, so a model with endpoints can still have none
      // that fit (https://openrouter.ai/docs/guides/routing/provider-selection).
      if (!CONTEXT_LENGTH.test(reason.message)) return fail(ROUTING, false);
      break;
    case 408:
      return fail("OpenRouter timed out waiting for the model. Try again.", true);
    case 503:
      return fail(ROUTING, false);
  }
  switch (reason._tag) {
    case "AuthenticationError":
      return fail("OpenRouter rejected the API key. Check OPENROUTER_API_KEY.", false);
    case "QuotaExhaustedError":
      return fail("The OpenRouter account is out of credits. Add credits and try again.", false);
    case "RateLimitError":
      return fail("OpenRouter is rate limiting this key. Wait a moment and try again.", true);
    case "ContentPolicyError":
      return fail("The provider refused this request (content policy).", false);
    case "InvalidRequestError": {
      if (CONTEXT_LENGTH.test(reason.message)) {
        return fail("The chat is too long for this model. Start a new chat.", false);
      }
      return fail(`OpenRouter rejected the request: ${reason.message.slice(0, 200)}`, false);
    }
    case "ToolNotFoundError":
    case "ToolParameterValidationError":
    case "InvalidToolResultError":
    case "ToolResultEncodingError":
    case "ToolConfigurationError":
      return fail(
        `The ${reason.toolName} tool failed inside orx (${reason._tag}); that's a bug in orx or the tool, not the network.`,
        error.isRetryable,
      );
    case "InvalidOutputError":
      // Effect AI decodes the model's parts against the toolkit, so this is also a call to a
      // tool orx doesn't have.
      return fail(
        "The model's output didn't match what orx expects (a call to a tool orx doesn't have, or a malformed part); that's the model, not the network. Try again or pick another model.",
        error.isRetryable,
      );
    case "UnsupportedSchemaError":
    case "ToolkitRequiredError":
      return fail(
        `orx built a request the model can't take (${reason._tag}); that's a bug in orx, not the network.`,
        error.isRetryable,
      );
    default:
      return fail(
        error.isRetryable ? "The model call failed. Try again." : "The model call failed.",
        error.isRetryable,
      );
  }
};

/**
 * Whether trying the same request again can succeed, by the same rules as the message the
 * user sees: every automatic retry (a turn's step, extract) decides with this.
 */
export const isRetryableUpstream = (error: AiError.AiError): boolean =>
  toUpstreamError(error).retryable;

export const timedOut = (what: string) =>
  new UpstreamUnavailable({ message: `${what} took too long.`, retryable: true });

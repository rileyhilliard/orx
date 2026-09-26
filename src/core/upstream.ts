import { Cause } from "effect";
import type { AiError } from "effect/unstable/ai";
import { UpstreamUnavailable } from "../errors";

const statusOf = (reason: AiError.AiErrorReason): number | undefined =>
  "http" in reason ? reason.http?.response?.status : undefined;

/** OpenRouter's own reason, on one line and capped, for logs and evals. Never headers. */
export const upstreamDetail = (error: AiError.AiError): string => {
  const status = statusOf(error.reason);
  const text = error.reason.message.replace(/\s+/g, " ").trim().slice(0, 200);
  return status === undefined ? `${error.reason._tag}: ${text}` : `HTTP ${status}: ${text}`;
};

const CONTEXT_LENGTH = /context length|maximum context|too many tokens|context window/i;

/**
 * An Effect AI failure as the user sees it. What a retry can't fix (a rejected key, a model
 * with no endpoints, another rejected request) is not retryable; no credits, rate limits, 5xx,
 * network errors, and unknown failures are.
 */
export const toUpstreamError = (error: AiError.AiError): UpstreamUnavailable => {
  const detail = upstreamDetail(error);
  const reason = error.reason;
  const fail = (message: string, retryable: boolean) =>
    new UpstreamUnavailable({ message, retryable, detail });
  switch (reason._tag) {
    case "AuthenticationError":
      return fail("OpenRouter rejected the API key. Check OPENROUTER_API_KEY.", false);
    case "QuotaExhaustedError":
      return fail("The OpenRouter account is out of credits. Add credits and try again.", true);
    case "RateLimitError":
      return fail("OpenRouter is rate limiting this key. Wait a moment and try again.", true);
    case "ContentPolicyError":
      return fail("The provider refused this request (content policy).", false);
    case "InvalidRequestError": {
      if (statusOf(reason) === 404) {
        return fail("That model has no available endpoints right now. Pick another model.", false);
      }
      if (CONTEXT_LENGTH.test(reason.message)) {
        return fail("The chat is too long for this model. Start a new chat.", false);
      }
      return fail(`OpenRouter rejected the request: ${reason.message.slice(0, 200)}`, false);
    }
    default:
      return fail("The model call failed. Try again.", true);
  }
};

export const timedOut = (what: string) =>
  new UpstreamUnavailable({ message: `${what} took too long.`, retryable: true });

/** For defects surfaced as causes (used by the TUI bridge and evals). */
export const describeCause = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

import { AiError } from "effect/unstable/ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { toUpstreamError } from "~/core/upstream";
import { ndjson, runCli } from "./helpers/cli";
import {
  type CompletionFailure,
  type StubOpenRouter,
  startStubOpenRouter,
} from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
afterEach(() => {
  stub.failCompletions = undefined;
});

/** `orx ask --json` against a stub that fails every completion with `failure`: the error event. */
const errorFor = async (failure: CompletionFailure) => {
  stub.failCompletions = failure;
  const run = await runCli(["ask", "hi", "--json"], { env: { OPENROUTER_BASE_URL: stub.baseUrl } });
  expect(run.exitCode).toBe(4);
  return (ndjson(run.stdout).at(-1) as { error: { message: string; retryable: boolean } }).error;
};

// https://openrouter.ai/docs/api/reference/errors-and-debugging
describe("OpenRouter's HTTP errors, as the user sees them", () => {
  it("402: out of credits, or MAX_OUTPUT_TOKENS reserves more than is left; not retryable", async () => {
    const error = await errorFor({ status: 402 });
    expect(error).toMatchObject({
      message:
        "Out of OpenRouter credits, or MAX_OUTPUT_TOKENS reserves more than the remaining balance. Add credits or lower it.",
      retryable: false,
    });
  });

  it("403 with a moderation body: blocked, with the reasons, not a key problem", async () => {
    const error = await errorFor({
      status: 403,
      body: {
        error: {
          code: 403,
          message: "openai/gpt-test requires moderation on OpenRouter. Your input was flagged",
          metadata: { reasons: ["harassment", "violence"], flagged_input: "..." },
        },
      },
    });
    expect(error).toMatchObject({
      message: "OpenRouter blocked this request (moderation/guardrail): harassment, violence.",
      retryable: false,
    });
  });

  it("403 about the key itself: points at the key", async () => {
    const error = await errorFor({
      status: 403,
      body: { error: { code: 403, message: "This API key is disabled" } },
    });
    expect(error.message).toContain("OPENROUTER_API_KEY");
    expect(error.message).toContain("This API key is disabled");
    expect(error.retryable).toBe(false);
  });

  it("408: a timeout another try can fix", async () => {
    const error = await errorFor({ status: 408 });
    expect(error).toMatchObject({
      message: "OpenRouter timed out waiting for the model. Try again.",
      retryable: true,
    });
  });

  it("503: no provider meets the routing settings; not retryable", async () => {
    const error = await errorFor({ status: 503 });
    expect(error.message).toMatch(/^No provider meets the routing settings/);
    expect(error.message).toContain("OPENROUTER_ZDR");
    expect(error.retryable).toBe(false);
  });

  it("404: no endpoint for the model under the routing settings; not retryable", async () => {
    const error = await errorFor({
      status: 404,
      body: { error: { code: 404, message: "No endpoints found matching your data policy" } },
    });
    expect(error.message).toMatch(/^No provider meets the routing settings/);
    expect(error.retryable).toBe(false);
  });

  it("429 with insufficient_quota: out of credits, which waiting won't fix", async () => {
    const error = await errorFor({
      status: 429,
      body: { error: { code: "insufficient_quota", message: "quota" } },
    });
    expect(error.retryable).toBe(false);
  });
});

const aiError = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "Toolkit", method: "read.handle", reason });

describe("toUpstreamError for failures that aren't the network's", () => {
  it("blames orx or the tool for a tool result that can't be encoded, and follows the reason's retryability", () => {
    const error = toUpstreamError(
      aiError(
        new AiError.ToolResultEncodingError({
          toolName: "read",
          toolResult: 1n,
          description: "Cannot encode bigint values as JSON",
        }),
      ),
    );
    expect(error.message).toMatch(/the read tool/i);
    expect(error.message).toMatch(/not the network/);
    expect(error.retryable).toBe(false);
  });

  it("uses the reason's own retryability for anything else", () => {
    const unknown = toUpstreamError(aiError(new AiError.UnknownError({ description: "?" })));
    expect(unknown.retryable).toBe(false);
    const provider = toUpstreamError(
      aiError(new AiError.InternalProviderError({ description: "overloaded" })),
    );
    expect(provider.retryable).toBe(true);
  });
});

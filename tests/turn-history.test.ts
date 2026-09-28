import { Effect, Schema, Stream } from "effect";
import { Prompt, Response } from "effect/unstable/ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERRUPTED_RESULT, runTurn, stepPrompt, toPrompt } from "~/core/chat";
import { elide, estimateTokens } from "~/core/context";
import { AssistantMessage, type ChatMessage } from "~/schemas";
import { runScript } from "../scripts/lib/script-layer";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.chatRequests.length = 0;
  stub.toolCalls = [];
  stub.steps = [];
});

type WireMessage = {
  role: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
  content: unknown;
};

describe("turn history", () => {
  it("replays a reply's steps in the next turn, with tool call ids and results", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    vi.stubEnv("LOG_LEVEL", "error");
    stub.toolCalls = [{ name: "currentTime", arguments: '{"timeZone":"UTC"}' }];
    try {
      await runScript(
        Effect.gen(function* () {
          const replies: AssistantMessage[] = [];
          const first: ChatMessage[] = [{ role: "user", text: "time?" }];
          yield* Stream.runDrain(
            runTurn({
              history: first,
              modelId: "openai/gpt-test",
              onEnd: (reply) => Effect.sync(() => replies.push(reply)),
            }),
          );
          // Through JSON and back, as a saved chat is.
          const codec = Schema.fromJsonString(AssistantMessage);
          const saved = Schema.decodeUnknownSync(codec)(
            Schema.encodeSync(codec)(replies[0] as AssistantMessage),
          );
          yield* Stream.runDrain(
            runTurn({
              history: [...first, saved, { role: "user", text: "again" }],
              modelId: "openai/gpt-test",
            }),
          );
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(stub.chatRequests).toHaveLength(3);
    const messages = (stub.chatRequests[2] as { messages: WireMessage[] }).messages;
    const call = messages.find((m) => m.role === "assistant" && m.tool_calls);
    const result = messages.find((m) => m.role === "tool");
    expect(call?.tool_calls?.[0]?.id).toBe("call_stub_1");
    expect(result?.tool_call_id).toBe("call_stub_1");
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
  });

  it("drops an earlier model's reasoning details when the chat switches models", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    vi.stubEnv("LOG_LEVEL", "error");
    const detail = { type: "reasoning.text", text: "Need the time.", signature: "sig-1", index: 0 };
    stub.steps = [
      {
        reasoningDetails: [detail],
        toolCalls: [{ name: "currentTime", arguments: '{"timeZone":"UTC"}' }],
      },
      { text: "It's noon." },
    ];
    try {
      await runScript(
        Effect.gen(function* () {
          const replies: AssistantMessage[] = [];
          const first: ChatMessage[] = [{ role: "user", text: "time?" }];
          yield* Stream.runDrain(
            runTurn({
              history: first,
              modelId: "openai/gpt-test",
              onEnd: (reply) => Effect.sync(() => replies.push(reply)),
            }),
          );
          const codec = Schema.fromJsonString(AssistantMessage);
          const saved = Schema.decodeUnknownSync(codec)(
            Schema.encodeSync(codec)(replies[0] as AssistantMessage),
          );
          const history = [...first, saved, { role: "user" as const, text: "again" }];
          yield* Stream.runDrain(runTurn({ history, modelId: "openai/gpt-test" }));
          yield* Stream.runDrain(runTurn({ history, modelId: "acme/cheap-model" }));
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
    expect(stub.chatRequests).toHaveLength(4);
    const assistantCall = (request: unknown) =>
      (request as { messages: Array<WireMessage & { reasoning_details?: unknown }> }).messages.find(
        (m) => m.role === "assistant" && m.tool_calls,
      );
    // Within the turn and on the same model, the details go back as they came.
    expect(assistantCall(stub.chatRequests[1])?.reasoning_details).toMatchObject([detail]);
    expect(assistantCall(stub.chatRequests[2])?.reasoning_details).toMatchObject([detail]);
    // Another model gets the tool call and its id, but not the reasoning.
    const switched = assistantCall(stub.chatRequests[3]);
    expect(switched?.tool_calls?.[0]?.id).toBe("call_stub_1");
    expect(switched?.reasoning_details).toBeUndefined();
    expect(JSON.stringify(stub.chatRequests[3])).not.toContain("sig-1");
  });

  it("gives an interrupted step's unanswered tool calls a synthetic result", () => {
    const parts: ReadonlyArray<Response.AnyPart> = [
      Response.makePart("text-start", { id: "t1" }),
      Response.makePart("text-delta", { id: "t1", delta: "Checking" }),
      Response.makePart("tool-call", {
        id: "call_1",
        name: "currentTime",
        params: { timeZone: "UTC" },
        providerExecuted: false,
      }),
    ];
    const step = stepPrompt(parts, true);
    const [assistant, tool] = step.content;
    expect(assistant?.role).toBe("assistant");
    expect(tool).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", id: "call_1", isFailure: true, result: INTERRUPTED_RESULT }],
    });
    const text =
      assistant?.role === "assistant"
        ? assistant.content.find((part) => part.type === "text")
        : undefined;
    expect(text).toMatchObject({ type: "text", text: "Checking" });
  });

  it("replays text for a reply saved before steps existed", () => {
    const prompt = toPrompt("sys", [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello", tools: [] },
    ]);
    expect(prompt.content.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });
});

describe("context elision", () => {
  const toolStep = (id: string, name: string, output: string) =>
    Prompt.fromResponseParts([
      Response.makePart("tool-call", {
        id,
        name,
        params: { path: `src/${id}.ts` },
        providerExecuted: false,
      }),
      Response.makePart("tool-result", {
        id,
        name,
        isFailure: false,
        result: output,
        encodedResult: output,
        providerExecuted: false,
        preliminary: false,
      }),
    ]);

  const big = "x".repeat(10_000);
  const prompt = [
    toolStep("a", "read", big),
    toolStep("b", "skill", big),
    toolStep("c", "read", big),
    toolStep("d", "read", big),
    toolStep("e", "read", big),
  ].reduce((acc, step) => Prompt.concat(acc, step), Prompt.make("go"));

  const results = (p: Prompt.Prompt) =>
    p.content.flatMap((m) =>
      m.role === "tool"
        ? m.content.flatMap((part) => (part.type === "tool-result" ? [part] : []))
        : [],
    );

  it("elides old tool outputs oldest first, sparing skills and the last two steps", () => {
    const { prompt: out, elided } = elide(prompt, 0);
    expect(elided).toBe(2);
    expect(results(out).map((r) => r.result === big)).toEqual([false, true, false, true, true]);
    expect(results(out)[0]?.result).toBe("[read src/a.ts output elided, re-run if needed]");
  });

  it("stops once the estimate fits the budget", () => {
    const { elided } = elide(prompt, estimateTokens(prompt) - 100);
    expect(elided).toBe(1);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Effect, Option, Schema, Stream } from "effect";
import { Prompt, Response } from "effect/unstable/ai";
import { INTERRUPTED_RESULT, runTurn, sendMessage, stepPrompt, toPrompt } from "~/core/chat";
import { ELIDE_ALL, elide, estimateTokens } from "~/core/context";
import { chatToMarkdown } from "~/core/export";
import { chatsTable } from "~/core/format";
import { AssistantMessage, type ChatId, type ChatMessage } from "~/schemas";
import { ChatStore } from "~/services/ChatStore";
import { runScript } from "../scripts/lib/script-layer";
import { restoreEnv, stubEnv } from "./helpers/env";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";
import { testToolkit } from "./helpers/tools";

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
    stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    stubEnv("LOG_LEVEL", "error");
    stub.toolCalls = [{ name: "currentTime", arguments: '{"timeZone":"UTC"}' }];
    try {
      await runScript(
        Effect.gen(function* () {
          const replies: AssistantMessage[] = [];
          const first: ChatMessage[] = [{ role: "user", text: "time?" }];
          yield* Stream.runDrain(
            runTurn({
              toolkit: testToolkit,
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
              toolkit: testToolkit,
              history: [...first, saved, { role: "user", text: "again" }],
              modelId: "openai/gpt-test",
            }),
          );
        }),
      );
    } finally {
      restoreEnv();
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
    stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    stubEnv("LOG_LEVEL", "error");
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
              toolkit: testToolkit,
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
          yield* Stream.runDrain(
            runTurn({ toolkit: testToolkit, history, modelId: "openai/gpt-test" }),
          );
          yield* Stream.runDrain(
            runTurn({ toolkit: testToolkit, history, modelId: "acme/cheap-model" }),
          );
        }),
      );
    } finally {
      restoreEnv();
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

  it("sends @ attachments to the model but saves and shows only the typed text", async () => {
    stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    stubEnv("LOG_LEVEL", "error");
    const id = "4b9f7f55-5a0e-4a8e-9a53-2f0c7f0c1a11" as ChatId;
    const attachments = '<file path="a.ts">\n     1\tconst secretSauce = 1;\n</file>';
    const chat = {
      id,
      model: "openai/gpt-test",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messages: [],
    };
    let saved: ReadonlyArray<ChatMessage> = [];
    try {
      await runScript(
        Effect.gen(function* () {
          yield* Stream.runDrain(
            sendMessage(chat, "explain @a.ts", "openai/gpt-test", { attachments }),
          );
          const store = yield* ChatStore;
          const stored = Option.getOrThrow(yield* store.get(id));
          saved = stored.messages;
          expect(chatToMarkdown(stored)).not.toContain("secretSauce");
          expect(chatsTable([stored])).toContain("explain @a.ts");
        }),
      );
    } finally {
      restoreEnv();
    }
    expect(saved[0]).toEqual({ role: "user", text: "explain @a.ts", attachments });
    const messages = (stub.chatRequests[0] as { messages: WireMessage[] }).messages;
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "explain @a.ts" },
        { type: "text", text: attachments },
      ],
    });
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
    const { prompt: out, elided } = elide(prompt, ELIDE_ALL);
    expect(elided).toBe(2);
    expect(results(out).map((r) => r.result === big)).toEqual([false, true, false, true, true]);
    expect(results(out)[0]?.result).toBe("[read src/a.ts output elided, re-run if needed]");
  });

  it("stops once the estimate fits the budget", () => {
    const fits = estimateTokens(prompt) - 100;
    const { elided } = elide(prompt, { limit: fits, target: fits });
    expect(elided).toBe(1);
  });

  it("elides past the limit down to the target, then keeps that set while under the limit", () => {
    const total = estimateTokens(prompt);
    const first = elide(prompt, { limit: total - 100, target: total - 3000 });
    expect(first.elided).toBe(2);
    // Under the limit with what's already elided: nothing more, the same prompt.
    const again = elide(prompt, { limit: total - 100, target: 0 }, first.elision);
    expect(again.elided).toBe(0);
    expect(again.prompt).toEqual(first.prompt);
    // Nothing previously elided and under the limit: nothing at all.
    expect(elide(prompt, { limit: total, target: 0 }).elided).toBe(0);
  });

  it("elides an older message's @ attachments but never the latest message's", () => {
    const files = (name: string) => `<file path="${name}">\n${big}\n</file>`;
    const history: ChatMessage[] = [
      { role: "user", text: "look at @a.ts", attachments: files("a.ts") },
      { role: "assistant", text: "ok", tools: [] },
      { role: "user", text: "and @b.ts", attachments: files("b.ts") },
    ];
    const { prompt: out, elided } = elide(toPrompt("sys", history), ELIDE_ALL);
    expect(elided).toBe(1);
    const users = out.content.flatMap((m) =>
      m.role === "user" ? [m.content.map((part) => (part.type === "text" ? part.text : ""))] : [],
    );
    expect(users).toEqual([
      ["look at @a.ts", "[attached a.ts elided, read again if needed]"],
      ["and @b.ts", files("b.ts")],
    ]);
  });
});

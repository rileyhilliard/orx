import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Cause, Effect, Exit, Logger, Option, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { runTurn, type TurnEvent } from "~/core/chat";
import { type LogRecord, toEntry, toRecord } from "~/logging";
import { AssistantMessage, type ChatMessage } from "~/schemas";
import { runScript } from "../scripts/lib/script-layer";
import { askEvents, runCli } from "./helpers/cli";
import { restoreEnv, stubEnv } from "./helpers/env";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";
import { testToolkit } from "./helpers/tools";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
const defaultCompletion = () => ({ ...stub.completion });
let completion: StubOpenRouter["completion"];
beforeEach(() => {
  completion = defaultCompletion();
  stub.failCompletions = undefined;
  stub.chatRequests.length = 0;
  stub.toolCalls = [];
  stub.steps = [];
});
afterEach(() => {
  stub.completion = completion;
  restoreEnv();
});

type WireMessage = {
  role: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
  content: unknown;
};
type WireRequest = {
  messages: WireMessage[];
  cache_control?: unknown;
  session_id?: unknown;
};
const request = (index: number) => stub.chatRequests[index] as WireRequest;

const useStub = (logLevel = "error") => {
  stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
  stubEnv("LOG_LEVEL", logLevel);
};

/** Runs one turn through the real programs, collecting its events, reply, and log records. */
const turn = (
  history: ReadonlyArray<ChatMessage>,
  options: { modelId?: string; sessionId?: string } = {},
) => {
  const events: TurnEvent[] = [];
  const replies: AssistantMessage[] = [];
  const logs: LogRecord[] = [];
  return runScript(
    runTurn({
      history,
      modelId: options.modelId ?? "openai/gpt-test",
      toolkit: testToolkit,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      onEnd: (reply) => Effect.sync(() => replies.push(reply)),
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.exit,
      Effect.provide(Logger.layer([Logger.make((entry) => logs.push(toRecord(toEntry(entry))))])),
    ),
  ).then((exit) => ({ exit, events, reply: replies[0], logs }));
};

/** A reply as a saved chat holds it: through JSON and back. */
const saved = (reply: AssistantMessage | undefined) => {
  const codec = Schema.fromJsonString(AssistantMessage);
  return Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(reply as AssistantMessage));
};

describe("a tool call to a tool that doesn't exist", () => {
  // Effect AI decodes each step's parts against the toolkit, so a call to a name it doesn't have
  // fails the step (InvalidOutputError) before orx sees the call: retried before any output,
  // a failed turn after it. The error doesn't carry the name the model called, so orx can't
  // answer the call and go on. What must hold is that the saved reply never carries the call.
  it("fails the turn after text, and the saved reply replays with no unanswered call", async () => {
    useStub();
    stub.steps = [{ text: "Let me check.", toolCalls: [{ name: "nope", arguments: "{}" }] }];
    const first: ChatMessage[] = [{ role: "user", text: "do it" }];
    const { exit, reply } = await turn(first);
    expect(exit._tag).toBe("Failure");
    // The user is told the model's output was the problem, not the network.
    const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
    expect(Option.getOrUndefined(error)).toMatchObject({
      _tag: "UpstreamUnavailable",
      message: expect.stringContaining("a call to a tool orx doesn't have"),
    });
    expect(reply).toMatchObject({ text: "Let me check.", interrupted: true, tools: [] });

    const next = await turn([...first, saved(reply), { role: "user", text: "again" }]);
    expect(next.exit._tag).toBe("Success");
    const replayed = request(stub.chatRequests.length - 1).messages;
    expect(replayed.some((m) => m.tool_calls !== undefined || m.role === "tool")).toBe(false);
    expect(replayed.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("an error after the stream started", () => {
  it("fails the turn with exit 4 and an error event, and saves the reply as interrupted", async () => {
    stub.steps = [
      { text: "Partial answer", error: { code: 502, message: "Provider disconnected" } },
    ];
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(4);
    const events = askEvents(run.stdout);
    expect(events.filter((e) => e.type === "text").map((e) => e.delta)).toEqual(["Partial answer"]);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { retryable: true } });
    // Text had gone out, so it wasn't retried.
    expect(stub.chatRequests).toHaveLength(1);
    const call = run.logs.find((r) => r.msg === "llm call");
    expect(call).toMatchObject({ errorTag: "UpstreamUnavailable", finishReason: "error" });
    expect(String(call?.errorDetail)).toContain("Provider disconnected");

    const chats = await runCli(["chats", "--json"], { root: run.root });
    const [chat] = JSON.parse(chats.stdout) as Array<{ messages: Array<Record<string, unknown>> }>;
    expect(chat?.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Partial answer",
      finishReason: "error",
      interrupted: true,
    });
  });

  it("maps the error's code the way a status before the stream would be", async () => {
    stub.steps = [{ text: "x", error: { code: 400, message: "Bad tool schema" } }];
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(4);
    expect(askEvents(run.stdout).at(-1)).toMatchObject({
      type: "error",
      error: {
        retryable: false,
        message: expect.stringContaining("Bad tool schema"),
      },
    });
  });

  it("retries an error that came before any output", async () => {
    stub.steps = [{ error: { code: 502, message: "Provider disconnected" } }];
    const run = await runCli(["ask", "hi"], { env: { OPENROUTER_BASE_URL: stub.baseUrl } });
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests).toHaveLength(2);
    expect(run.stdout).toContain("Hello from the stub.");
  });

  it("fails the turn on an error chunk the provider can't decode (a string code)", async () => {
    // @effect/ai-openrouter's chunk schema wants a numeric code; OpenRouter's docs also show
    // string codes. Such a chunk fails to decode, which still fails the turn (as output the
    // provider couldn't read) rather than ending it as a normal reply.
    stub.steps = [{ text: "Partial", error: { code: "server_error", message: "Gone" } }];
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(4);
    expect(askEvents(run.stdout).at(-1)).toMatchObject({
      type: "error",
      error: { retryable: true },
    });
    expect(run.logs.find((r) => r.msg === "llm call")).toMatchObject({
      errorTag: "UpstreamUnavailable",
    });
  });

  it("treats finish_reason error without an error body as a failure", async () => {
    stub.steps = [{ text: "Partial", finishReason: "error" }];
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(4);
    expect(askEvents(run.stdout).at(-1)).toMatchObject({ type: "error" });
  });
});

describe("a reply that ends early", () => {
  it("notes a reply cut off at MAX_OUTPUT_TOKENS", async () => {
    stub.steps = [{ text: "The first half", finishReason: "length" }];
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, MAX_OUTPUT_TOKENS: "64" },
    });
    expect(run.exitCode).toBe(0);
    const events = askEvents(run.stdout);
    expect(events.at(-2)).toEqual({
      type: "note",
      message:
        "Reply cut off at its length limit (MAX_OUTPUT_TOKENS is 64; the model or its context window can be lower).",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "length" });
  });

  it("notes a reply the provider filtered", async () => {
    stub.steps = [{ text: "", finishReason: "content_filter" }];
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(0);
    expect(askEvents(run.stdout).at(-2)).toEqual({
      type: "note",
      message: "The provider filtered the reply.",
    });
  });
});

describe("the llm call line", () => {
  it("records a defect as a Defect, not as the user aborting", async () => {
    useStub("info");
    const Boom = Tool.make("boom", {
      description: "Always breaks",
      success: Schema.String,
      failureMode: "return",
    });
    const BoomTools = Toolkit.make(Boom);
    const handlers = BoomTools.toLayer({ boom: () => Effect.die(new Error("a bug")) });
    stub.toolCalls = [{ name: "boom", arguments: "{}" }];
    const logs: LogRecord[] = [];
    const exit = await runScript(
      runTurn({
        history: [{ role: "user", text: "hi" }],
        modelId: "openai/gpt-test",
        toolkit: BoomTools,
      }).pipe(
        Stream.runDrain,
        Effect.provide(handlers),
        Effect.exit,
        Effect.provide(Logger.layer([Logger.make((entry) => logs.push(toRecord(toEntry(entry))))])),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(logs.find((r) => r.msg === "llm call")).toMatchObject({
      aborted: false,
      errorTag: "Defect",
    });
  });

  it("records cache and reasoning tokens, and the reply keeps them", async () => {
    useStub("info");
    stub.completion = {
      ...stub.completion,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        cost: 0.001,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    };
    const { reply, logs } = await turn([{ role: "user", text: "hi" }]);
    expect(logs.find((r) => r.msg === "llm call")).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 7,
    });
    expect(saved(reply).usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.001,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 7,
    });
  });
});

describe("request settings per turn", () => {
  it("asks Anthropic models for automatic caching, which follows the tool loop", async () => {
    useStub();
    stub.toolCalls = [{ name: "currentTime", arguments: '{"timeZone":"UTC"}' }];
    await turn([{ role: "user", text: "time?" }], { modelId: "anthropic/claude-test" });
    await turn([{ role: "user", text: "hi" }], { modelId: "~anthropic/claude-sonnet-latest" });
    await turn([{ role: "user", text: "hi" }], { modelId: "openai/gpt-test" });
    expect(stub.chatRequests).toHaveLength(4);
    for (const index of [0, 1, 2]) {
      expect(request(index).cache_control).toEqual({ type: "ephemeral" });
    }
    expect(request(3).cache_control).toBeUndefined();
    // The explicit breakpoints stay: the system prompt and the last user message.
    const system = request(0).messages[0] as { content: Array<{ cache_control?: unknown }> };
    expect(system.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sends the chat id as session_id on every step", async () => {
    useStub();
    stub.toolCalls = [{ name: "currentTime", arguments: '{"timeZone":"UTC"}' }];
    await turn([{ role: "user", text: "time?" }], { sessionId: "chat-123" });
    expect(stub.chatRequests.map((_, i) => request(i).session_id)).toEqual([
      "chat-123",
      "chat-123",
    ]);
  });

  it("sends the saved chat's id from ask", async () => {
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    const done = askEvents(run.stdout).at(-1);
    if (done?.type !== "done") throw new Error(`ask ended with ${done?.type}`);
    expect(request(0).session_id).toBe(done.chatId);
  });
});

describe("rate limits", () => {
  it("waits as long as Retry-After asks before retrying", async () => {
    stub.failCompletions = { status: 429, times: 1, headers: { "retry-after": "1" } };
    const started = Date.now();
    const run = await runCli(["ask", "hi"], { env: { OPENROUTER_BASE_URL: stub.baseUrl } });
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  it("doesn't retry when Retry-After is longer than a short wait", async () => {
    stub.failCompletions = { status: 429, times: 1, headers: { "retry-after": "60" } };
    const started = Date.now();
    const run = await runCli(["ask", "hi"], { env: { OPENROUTER_BASE_URL: stub.baseUrl } });
    expect(run.exitCode).toBe(4);
    expect(stub.chatRequests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("bare orx", () => {
  it("exits 3 without a key, before the terminal UI starts", async () => {
    const run = await runCli([], { stdoutIsTerminal: true, env: { OPENROUTER_API_KEY: "" } });
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("OPENROUTER_API_KEY");
  });
});

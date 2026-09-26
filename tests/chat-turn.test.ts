import { Effect, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "~/core/chat";
import type { AssistantMessage } from "~/schemas";
import { runScript, type ScriptServices } from "../scripts/lib/script-layer";
import { ndjson, runCli } from "./helpers/cli";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.hangAfter = undefined;
  stub.failCompletions = undefined;
  stub.chatRequests.length = 0;
});

describe("a chat turn", () => {
  it("times out a stalled stream after MAX_STREAM_SECONDS and saves the partial reply", async () => {
    stub.completion = { ...stub.completion, text: "one two three four" };
    stub.hangAfter = 2;
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, MAX_STREAM_SECONDS: "1" },
    });
    stub.completion = { ...stub.completion, text: "Hello from the stub." };
    expect(run.exitCode).toBe(4);
    const events = ndjson(run.stdout);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join(""),
    ).toBe("one two ");
    expect(events.at(-1)).toMatchObject({ type: "error", error: { retryable: true } });

    const chats = await runCli(["chats", "--json"], { root: run.root });
    const [chat] = JSON.parse(chats.stdout) as Array<{ messages: Array<Record<string, unknown>> }>;
    expect(chat?.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "one two ",
      interrupted: true,
    });
  });

  it("retries a failure before any output, then succeeds", async () => {
    stub.failCompletions = { status: 503, times: 1 };
    const run = await runCli(["ask", "hi"], { env: { OPENROUTER_BASE_URL: stub.baseUrl } });
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests).toHaveLength(2);
  });

  it("stops the tool loop at MAX_TOOL_STEPS", async () => {
    stub.replay(["tool.1", "tool.1", "tool.1"]);
    const run = await runCli(["ask", "time?", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, MAX_TOOL_STEPS: "2" },
    });
    stub.replay([]);
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests).toHaveLength(2);
    expect(ndjson(run.stdout).at(-1)).toMatchObject({ type: "done", finishReason: "tool-calls" });
  });

  it("logs one llm call line with tokens and cost, and no prompt text", async () => {
    const run = await runCli(["ask", "a very private prompt"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    const calls = run.logs.filter((r) => r.msg === "llm call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      requestedModel: "openai/gpt-test",
      inputTokens: 12,
      cost: 0.00042,
      aborted: false,
    });
    expect(JSON.stringify(run.logs)).not.toContain("very private");
  });

  it("marks a reply interrupted when the consumer stops early, as the TUI does on Esc", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    vi.stubEnv("LOG_LEVEL", "error");
    stub.completion = { ...stub.completion, text: "one two three four" };
    stub.hangAfter = 2;
    const ended: AssistantMessage[] = [];
    try {
      await runScript(
        Effect.gen(function* () {
          const context = yield* Effect.context<ScriptServices>();
          const turn = runTurn({
            history: [{ role: "user", text: "hi" }],
            modelId: "openai/gpt-test",
            onEnd: (reply) => Effect.sync(() => ended.push(reply)),
          });
          yield* Effect.promise(async () => {
            for await (const event of Stream.toAsyncIterableWith(turn, context)) {
              if (event.type === "text") break;
            }
          });
        }),
      );
    } finally {
      stub.completion = { ...stub.completion, text: "Hello from the stub." };
      vi.unstubAllEnvs();
    }
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ text: "one ", interrupted: true });
  });
});

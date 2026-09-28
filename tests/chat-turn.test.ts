import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "~/core/chat";
import { resolveToolModel } from "~/core/models";
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
  stub.dropAfter = undefined;
  stub.failCompletions = undefined;
  stub.chatRequests.length = 0;
  stub.toolCalls = [];
  stub.steps = [];
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

  it("doesn't retry once text has gone out, so nothing prints twice", async () => {
    stub.completion = { ...stub.completion, text: "one two three four" };
    stub.dropAfter = 2;
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    stub.completion = { ...stub.completion, text: "Hello from the stub." };
    expect(run.exitCode).toBe(4);
    expect(stub.chatRequests).toHaveLength(1);
    const text = ndjson(run.stdout).filter((e) => e.type === "text");
    expect(text.map((e) => e.delta).join("")).toBe("one two ");
  });

  it("saves nothing when a turn fails before any output, and logs why", async () => {
    stub.failCompletions = { status: 401, body: { error: { message: "No auth", code: 401 } } };
    const run = await runCli(["ask", "hi"], { env: { OPENROUTER_BASE_URL: stub.baseUrl } });
    expect(run.exitCode).toBe(4);
    const chats = await runCli(["chats", "--json"], { root: run.root });
    expect(JSON.parse(chats.stdout)).toEqual([]);
    const call = run.logs.find((r) => r.msg === "llm call");
    expect(call).toMatchObject({ aborted: false, errorTag: "UpstreamUnavailable" });
    expect(String(call?.errorDetail)).toContain("401");
  });

  it("stops the tool loop at MAX_TOOL_STEPS", async () => {
    stub.replay(["tool.1", "tool.1", "tool.1"]);
    const run = await runCli(["ask", "time?", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, MAX_TOOL_STEPS: "2" },
    });
    stub.replay([]);
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests).toHaveLength(2);
    const events = ndjson(run.stdout);
    expect(events.at(-2)).toMatchObject({ type: "note" });
    expect(String(events.at(-2)?.message)).toContain(
      "Stopped after 2 model steps (MAX_TOOL_STEPS)",
    );
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "tool-calls" });
  });

  it("ends the turn with a note when the model repeats one call with the same input", async () => {
    const same = { name: "currentTime", arguments: '{"timeZone":"UTC"}' };
    stub.toolCalls = [same, same, same, same];
    const run = await runCli(["ask", "time?", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(0);
    // The third identical call still runs; the model isn't prompted a fourth time.
    expect(stub.chatRequests).toHaveLength(3);
    const events = ndjson(run.stdout);
    expect(events.filter((e) => e.type === "tool-result")).toHaveLength(3);
    expect(events.at(-2)).toMatchObject({
      type: "note",
      message: "Stopped: the model called currentTime with the same input 3 times in a row.",
    });
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "tool-calls" });
  });

  it("keeps going when a repeated call's input changes", async () => {
    const utc = { name: "currentTime", arguments: '{"timeZone":"UTC"}' };
    const paris = { name: "currentTime", arguments: '{"timeZone":"Europe/Paris"}' };
    stub.toolCalls = [utc, utc, paris, utc];
    const run = await runCli(["ask", "time?", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests).toHaveLength(5);
    const events = ndjson(run.stdout);
    expect(events.some((e) => e.type === "note")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("doesn't time out a slow reply whose chunks keep arriving within MAX_STREAM_SECONDS", async () => {
    // Six chunks 400 ms apart: 2.4 s in all, never 1 s without a chunk.
    stub.steps = [{ text: "one two three four", delayMs: 400 }];
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, MAX_STREAM_SECONDS: "1" },
    });
    expect(run.exitCode).toBe(0);
    const events = ndjson(run.stdout);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join(""),
    ).toBe("one two three four");
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("doesn't count a long tool run toward the idle timeout", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "orx-idle-")));
    stub.toolCalls = [{ name: "bash", arguments: JSON.stringify({ command: "sleep 2" }) }];
    const run = await runCli(
      ["ask", "wait", "--agent", "--cwd", root, "--permission-mode", "yolo", "--json"],
      { env: { OPENROUTER_BASE_URL: stub.baseUrl, MAX_STREAM_SECONDS: "1" } },
    );
    expect(run.exitCode).toBe(0);
    const events = ndjson(run.stdout);
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({
      name: "bash",
      isFailure: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "done", finishReason: "stop" });
  });

  it("returns a tool's bad input to the model instead of failing the turn", async () => {
    stub.toolCalls = [{ name: "currentTime", arguments: '{"timeZone":"Paris"}' }];
    const run = await runCli(["ask", "time in Paris?", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests).toHaveLength(2);
    const second = stub.chatRequests[1] as { messages: Array<{ role: string; content: unknown }> };
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMessage?.content)).toContain("ToolParameterValidationError");
    // Usage and cost are summed over both steps.
    expect(ndjson(run.stdout).at(-1)).toMatchObject({
      type: "done",
      finishReason: "stop",
      usage: { inputTokens: 24, outputTokens: 10, cost: 0.00084 },
    });
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

describe("resolveToolModel", () => {
  const models = [
    { id: "openai/gpt-test", name: "OpenAI: GPT Test" },
    { id: "acme/no-tools", name: "Acme: No Tools", tools: false },
  ];
  const resolve = async (requested: string | undefined, env: Record<string, string> = {}) => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    vi.stubEnv("LOG_LEVEL", "error");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const saved = stub.models;
    stub.models = models;
    try {
      return await runScript(
        Effect.result(resolveToolModel(requested)).pipe(
          Effect.map((result) =>
            result._tag === "Success"
              ? { model: result.success }
              : { error: result.failure._tag, message: result.failure.message },
          ),
        ),
      );
    } finally {
      stub.models = saved;
      vi.unstubAllEnvs();
    }
  };

  it("accepts a model that supports tools", async () => {
    expect(await resolve("openai/gpt-test")).toEqual({ model: "openai/gpt-test" });
  });

  it("rejects a model without tool calling, named or the default, as UnknownModel", async () => {
    const named = await resolve("acme/no-tools:nitro");
    expect(named).toMatchObject({ error: "UnknownModel" });
    expect(named.message).toContain("acme/no-tools:nitro doesn't support tool calling");
    expect(await resolve(undefined, { OPENROUTER_MODEL: "acme/no-tools" })).toMatchObject({
      error: "UnknownModel",
    });
  });

  it("trusts the model when the models list is unavailable", async () => {
    stub.failModels = 10;
    try {
      expect(await resolve(undefined, { OPENROUTER_MODEL: "acme/no-tools" })).toEqual({
        model: "acme/no-tools",
      });
    } finally {
      stub.failModels = 0;
    }
  });
});

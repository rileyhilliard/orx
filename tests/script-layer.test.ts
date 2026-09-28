// The layer bun scripts (evals, the fixture recorder) run orx's programs with, against the stub
// OpenRouter: the real config, Llm, and @effect/ai-openrouter, over a custom fetch.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Stream } from "effect";
import { newChat, runTurn, sendMessage } from "~/core/chat";
import { extractContact } from "~/core/extract";
import { LoggerLayer } from "~/runtime";
import type { ChatId } from "~/schemas";
import { ChatStore } from "~/services/ChatStore";
import { runScript, type ScriptFetch } from "../scripts/lib/script-layer";
import { restoreEnv, stubEnv } from "./helpers/env";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

// One chat turn the way evals and the recorder make one: orx's runTurn, which logs an
// `llm call` line along the way.
const chatTurn = Stream.runCollect(
  runTurn({ history: [{ role: "user", text: "hi" }], modelId: "openai/gpt-test" }),
);

describe("script layer", () => {
  let stub: StubOpenRouter;
  let dir: string;

  beforeEach(async () => {
    stub = await startStubOpenRouter();
    dir = mkdtempSync(join(tmpdir(), "orx-script-layer-"));
    stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    stubEnv("SYSTEM_PROMPT", "Be terse.");
    stubEnv("MAX_OUTPUT_TOKENS", "77");
    stubEnv("ORX_DATA_DIR", join(dir, "data"));
    stubEnv("ORX_LOG_FILE", join(dir, "orx.jsonl"));
    stubEnv("LOG_LEVEL", "error");
  });

  afterEach(async () => {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  });

  it("runs a turn through the custom fetch, which can read the response body", async () => {
    const fetched: Array<{ url: string; body: Promise<string> }> = [];
    const teeFetch: ScriptFetch = async (input, init) => {
      const response = await fetch(input, init);
      if (response.body === null) return response;
      const [forClient, forTest] = response.body.tee();
      const url = input instanceof Request ? input.url : String(input);
      fetched.push({ url, body: new Response(forTest).text() });
      return new Response(forClient, { status: response.status, headers: response.headers });
    };

    const events = await runScript(chatTurn, { fetch: teeFetch });

    expect(events.at(-1)).toMatchObject({
      type: "finish",
      reply: { text: "Hello from the stub.", finishReason: "stop" },
    });
    expect(fetched.map((request) => request.url)).toEqual([`${stub.baseUrl}/chat/completions`]);
    expect(await fetched[0]?.body).toContain('"content":"Hello from the stub."');
    expect(stub.chatRequests[0]).toMatchObject({
      model: "openai/gpt-test",
      max_tokens: 77,
      messages: [
        { role: "system", content: [{ type: "text", text: "Be terse." }] },
        { role: "user" },
      ],
      tools: [{ type: "function", function: { name: "currentTime" } }],
    });
  });

  it("keeps chats in memory, not in the data dir", async () => {
    const id = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b" as ChatId;
    const saved = await runScript(
      Effect.gen(function* () {
        yield* Stream.runDrain(
          sendMessage(newChat(id, "openai/gpt-test"), "hi", "openai/gpt-test"),
        );
        return yield* (yield* ChatStore).get(id);
      }),
    );
    expect(Option.getOrThrow(saved).messages).toHaveLength(2);
    expect(existsSync(join(dir, "data"))).toBe(false);
  });

  it("reports extract's cost and served model, which evals show", async () => {
    stub.completion = {
      ...stub.completion,
      model: "openai/gpt-test-2026",
      text: JSON.stringify({ name: "Ada", email: null, phone: null, company: null }),
    };
    const result = await runScript(extractContact("Ada", "openai/gpt-test"));
    expect(result).toEqual({
      contact: { name: "Ada", email: null, phone: null, company: null },
      usage: { inputTokens: 12, outputTokens: 5, cost: 0.00042 },
      model: "openai/gpt-test-2026",
    });
  });

  it("logs to stderr only, even with ORX_LOG_FILE set", async () => {
    stubEnv("LOG_LEVEL", "info");
    await runScript(chatTurn);
    expect(existsSync(join(dir, "orx.jsonl"))).toBe(false);

    // Control: the CLI's logger, same env and program, does write the file.
    await runScript(chatTurn.pipe(Effect.provide(LoggerLayer)));
    expect(existsSync(join(dir, "orx.jsonl"))).toBe(true);
  });
});

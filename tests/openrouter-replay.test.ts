// Recorded OpenRouter responses (tests/fixtures/openrouter/, `bun run record:openrouter`)
// replayed through orx and the real @effect/ai-openrouter provider. The expected values are
// read from the recordings themselves, so a re-record keeps this passing unless the provider
// stops parsing what OpenRouter actually sends: text, tool calls, tokens, cost, served model.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Stream } from "effect";
import { runTurn } from "~/core/chat";
import { runScript } from "../scripts/lib/script-layer";
import { askEvents, runCli } from "./helpers/cli";
import { restoreEnv, stubEnv } from "./helpers/env";
import { FIXTURES_DIR, type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";
import { testToolkit } from "./helpers/tools";

interface Chunk {
  model?: string;
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
}

/** What a recording says: its text, token counts, cost, and the model that served it. */
const recorded = (name: string) => {
  const chunks = readFileSync(`${FIXTURES_DIR}${name}.sse`, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Chunk);
  const usage = chunks.findLast((c) => c.usage)?.usage;
  return {
    text: chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join(""),
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cost: usage?.cost ?? 0,
    model: chunks.find((c) => c.model)?.model,
  };
};

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

const ask = (text: string) =>
  runCli(["ask", text, "--json"], {
    // The recordings' model, so the models-list check is skipped (it's the default).
    env: { OPENROUTER_BASE_URL: stub.baseUrl, OPENROUTER_MODEL: recorded("plain.1").model ?? "" },
  });

describe.each([
  { label: "whole", chunkSize: undefined },
  { label: "in 7-byte pieces", chunkSize: 7 },
])("replayed OpenRouter streams ($label)", ({ chunkSize }) => {
  it("reads a plain reply's text, tokens, cost, and served model", async () => {
    stub.replay(["plain.1"], { chunkSize });
    const run = await ask("hi");
    const expected = recorded("plain.1");
    expect(run.exitCode).toBe(0);
    const events = askEvents(run.stdout);
    const text = events.filter((e) => e.type === "text").map((e) => e.delta);
    expect(text.join("")).toBe(expected.text);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      model: expected.model,
      usage: {
        inputTokens: expected.inputTokens,
        outputTokens: expected.outputTokens,
        cost: expected.cost,
      },
    });
  });

  it("runs the recorded tool call and sums usage over both requests", async () => {
    // The recorder's tool turn offers the tests' currentTime tool, so this turn does too.
    stub.replay(["tool.1", "tool.2"], { chunkSize });
    stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    stubEnv("LOG_LEVEL", "error");
    const events = await runScript(
      Stream.runCollect(
        runTurn({
          history: [{ role: "user", text: "What time is it in Tokyo?" }],
          modelId: recorded("tool.1").model ?? "",
          toolkit: testToolkit,
        }),
      ),
    ).finally(restoreEnv);
    const [first, second] = [recorded("tool.1"), recorded("tool.2")];
    expect(events.find((e) => e.type === "tool-call")).toMatchObject({ name: "currentTime" });
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ isFailure: false });
    const finish = events.at(-1);
    if (finish?.type !== "finish") throw new Error(`the turn ended with ${finish?.type}`);
    expect(finish.reply.finishReason).toBe("stop");
    expect(finish.reply.usage?.inputTokens).toBe(first.inputTokens + second.inputTokens);
    expect(finish.reply.usage?.cost).toBeCloseTo(first.cost + second.cost, 12);
  });
});

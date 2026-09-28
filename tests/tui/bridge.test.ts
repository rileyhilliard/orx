import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { newChat } from "~/core/chat";
import { type LogRecord, toEntry, toRecord } from "~/logging";
import { AppLayer } from "~/runtime";
import type { ChatId } from "~/schemas";
import { FileState } from "~/services/file-state";
import { Permissions } from "~/services/permissions";
import { ChatTools } from "~/tools";
import { makeBridge } from "~/tui/launch";
import type { ChatBridge, UiEvent } from "~/tui/types";
import { type StubOpenRouter, startStubOpenRouter } from "../helpers/stub-openrouter";

// The bridge's own copy of the chat, which the next turn sends as history: it follows what each
// turn saved, without reading the chat back from disk.

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.chatRequests.length = 0;
  stub.failCompletions = undefined;
  stub.hangAfter = undefined;
  stub.steps = [];
});

const chatId = "3c2b1a09-0000-4000-8000-000000000000" as ChatId;

/** Runs `use` with a real bridge over a new chat, and returns what it returned and the logs. */
const withBridge = async <A>(use: (bridge: ChatBridge) => Promise<A>) => {
  const root = mkdtempSync(join(tmpdir(), "orx-bridge-"));
  const logs: LogRecord[] = [];
  const layer = AppLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            OPENROUTER_API_KEY: "sk-or-test",
            OPENROUTER_BASE_URL: stub.baseUrl,
            HOME: root,
            XDG_CONFIG_HOME: join(root, "config"),
            ORX_DATA_DIR: join(root, "data"),
          },
        }),
      ),
    ),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const { bridge } = yield* makeBridge(newChat(chatId, "openai/gpt-test"), () => {}, {
        root,
        toolkit: ChatTools,
        systemPrompt: "You are a test.",
        listFiles: Effect.succeed([]),
        attachFiles: () => Effect.succeed(""),
      });
      return yield* Effect.promise(() => use(bridge));
    }).pipe(
      // The session's own services; the chat tools here never ask.
      Effect.provide(Layer.mergeAll(FileState.layer, Permissions.layer())),
      Effect.provide(layer),
      Effect.provide(Logger.layer([Logger.make((entry) => logs.push(toRecord(toEntry(entry))))])),
    ),
  );
  return { result, logs };
};

const drain = async (turn: AsyncIterable<UiEvent>) => {
  const events: UiEvent[] = [];
  for await (const event of turn) events.push(event);
  return events;
};

/** The roles and text the stub received in a request, system prompt left out. */
const history = (index: number) =>
  (stub.chatRequests[index] as { messages: Array<{ role: string; content: unknown }> }).messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}: ${JSON.stringify(m.content)}`);

describe("the bridge's chat", () => {
  it("stays as it was when a new chat's first turn fails before any output, and logs nothing", async () => {
    const { result, logs } = await withBridge(async (bridge) => {
      stub.failCompletions = { status: 401, times: 1 };
      const failed = await drain(bridge.send("first", "openai/gpt-test"));
      const next = await drain(bridge.send("second", "openai/gpt-test"));
      return { failed, next };
    });
    expect(result.failed.at(-1)).toMatchObject({ type: "error" });
    expect(result.next.at(-1)).toMatchObject({ type: "done" });
    // Nothing was saved for the failed turn, and nothing went wrong beyond the error shown.
    expect(logs.filter((r) => r.level === "warn" || r.level === "error")).toEqual([]);
    expect(history(stub.chatRequests.length - 1)).toEqual(['user: "second"']);
  });

  it("carries a finished turn, and a reply stopped part way, into the next turn", async () => {
    await withBridge(async (bridge) => {
      await drain(bridge.send("hello", "openai/gpt-test"));
      stub.completion = { ...stub.completion, text: "one two three four" };
      stub.hangAfter = 2;
      try {
        // Esc: the TUI stops the turn's iterator after the first text.
        for await (const event of bridge.send("count", "openai/gpt-test")) {
          if (event.type === "text") break;
        }
      } finally {
        stub.hangAfter = undefined;
        stub.completion = { ...stub.completion, text: "Hello from the stub." };
      }
      await drain(bridge.send("go on", "openai/gpt-test"));
    });
    expect(history(stub.chatRequests.length - 1)).toEqual([
      'user: "hello"',
      'assistant: "Hello from the stub."',
      'user: "count"',
      'assistant: "one "',
      'user: "go on"',
    ]);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import { newChat, sendMessage } from "~/core/chat";
import { ChatId, type StoredChat } from "~/schemas";
import { ChatStore } from "~/services/ChatStore";
import { FileState } from "~/services/file-state";
import { Permissions } from "~/services/permissions";
import { Workspace } from "~/services/workspace";
import { AgentTools, AgentToolsLive } from "~/tools/agent";
import { runScript, type ScriptServices } from "../scripts/lib/script-layer";
import { restoreEnv, stubEnv } from "./helpers/env";
import {
  type StubModel,
  type StubOpenRouter,
  startStubOpenRouter,
} from "./helpers/stub-openrouter";

// Keeping a long tool loop inside the model's window, through the real turn loop: old tool
// outputs are elided in what is sent (never in what is saved) once the prompt passes 60% of
// the model's context_length, and a context-length rejection is retried once, harder-elided.

let stub: StubOpenRouter;
let models: StubModel[];
beforeAll(async () => {
  stub = await startStubOpenRouter();
  models = stub.models;
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.chatRequests.length = 0;
  stub.steps = [];
  stub.failCompletions = undefined;
  stub.models = [...models, { id: "acme/small", name: "Acme: Small", context_length: 10_000 }];
  stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
  stubEnv("LOG_LEVEL", "error");
});
afterEach(() => {
  stub.models = models;
  restoreEnv();
});

const FILES = ["a.txt", "b.txt", "c.txt", "d.txt"];

/**
 * A workspace with four files of about 8,600 characters each as `read` returns them (about
 * 2,150 estimated tokens each), so three of them pass 60% of a 10,000-token window.
 */
const workspace = (files = FILES, lines = 80) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orx-context-")));
  for (const name of files) {
    const line = `${name} `.repeat(20);
    writeFileSync(join(root, name), `${Array.from({ length: lines }, () => line).join("\n")}\n`);
  }
  return root;
};

/** One step per file read, each its own model step, then a closing text step. */
const readEachFile = (files = FILES) => [
  ...files.map((path) => ({ toolCalls: [{ name: "read", arguments: JSON.stringify({ path }) }] })),
  { text: "Read them all." },
];

type WireMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { arguments: string } }>;
};

/** Each tool result a request carries, as `<file>:full` or `<file>:elided`, in order. */
const toolResults = (request: unknown) => {
  const messages = (request as { messages: WireMessage[] }).messages;
  const paths = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      paths.set(call.id, (JSON.parse(call.function.arguments) as { path: string }).path);
    }
  }
  return messages.flatMap((message) => {
    if (message.role !== "tool" || message.tool_call_id === undefined) return [];
    const path = paths.get(message.tool_call_id) ?? "?";
    const text = JSON.stringify(message.content);
    if (text.includes(`[read ${path} output elided, re-run if needed]`)) return [`${path}:elided`];
    return text.includes(`${path} ${path}`) ? [`${path}:full`] : [`${path}:?`];
  });
};

const chatId = Schema.decodeSync(ChatId)("5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d");

const sessionLayer = (root: string) =>
  AgentToolsLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Workspace.layerTest(root), FileState.layer, Permissions.layer("default")),
    ),
  );

/** Runs `program` with a coding session over `root`, where reads need no approval. */
const inSession = <A, E>(
  root: string,
  program: Effect.Effect<A, E, ScriptServices | Layer.Success<ReturnType<typeof sessionLayer>>>,
) => runScript(program.pipe(Effect.provide(sessionLayer(root))));

/** Sends `text` in the saved chat (or a new one) and returns the chat as saved afterwards. */
const send = (text: string, model: string) =>
  Effect.gen(function* () {
    const store = yield* ChatStore;
    const chat: StoredChat = Option.getOrElse(yield* store.get(chatId), () =>
      newChat(chatId, model),
    );
    yield* Stream.runDrain(sendMessage(chat, text, model, { toolkit: AgentTools }));
    return Option.getOrThrow(yield* store.get(chatId));
  });

describe("the context window in a turn", () => {
  it("elides the oldest tool outputs once a step passes 60% of the window, sparing the last two steps", async () => {
    const root = workspace();
    stub.steps = readEachFile();
    const saved = await inSession(root, send("read every file", "acme/small"));

    expect(stub.chatRequests.map(toolResults)).toEqual([
      [],
      ["a.txt:full"],
      ["a.txt:full", "b.txt:full"],
      // a, b, and c pass 6,000 tokens: a goes, and b and c are the last two steps.
      ["a.txt:elided", "b.txt:full", "c.txt:full"],
      ["a.txt:elided", "b.txt:elided", "c.txt:full", "d.txt:full"],
    ]);
    // Only what was sent is elided: the chat keeps every output.
    const reply = saved.messages.at(-1);
    expect(reply).toMatchObject({ role: "assistant", text: "Read them all." });
    const outputs = reply?.role === "assistant" ? reply.tools.map((t) => String(t.output)) : [];
    expect(outputs).toHaveLength(4);
    for (const [index, name] of FILES.entries()) {
      expect(outputs[index]).toContain(`${name} ${name}`);
      expect(outputs[index]).not.toContain("elided");
    }
  });

  it("elides down to 40% once past 60%, then reuses that set, so the next steps send an identical prefix", async () => {
    // Eight files of about 1,000 estimated tokens each: one more per step.
    const files = Array.from({ length: 8 }, (_, i) => `f${i + 1}.txt`);
    const root = workspace(files, 36);
    stub.steps = readEachFile(files);
    await inSession(root, send("read every file", "acme/small"));

    // Each request's tool results, `e` elided and `f` full, oldest first.
    const shapes = stub.chatRequests.map((request) =>
      toolResults(request)
        .map((result) => (result.endsWith(":elided") ? "e" : "f"))
        .join(""),
    );
    // Crossing 60% elides several at once (down to 40%), not one more per step; the next steps
    // reuse the set, and only crossing 60% again extends it.
    expect(shapes).toEqual([
      "",
      "f",
      "ff",
      "fff",
      "ffff",
      "eeeff",
      "eeefff",
      "eeeffff",
      "eeeeeeff",
    ]);
    // A step that elides nothing new starts with exactly the messages the one before it sent,
    // so the provider's prompt cache keeps hitting.
    const messages = stub.chatRequests.map((r) => (r as { messages: WireMessage[] }).messages);
    for (const index of [6, 7]) {
      const previous = messages[index - 1] ?? [];
      expect(messages[index]?.slice(0, previous.length)).toEqual(previous);
    }
  });

  it("doesn't elide anything for a model whose window it fits in", async () => {
    const root = workspace();
    stub.steps = readEachFile();
    await inSession(root, send("read every file", "openai/gpt-test"));
    expect(stub.chatRequests).toHaveLength(5);
    expect(toolResults(stub.chatRequests[4])).toEqual(FILES.map((name) => `${name}:full`));
  });

  const tooLong = (times: number) => ({
    status: 400,
    body: {
      error: {
        message:
          "This endpoint's maximum context length is 128000 tokens. However, you requested about 140000 tokens.",
        code: 400,
      },
    },
    times,
  });

  it("retries a context-length rejection once with old tool outputs elided, and the turn goes on", async () => {
    const root = workspace();
    stub.steps = readEachFile();
    // The first turn fits (128k window): nothing elided, all four outputs saved.
    await inSession(
      root,
      Effect.gen(function* () {
        yield* send("read every file", "openai/gpt-test");
        stub.chatRequests.length = 0;
        // The provider counts differently and rejects the next turn's first request.
        stub.failCompletions = tooLong(1);
        stub.steps = [{ text: "Here's the summary." }];
        const saved = yield* send("now summarize", "openai/gpt-test");
        expect(saved.messages.at(-1)).toMatchObject({
          role: "assistant",
          text: "Here's the summary.",
        });
        expect(saved.messages.at(-1)).not.toHaveProperty("interrupted");
      }),
    );
    expect(stub.chatRequests.map(toolResults)).toEqual([
      FILES.map((name) => `${name}:full`),
      // The retry elides every candidate, still sparing the last two tool steps.
      ["a.txt:elided", "b.txt:elided", "c.txt:full", "d.txt:full"],
    ]);
  });

  it("fails the turn when the elided retry is rejected too, without trying again", async () => {
    const root = workspace();
    stub.steps = readEachFile();
    const failure = await inSession(
      root,
      Effect.gen(function* () {
        yield* send("read every file", "openai/gpt-test");
        stub.chatRequests.length = 0;
        stub.failCompletions = tooLong(3);
        return yield* Effect.flip(send("now summarize", "openai/gpt-test"));
      }),
    );
    expect(failure).toMatchObject({ _tag: "UpstreamUnavailable", retryable: false });
    expect(stub.chatRequests).toHaveLength(2);
  });
});

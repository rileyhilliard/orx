import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERRUPTED_RESULT, newChat, runTurn, sendMessage, type TurnEvent } from "~/core/chat";
import { ChatId, type StoredChat } from "~/schemas";
import { ChatStore } from "~/services/ChatStore";
import { FileState } from "~/services/file-state";
import { type PermissionMode, Permissions } from "~/services/permissions";
import { Workspace } from "~/services/workspace";
import { AgentTools, AgentToolsLive } from "~/tools/agent";
import { runScript } from "../scripts/lib/script-layer";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

// Stopping a turn while a tool is waiting (on the user's approval, or on a running command):
// what the user, the saved chat, the next request, and the machine's process table see.

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.chatRequests.length = 0;
  stub.toolCalls = [];
  stub.steps = [];
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  vi.stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
  vi.stubEnv("LOG_LEVEL", "error");
  return () => vi.unstubAllEnvs();
});

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "orx-interrupt-")));

const sessionLayer = (root: string, mode: PermissionMode) =>
  AgentToolsLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Workspace.layerTest(root), FileState.layer, Permissions.layer(mode)),
    ),
  );

/**
 * The three ways a turn stops early. `esc`: the TUI's Esc, `iterator.return()` while a `next()`
 * is still waiting (the turn is blocked, so nothing is being yielded). `break`: a `for await`
 * that stops after an event. `signal`: Ctrl+C / SIGINT, the consuming fiber interrupted.
 */
type StopHow = "esc" | "break" | "signal";

/**
 * Runs `turn` until `stopAt` says an event is the point to stop, then stops it `how`. `ready`
 * runs after that event, before stopping (to wait on something the event started).
 */
const stopTurn = <R>(
  turn: Stream.Stream<TurnEvent, unknown, R>,
  how: StopHow,
  stopAt: (event: TurnEvent) => boolean,
  ready: () => Promise<void> = async () => {},
) =>
  Effect.gen(function* () {
    const seen: TurnEvent[] = [];
    if (how === "signal") {
      const reached = yield* Deferred.make<void>();
      const fiber = yield* turn.pipe(
        Stream.runForEach((event) => {
          seen.push(event);
          return stopAt(event) ? Deferred.succeed(reached, undefined) : Effect.void;
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(reached);
      yield* Effect.promise(ready);
      yield* Fiber.interrupt(fiber);
      return seen;
    }
    const context = yield* Effect.context<R>();
    yield* Effect.promise(async () => {
      const iterator = Stream.toAsyncIterableWith(turn, context)[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("the turn ended before the point to stop it");
        seen.push(next.value);
        if (stopAt(next.value)) break;
      }
      await ready();
      if (how === "esc") {
        // The TUI's loop is parked in next() when Esc arrives; return() lands meanwhile.
        const pending = iterator.next();
        await iterator.return?.();
        await pending.catch(() => undefined);
      } else {
        await iterator.return?.();
      }
    });
    return seen;
  });

type WireMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string }>;
};

const messagesOf = (request: unknown) => (request as { messages: WireMessage[] }).messages;

/** Tool call ids the request's assistant messages make, and the ids its tool messages answer. */
const callsAndAnswers = (request: unknown) => {
  const messages = messagesOf(request);
  return {
    calls: messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)),
    answers: messages.flatMap((m) => (m.role === "tool" && m.tool_call_id ? [m.tool_call_id] : [])),
  };
};

const chatId = Schema.decodeSync(ChatId)("7d1c9a0e-2b3f-4c5d-8e6f-0a1b2c3d4e5f");

describe("stopping a turn while an approval is open", () => {
  it.each<StopHow>(["esc", "break", "signal"])(
    "(%s) cancels the approval, doesn't run the tool, and the next turn answers every call",
    async (how) => {
      const root = tempDir();
      stub.steps = [
        {
          text: "Running it.",
          toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "touch ran.txt" }) }],
        },
        { text: "Understood." },
      ];
      const { seen, leftover, saved } = await runScript(
        Effect.gen(function* () {
          const permissions = yield* Permissions;
          const store = yield* ChatStore;
          const chat: StoredChat = newChat(chatId, "openai/gpt-test", root);
          const turn = sendMessage(chat, "run it", "openai/gpt-test", { toolkit: AgentTools });
          const seen = yield* stopTurn(turn, how, (e) => e.type === "approval-request");
          // What the turn's own stream no longer carries after it stopped is left for the
          // session's next reader: the request's cancellation.
          const [leftover] = yield* Stream.runCollect(Stream.take(permissions.events, 1));
          const saved = Option.getOrThrow(yield* store.get(chatId));
          yield* Stream.runDrain(
            sendMessage(saved, "never mind", "openai/gpt-test", { toolkit: AgentTools }),
          );
          return { seen, leftover, saved };
        }).pipe(Effect.provide(sessionLayer(root, "default"))),
      );

      const request = seen.find((e) => e.type === "approval-request");
      expect(request).toMatchObject({ tool: "bash", summary: "touch ran.txt" });
      expect(leftover).toEqual({ type: "approval-cancelled", id: request?.id });
      expect(existsSync(join(root, "ran.txt"))).toBe(false);

      // The saved reply is marked interrupted, and its bash call has the synthetic result.
      const reply = saved.messages.at(-1);
      expect(reply).toMatchObject({
        role: "assistant",
        text: "Running it.",
        interrupted: true,
        tools: [
          {
            name: "bash",
            input: { command: "touch ran.txt" },
            output: INTERRUPTED_RESULT,
            isFailure: true,
          },
        ],
      });

      // The next turn's request replays the call with an answer, or the provider would reject it.
      expect(stub.chatRequests).toHaveLength(2);
      const { calls, answers } = callsAndAnswers(stub.chatRequests[1]);
      expect(calls).toEqual(["call_stub_1"]);
      expect(answers).toEqual(["call_stub_1"]);
      const answer = messagesOf(stub.chatRequests[1]).find((m) => m.role === "tool");
      expect(JSON.stringify(answer?.content)).toContain(INTERRUPTED_RESULT);
    },
  );
});

/** Whether a process with this pid is still alive. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const pidIn = (root: string, name: string) =>
  Number.parseInt(readFileSync(join(root, name), "utf8").trim(), 10);

describe("stopping a turn while bash runs", () => {
  // The shell records its own pid, a child `sh`, and that child's background `sleep` (a
  // grandchild of orx that the shell doesn't wait for), then everything sleeps for 30 s.
  const command = [
    "echo $$ > shell.pid",
    "sh -c 'sleep 30 & echo $! > grandchild.pid; echo $$ > child.pid; wait'",
  ].join("; ");

  it.each<StopHow>(["esc", "signal"])(
    "(%s) kills the command, its child, and its grandchild",
    async (how) => {
      const root = tempDir();
      stub.steps = [{ toolCalls: [{ name: "bash", arguments: JSON.stringify({ command }) }] }];
      const pidsWritten = () =>
        vi.waitFor(
          () => {
            for (const name of ["shell.pid", "child.pid", "grandchild.pid"]) {
              expect(Number.isNaN(pidIn(root, name))).toBe(false);
            }
          },
          { timeout: 10_000, interval: 20 },
        );
      const started = Date.now();
      const seen = await runScript(
        stopTurn(
          runTurn({
            history: [{ role: "user", text: "wait around" }],
            modelId: "openai/gpt-test",
            toolkit: AgentTools,
          }),
          how,
          (e) => e.type === "tool-call",
          pidsWritten,
        ).pipe(Effect.provide(sessionLayer(root, "yolo"))),
      );
      expect(seen.map((e) => e.type)).toContain("tool-call");
      const pids = ["shell.pid", "child.pid", "grandchild.pid"].map((name) => pidIn(root, name));
      // The kill is SIGTERM, then SIGKILL after two seconds for anything that ignored it.
      await vi.waitFor(
        () => {
          expect(pids.filter(alive)).toEqual([]);
        },
        { timeout: 5_000, interval: 50 },
      );
      expect(Date.now() - started).toBeLessThan(20_000);
    },
    20_000,
  );
});

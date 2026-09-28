import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { runTurn, type TurnEvent } from "~/core/chat";
import { FileState } from "~/services/file-state";
import { Permissions } from "~/services/permissions";
import { Workspace } from "~/services/workspace";
import { AgentTools, AgentToolsLive } from "~/tools/agent";
import type { ScriptServices } from "../scripts/lib/script-layer";
import { runScript } from "../scripts/lib/script-layer";
import { restoreEnv, stubEnv } from "./helpers/env";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

describe("an agent turn with approvals", () => {
  it("emits approval-request and runs the tool only after answer(yes)", async () => {
    stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    stubEnv("LOG_LEVEL", "error");
    stub.toolCalls = [{ name: "bash", arguments: JSON.stringify({ command: "echo approved" }) }];
    const root = realpathSync(mkdtempSync(join(tmpdir(), "orx-approval-")));
    const session = AgentToolsLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(Workspace.layerTest(root), FileState.layer, Permissions.layer("default")),
      ),
    );
    try {
      const events = await runScript(
        Effect.gen(function* () {
          const permissions = yield* Permissions;
          const seen: TurnEvent[] = [];
          yield* runTurn({
            history: [{ role: "user", text: "run it" }],
            modelId: "openai/gpt-test",
            toolkit: AgentTools,
          }).pipe(
            Stream.runForEach((event) => {
              seen.push(event);
              return event.type === "approval-request"
                ? permissions.answer(event.id, "yes")
                : Effect.void;
            }),
          );
          return seen;
        }).pipe(Effect.provide(session)),
      );
      const types = events.map((e) => e.type);
      expect(types.indexOf("approval-request")).toBeGreaterThan(types.indexOf("tool-call"));
      expect(types.indexOf("tool-result")).toBeGreaterThan(types.indexOf("approval-request"));
      expect(events.find((e) => e.type === "approval-request")).toMatchObject({
        tool: "bash",
        summary: "echo approved",
        canAlways: true,
      });
      expect(events.find((e) => e.type === "tool-result")).toMatchObject({
        name: "bash",
        isFailure: false,
        output: "approved\n(exit code 0)",
      });
      expect(types.at(-1)).toBe("finish");
    } finally {
      restoreEnv();
    }
  });

  it("doesn't carry an approval request left over from a stopped turn into the next one", async () => {
    stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    stubEnv("LOG_LEVEL", "error");
    // Two parallel calls: the first asks, the second waits its turn to ask. Stopping the turn
    // leaves an approval-cancelled in the Permissions queue; the next turn must not show it.
    stub.steps = [
      {
        toolCalls: [
          { name: "bash", arguments: JSON.stringify({ command: "echo one" }) },
          { name: "bash", arguments: JSON.stringify({ command: "echo two" }) },
        ],
      },
      { text: "Second turn." },
    ];
    const root = realpathSync(mkdtempSync(join(tmpdir(), "orx-approval-")));
    const session = AgentToolsLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(Workspace.layerTest(root), FileState.layer, Permissions.layer("default")),
      ),
    );
    try {
      const second = await runScript(
        Effect.gen(function* () {
          const context = yield* Effect.context<ScriptServices | Layer.Success<typeof session>>();
          const turn = (text: string) =>
            runTurn({
              history: [{ role: "user", text }],
              modelId: "openai/gpt-test",
              toolkit: AgentTools,
            });
          // The user stops the first turn (Esc) while its first approval is open.
          yield* Effect.promise(async () => {
            for await (const event of Stream.toAsyncIterableWith(turn("run both"), context)) {
              if (event.type === "approval-request") break;
            }
          });
          const events: TurnEvent[] = [];
          yield* turn("say something").pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          );
          return events;
        }).pipe(Effect.provide(session)),
      );
      expect(second.map((e) => e.type)).toEqual(["text", "finish"]);
    } finally {
      stub.steps = [];
      restoreEnv();
    }
  });
});

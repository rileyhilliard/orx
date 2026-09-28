import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runTurn, type TurnEvent } from "~/core/chat";
import { FileState } from "~/services/file-state";
import { Permissions } from "~/services/permissions";
import { Workspace } from "~/services/workspace";
import { AgentTools, AgentToolsLive } from "~/tools/agent";
import { runScript } from "../scripts/lib/script-layer";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

describe("an agent turn with approvals", () => {
  it("emits approval-request and runs the tool only after answer(yes)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.stubEnv("OPENROUTER_BASE_URL", stub.baseUrl);
    vi.stubEnv("LOG_LEVEL", "error");
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
      vi.unstubAllEnvs();
    }
  });
});

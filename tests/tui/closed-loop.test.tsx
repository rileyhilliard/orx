import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { testRender } from "@opentui/react/test-utils";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { newChat } from "~/core/chat";
import { AppLayer } from "~/runtime";
import type { ChatId } from "~/schemas";
import { ChatStore } from "~/services/ChatStore";
import { App } from "~/tui/app";
import { makeBridge } from "~/tui/launch";
import { type StubOpenRouter, startStubOpenRouter } from "../helpers/stub-openrouter";

// The TUI against the real programs: App + makeBridge + AppLayer, with OpenRouter replaced by
// the stub. This is the check that the bridge's events and the components agree.

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

const layer = (root: string) =>
  AppLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
    Layer.provide(Logger.layer([])),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            OPENROUTER_API_KEY: "sk-or-test",
            OPENROUTER_MODEL: "openai/gpt-test",
            OPENROUTER_BASE_URL: stub.baseUrl,
            HOME: root,
            XDG_CONFIG_HOME: join(root, "config"),
            ORX_DATA_DIR: join(root, "data"),
          },
        }),
      ),
    ),
  );

const chatId = "0f0e0d0c-0000-4000-8000-000000000000" as ChatId;

describe("TUI closed loop", () => {
  it("streams a real turn from the stub, shows usage, and saves the chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "orx-tui-"));
    const program = Effect.gen(function* () {
      const bridge = yield* makeBridge(newChat(chatId, "openai/gpt-test"), () => {});
      setup = yield* Effect.promise(() =>
        testRender(<App bridge={bridge} />, { width: 80, height: 20 }),
      );
      const { mockInput, renderOnce, waitForFrame } = setup;
      yield* Effect.promise(async () => {
        await renderOnce();
        await mockInput.typeText("hi there");
        mockInput.pressEnter();
        await waitForFrame((f) => f.includes("12 in / 5 out"));
      });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Hello from the stub.");
      expect(frame).toContain("$0.000420");
      const saved = yield* Effect.flatMap(ChatStore, (store) => store.get(chatId));
      return saved;
    });
    const saved = await Effect.runPromise(program.pipe(Effect.provide(layer(root))));
    expect(saved._tag).toBe("Some");
    const file = readFileSync(join(root, "data", "chats", `${chatId}.json`), "utf8");
    expect(file).toContain("hi there");
    expect(file).toContain("Hello from the stub.");
  });

  it("shows the upstream error the programs produce", async () => {
    stub.failCompletions = { status: 401 };
    const root = mkdtempSync(join(tmpdir(), "orx-tui-"));
    const program = Effect.gen(function* () {
      const bridge = yield* makeBridge(newChat(chatId, "openai/gpt-test"), () => {});
      setup = yield* Effect.promise(() =>
        testRender(<App bridge={bridge} />, { width: 80, height: 20 }),
      );
      const { mockInput, renderOnce, waitForFrame } = setup;
      return yield* Effect.promise(async () => {
        await renderOnce();
        await mockInput.typeText("hi");
        mockInput.pressEnter();
        return waitForFrame((f) => /key/i.test(f) && f.includes("> hi"));
      });
    });
    const frame = await Effect.runPromise(program.pipe(Effect.provide(layer(root))));
    stub.failCompletions = undefined;
    expect(frame).not.toContain("send again to retry");
  });
});

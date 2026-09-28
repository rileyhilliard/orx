import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AppLayer } from "~/runtime";
import { App } from "~/tui/app";
import { makeBridge } from "~/tui/launch";
import { type StubOpenRouter, startStubOpenRouter } from "../helpers/stub-openrouter";
import { type RenderSetup, render, waitForScreen } from "./render";

// The TUI against the real programs: App + makeBridge + AppLayer, with OpenRouter replaced by
// the stub. This is the check that the bridge's replies and the components agree.

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

let setup: RenderSetup | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

const layer = () => {
  const root = mkdtempSync(join(tmpdir(), "orx-tui-"));
  return AppLayer.pipe(
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
};

// The programs log (`llm call`); keep that out of the test output.
const quiet = Effect.provide(Logger.layer([]));

/** Types `prompt`, presses Enter, and waits (with the real bridge's I/O) for `until`. */
const askThroughUi = (prompt: string, until: (frame: string) => boolean) =>
  Effect.gen(function* () {
    const bridge = yield* makeBridge(() => {});
    setup = yield* Effect.promise(() => render(<App bridge={bridge} />, { width: 80, height: 20 }));
    const screen = setup;
    return yield* Effect.promise(async () => {
      await screen.renderOnce();
      await screen.mockInput.typeText(prompt);
      screen.mockInput.pressEnter();
      return waitForScreen(screen, until);
    });
  }).pipe(Effect.provide(layer()), quiet);

describe("TUI closed loop", () => {
  it("asks the stub and shows the reply and usage", async () => {
    const frame = await Effect.runPromise(
      askThroughUi("hi there", (f) => f.includes("12 in / 5 out")),
    );
    expect(frame).toContain("Hello from the stub.");
    expect(frame).toContain("$0.000420");
    expect(stub.chatRequests.at(-1)).toMatchObject({
      messages: [{ role: "user", content: "hi there" }],
    });
  });

  it("shows the upstream error the programs produce, without a retry offer", async () => {
    stub.failCompletions = { status: 401 };
    const frame = await Effect.runPromise(askThroughUi("hi", (f) => /key/i.test(f)));
    stub.failCompletions = undefined;
    expect(frame).toContain("> hi");
    expect(frame).not.toContain("Send again to retry");
  });
});

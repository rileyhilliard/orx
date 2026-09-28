import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Logger, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { newChat } from "~/core/chat";
import { prepareSession } from "~/core/session";
import { AppLayer } from "~/runtime";
import type { ChatId } from "~/schemas";
import { ChatStore } from "~/services/ChatStore";
import { Host } from "~/services/Host";
import { App } from "~/tui/app";
import { makeBridge } from "~/tui/launch";
import type { ChatBridge, UiExpansion } from "~/tui/types";
import { type StubOpenRouter, startStubOpenRouter } from "../helpers/stub-openrouter";
import { type RenderSetup, render, waitForScreen } from "./render";

// The TUI against the real programs: App + makeBridge + a coding session (prepareSession) +
// AppLayer, with OpenRouter replaced by the stub. This is the check that the bridge's events and
// the components agree.

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

const layer = (root: string) =>
  AppLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        BunServices.layer,
        FetchHttpClient.layer,
        Host.layer({
          execPath: join(root, "bin", "orx"),
          compiled: false,
          platform: "darwin",
          arch: "arm64",
        }),
      ),
    ),
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

// The programs log (`llm call`); keep that out of the test output.
const quiet = Effect.provide(Logger.layer([]));

const chatId = "0f0e0d0c-0000-4000-8000-000000000000" as ChatId;

/** A home dir for the config and data (the workspace, inside it, can't be $HOME itself). */
const tempHome = () => realpathSync(mkdtempSync(join(tmpdir(), "orx-tui-")));

/**
 * Runs `body` with a bridge over a coding session in `<home>/project`, the way bare `orx`
 * builds one, against the stub.
 */
const withBridge = <A,>(
  home: string,
  body: (made: {
    readonly bridge: ChatBridge;
    readonly stopTurns: () => Promise<void>;
  }) => Effect.Effect<A, never, ChatStore>,
) =>
  Effect.gen(function* () {
    const work = join(home, "project");
    mkdirSync(work);
    const session = yield* prepareSession(Option.some(work));
    return yield* makeBridge(
      newChat(chatId, "openai/gpt-test", session.root),
      () => {},
      session,
    ).pipe(Effect.flatMap(body), Effect.provide(session.layer));
  }).pipe(Effect.provide(layer(home)), quiet, Effect.runPromise);

describe("TUI closed loop", () => {
  it("streams a real turn from the stub, shows usage, and saves the chat", async () => {
    const root = tempHome();
    const saved = await withBridge(root, ({ bridge }) =>
      Effect.gen(function* () {
        setup = yield* Effect.promise(() =>
          render(<App bridge={bridge} />, { width: 80, height: 20 }),
        );
        const screen = setup;
        const frame = yield* Effect.promise(async () => {
          await screen.renderOnce();
          await screen.mockInput.typeText("hi there");
          screen.mockInput.pressEnter();
          // The usage line renders on the turn's `finish` event, before the stream's onExit saves
          // the chat; the input leaves "Replying…" only once the turn, save included, has ended.
          return waitForScreen(
            screen,
            (f) => f.includes("12 in / 5 out") && !f.includes("Replying"),
          );
        });
        expect(frame).toContain("Hello from the stub.");
        expect(frame).toContain("$0.000420");
        const saved = yield* Effect.flatMap(ChatStore, (store) => store.get(chatId));
        return saved;
      }),
    );
    expect(saved._tag).toBe("Some");
    const file = readFileSync(join(root, "data", "chats", `${chatId}.json`), "utf8");
    expect(file).toContain("hi there");
    expect(file).toContain("Hello from the stub.");
  });

  it("shows the upstream error the programs produce", async () => {
    stub.failCompletions = { status: 401 };
    const frame = await withBridge(tempHome(), ({ bridge }) =>
      Effect.gen(function* () {
        setup = yield* Effect.promise(() =>
          render(<App bridge={bridge} />, { width: 80, height: 20 }),
        );
        const screen = setup;
        return yield* Effect.promise(async () => {
          await screen.renderOnce();
          await screen.mockInput.typeText("hi");
          screen.mockInput.pressEnter();
          return waitForScreen(screen, (f) => /key/i.test(f) && f.includes("> hi"));
        });
      }),
    );
    stub.failCompletions = undefined;
    expect(frame).not.toContain("send again to retry");
  });

  it("offers only tool-capable models in the model picker", async () => {
    const models = stub.models;
    stub.models = [
      { id: "openai/gpt-test", name: "OpenAI: GPT Test" },
      { id: "acme/no-tools", name: "Acme: No Tools", tools: false },
      { id: "acme/cheap-model", name: "Acme: Cheap Model" },
    ];
    try {
      const list = await withBridge(tempHome(), ({ bridge }) =>
        Effect.promise(() => bridge.listModels()),
      );
      expect(list.available).toBe(true);
      expect(list.models.map((m) => m.id)).toEqual(["openai/gpt-test", "acme/cheap-model"]);
    } finally {
      stub.models = models;
    }
  });

  it("refuses a custom command whose model: can't call tools, or doesn't exist", async () => {
    const models = stub.models;
    stub.models = [
      { id: "openai/gpt-test", name: "OpenAI: GPT Test" },
      { id: "acme/no-tools", name: "Acme: No Tools", tools: false },
      { id: "acme/cheap-model", name: "Acme: Cheap Model" },
    ];
    const root = tempHome();
    const commands = join(root, "config", "orx", "commands");
    mkdirSync(commands, { recursive: true });
    const command = (name: string, model: string) =>
      writeFileSync(join(commands, `${name}.md`), `---\nmodel: ${model}\n---\nReview $ARGUMENTS`);
    command("plain", "acme/no-tools");
    command("typo", "acme/nope");
    command("cheap", "acme/cheap-model");
    try {
      const results = await withBridge(root, ({ bridge }) =>
        Effect.promise(() =>
          Promise.all([
            bridge.expandCommand("plain", "a.ts"),
            bridge.expandCommand("typo", "a.ts"),
            bridge.expandCommand("cheap", "a.ts"),
          ]),
        ),
      );
      const [plain, typo, cheap] = results;
      const errorOf = (expansion: UiExpansion | undefined) =>
        expansion && "error" in expansion ? expansion.error : "";
      expect(errorOf(plain)).toContain("/plain: acme/no-tools doesn't support tool calling");
      expect(errorOf(plain)).toMatch(/Change the model: line in \S*plain\.md\.$/);
      expect(errorOf(typo)).toContain("/typo: Unknown model: acme/nope");
      expect(errorOf(typo)).toMatch(/Change the model: line in \S*typo\.md\.$/);
      expect(cheap).toEqual({ text: "Review a.ts", model: "acme/cheap-model" });
    } finally {
      stub.models = models;
    }
  });

  it("stops a streaming reply when the TUI's scope closes (a signal), and saves it", async () => {
    stub.completion = { ...stub.completion, text: "one two three four" };
    stub.hangAfter = 2;
    const saved = await withBridge(tempHome(), ({ bridge, stopTurns }) =>
      Effect.gen(function* () {
        setup = yield* Effect.promise(() =>
          render(<App bridge={bridge} />, { width: 80, height: 20 }),
        );
        const screen = setup;
        yield* Effect.promise(async () => {
          await screen.renderOnce();
          await screen.mockInput.typeText("hi");
          screen.mockInput.pressEnter();
          await waitForScreen(screen, (f) => f.includes("one two"));
          await stopTurns();
        });
        return yield* Effect.flatMap(ChatStore, (store) => store.get(chatId));
      }),
    );
    stub.hangAfter = undefined;
    stub.completion = { ...stub.completion, text: "Hello from the stub." };
    expect(saved._tag).toBe("Some");
    const messages = saved._tag === "Some" ? saved.value.messages : [];
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "one two ",
      interrupted: true,
    });
  });
});

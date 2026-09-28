import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer, Logger, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { INTERRUPTED_RESULT, newChat } from "~/core/chat";
import { prepareSession } from "~/core/session";
import { AppLayer } from "~/runtime";
import type { ChatId, StoredChat } from "~/schemas";
import { ChatStore } from "~/services/ChatStore";
import { Host } from "~/services/Host";
import { App } from "~/tui/app";
import { makeBridge } from "~/tui/launch";
import { type StubOpenRouter, startStubOpenRouter } from "../helpers/stub-openrouter";
import { pressWhenArmed, type RenderSetup, render, waitForScreen } from "./render";

// The coding session end to end below the terminal: App + makeBridge + prepareSession's tools
// and Permissions + AppLayer, OpenRouter replaced by the stub. The model reads and edits a file
// in a temp workspace; the approval panel is the only thing between the edit and the disk.

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

let setup: RenderSetup | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  stub.steps = [];
  stub.chatRequests.length = 0;
});

const layer = (home: string) =>
  AppLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        BunServices.layer,
        FetchHttpClient.layer,
        Host.layer({
          execPath: join(home, "bin", "orx"),
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
            HOME: home,
            XDG_CONFIG_HOME: join(home, "config"),
            ORX_DATA_DIR: join(home, "data"),
          },
        }),
      ),
    ),
  );

const quiet = Effect.provide(Logger.layer([]));

const chatId = "1a2b3c4d-0000-4000-8000-000000000001" as ChatId;
const ORIGINAL = "export const add = (a, b) => a + b;\n";

/** A home dir and, inside it, a project with one file (the workspace can't be $HOME itself). */
const project = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "orx-tui-agent-")));
  const work = join(home, "project");
  mkdirSync(work);
  writeFileSync(join(work, "math.js"), ORIGINAL);
  return { home, work };
};

/** The model reads math.js, edits it, then says it's done. */
const readThenEdit = () => [
  { toolCalls: [{ name: "read", arguments: JSON.stringify({ path: "math.js" }) }] },
  {
    toolCalls: [
      {
        name: "edit",
        arguments: JSON.stringify({
          path: "math.js",
          old_string: "a + b",
          new_string: "a + b + 0",
        }),
      },
    ],
  },
  { text: "Done editing." },
];

/**
 * Starts a session in `work`, sends a message, waits for the edit's approval panel, answers
 * it with `key` (Esc stops the reply instead), and returns the screen once the turn (save
 * included) is over, and the chat.
 */
const editWithAnswer = (home: string, work: string, key: "y" | "n" | "escape") =>
  Effect.gen(function* () {
    const session = yield* prepareSession(Option.some(work));
    return yield* Effect.gen(function* () {
      const { bridge } = yield* makeBridge(
        newChat(chatId, "openai/gpt-test", session.root),
        () => {},
        session,
      );
      setup = yield* Effect.promise(() =>
        render(<App bridge={bridge} />, { width: 100, height: 40 }),
      );
      const screen = setup;
      const { panel, done } = yield* Effect.promise(async () => {
        await screen.renderOnce();
        await screen.mockInput.typeText("add zero");
        screen.mockInput.pressEnter();
        const panel = await waitForScreen(screen, (f) => f.includes("Enter pick"));
        // Nothing is written while the panel waits.
        expect(readFileSync(join(work, "math.js"), "utf8")).toBe(ORIGINAL);
        if (key === "escape") {
          screen.mockInput.pressEscape();
        } else {
          await pressWhenArmed(
            screen,
            key,
            () => !screen.captureCharFrame().includes("Enter pick"),
          );
          // n opens an optional note for the model; Enter sends it empty.
          if (key === "n") screen.mockInput.pressEnter();
        }
        const done = await waitForScreen(
          screen,
          (f) =>
            (key === "escape" || f.includes("Done editing.")) &&
            !f.includes("Enter pick") &&
            !f.includes("Replying"),
        );
        return { panel, done };
      });
      const saved = yield* Effect.flatMap(ChatStore, (store) => store.get(chatId));
      return { panel, done, saved };
    }).pipe(Effect.provide(session.layer));
  }).pipe(Effect.provide(layer(home)), quiet, Effect.runPromise);

/** The screen a session opens on with `chat` as its history, as `orx --resume` shows it. */
const resumed = (home: string, work: string, chat: StoredChat) =>
  Effect.gen(function* () {
    const session = yield* prepareSession(Option.some(work));
    return yield* Effect.gen(function* () {
      const { bridge } = yield* makeBridge(chat, () => {}, session);
      setup?.renderer.destroy();
      setup = yield* Effect.promise(() =>
        render(<App bridge={bridge} />, { width: 100, height: 40 }),
      );
      const screen = setup;
      return yield* Effect.promise(async () => {
        await screen.renderOnce();
        return screen.captureCharFrame();
      });
    }).pipe(Effect.provide(session.layer));
  }).pipe(Effect.provide(layer(home)), quiet, Effect.runPromise);

describe("TUI closed loop, coding session", () => {
  it("shows the edit's diff for approval, and y writes it to disk", async () => {
    const { home, work } = project();
    stub.steps = readThenEdit();
    const { panel, done, saved } = await editWithAnswer(home, work, "y");
    expect(panel).toContain("Edit math.js");
    // The call waiting on the panel is named by its file, not its raw input.
    expect(panel).toContain("→ edit math.js · running");
    expect(panel).not.toContain('"old_string"');
    expect(panel).toContain("-export const add = (a, b) => a + b;");
    expect(panel).toContain("+export const add = (a, b) => a + b + 0;");
    expect(readFileSync(join(work, "math.js"), "utf8")).toBe(
      "export const add = (a, b) => a + b + 0;\n",
    );
    expect(done).not.toContain("Enter pick");
    expect(done).toContain("Done · changed math.js");
    // The model saw the edit succeed: its next request carries a non-failed result.
    const third = stub.chatRequests.at(-1) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const results = third.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results[1]?.content)).not.toContain("said no");
    expect(Option.isSome(saved)).toBe(true);
    const reply = Option.getOrThrow(saved).messages.at(-1);
    expect(reply).toMatchObject({
      role: "assistant",
      text: "Done editing.",
      tools: [
        { name: "read", isFailure: false },
        { name: "edit", isFailure: false },
      ],
    });
    // Resumed, the finished reply still says what it changed.
    expect(await resumed(home, work, Option.getOrThrow(saved))).toContain("Done · changed math.js");
  });

  it("leaves the file alone on n, and the model is told the user said no", async () => {
    const { home, work } = project();
    stub.steps = readThenEdit();
    const { saved } = await editWithAnswer(home, work, "n");
    expect(readFileSync(join(work, "math.js"), "utf8")).toBe(ORIGINAL);
    const reply = Option.getOrThrow(saved).messages.at(-1);
    expect(reply).toMatchObject({
      role: "assistant",
      tools: [
        { name: "read", isFailure: false },
        { name: "edit", isFailure: true },
      ],
    });
    const last = stub.chatRequests.at(-1) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const results = last.messages.filter((m) => m.role === "tool");
    expect(JSON.stringify(results[1]?.content)).toContain("The user said no.");
  });

  it("closes the panel on Esc, writes nothing, and saves the edit as interrupted", async () => {
    const { home, work } = project();
    stub.steps = readThenEdit();
    const { saved } = await editWithAnswer(home, work, "escape");
    expect(readFileSync(join(work, "math.js"), "utf8")).toBe(ORIGINAL);
    // The model was never asked again: the reply stopped at the edit.
    expect(stub.chatRequests).toHaveLength(2);
    const reply = Option.getOrThrow(saved).messages.at(-1);
    expect(reply).toMatchObject({
      role: "assistant",
      interrupted: true,
      tools: [
        { name: "read", isFailure: false },
        { name: "edit", isFailure: true, output: INTERRUPTED_RESULT },
      ],
    });
    // Resumed, a stopped reply doesn't claim to be done.
    const frame = await resumed(home, work, Option.getOrThrow(saved));
    expect(frame).toContain("→ edit math.js");
    expect(frame).not.toContain("Done ·");
  });
  it("forgets what the last chat read on /clear, so a write there needs a new read", async () => {
    const { home, work } = project();
    stub.steps = [
      { toolCalls: [{ name: "read", arguments: JSON.stringify({ path: "math.js" }) }] },
      { text: "Read it." },
      {
        toolCalls: [
          {
            name: "write",
            arguments: JSON.stringify({ path: "math.js", content: "overwritten\n" }),
          },
        ],
      },
      { text: "Tried." },
    ];
    await Effect.gen(function* () {
      // yolo: nothing asks, so only the read-before-write check stands between the write and disk.
      const session = yield* prepareSession(Option.some(work), { mode: "yolo", headless: false });
      yield* Effect.gen(function* () {
        const { bridge } = yield* makeBridge(
          newChat(chatId, "openai/gpt-test", session.root),
          () => {},
          session,
        );
        setup = yield* Effect.promise(() =>
          render(<App bridge={bridge} />, { width: 100, height: 40 }),
        );
        const screen = setup;
        yield* Effect.promise(async () => {
          await screen.renderOnce();
          await screen.mockInput.typeText("read math.js");
          screen.mockInput.pressEnter();
          await waitForScreen(screen, (f) => f.includes("Read it.") && !f.includes("Replying"));
          // `/` opens the command list; Esc leaves the `/` in the composer for the typed command.
          await screen.mockInput.typeText("/");
          await waitForScreen(screen, (f) => f.includes("Commands"));
          screen.mockInput.pressEscape();
          await waitForScreen(screen, (f) => !f.includes("Commands"));
          await screen.mockInput.typeText("clear");
          screen.mockInput.pressEnter();
          await waitForScreen(
            screen,
            (f) => !f.includes("Read it.") && !f.includes("chat 1a2b3c4d"),
          );
          await screen.mockInput.typeText("overwrite math.js");
          screen.mockInput.pressEnter();
          await waitForScreen(screen, (f) => f.includes("Tried.") && !f.includes("Replying"));
        });
      }).pipe(Effect.provide(session.layer));
    }).pipe(Effect.provide(layer(home)), quiet, Effect.runPromise);
    expect(readFileSync(join(work, "math.js"), "utf8")).toBe(ORIGINAL);
    const last = stub.chatRequests.at(-1) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const results = last.messages.filter((m) => m.role === "tool");
    // The new chat's history has only the write's result, and it was refused.
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results[0]?.content)).toContain("read it first");
  });
});

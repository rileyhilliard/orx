import { afterEach, describe, expect, it } from "bun:test";
import { App } from "~/tui/app";
import type { UiBridge, UiReply } from "~/tui/types";
import { type RenderSetup, render as renderTui, waitForScreen } from "./render";

let setup: RenderSetup | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

/** A bridge that answers every prompt with `reply` and records what the app asked for. */
const fakeBridge = (reply: UiReply, overrides: Partial<UiBridge> = {}) => {
  const calls = { asked: [] as string[], quit: 0 };
  const bridge: UiBridge = {
    model: "openai/gpt-test",
    ask: async (prompt) => {
      calls.asked.push(prompt);
      return reply;
    },
    quit: () => {
      calls.quit += 1;
    },
    ...overrides,
  };
  return { bridge, calls };
};

const hello: UiReply = { type: "reply", text: "Hello.", usage: "openai/gpt-test · 12 in / 5 out" };

const render = async (bridge: UiBridge) => {
  setup = await renderTui(<App bridge={bridge} />, { width: 80, height: 20 });
  await setup.renderOnce();
  return setup;
};

describe("App", () => {
  it("shows the model and the key hints", async () => {
    const { captureCharFrame } = await render(fakeBridge(hello).bridge);
    const frame = captureCharFrame();
    expect(frame).toContain("openai/gpt-test");
    expect(frame).toContain("Ctrl+C quit");
  });

  it("sends the prompt on Enter and shows the reply and usage", async () => {
    const { bridge, calls } = fakeBridge(hello);
    const screen = await render(bridge);
    await screen.mockInput.typeText("hi there");
    screen.mockInput.pressEnter();
    const frame = await waitForScreen(screen, (f) => f.includes("12 in / 5 out"));
    expect(calls.asked).toEqual(["hi there"]);
    expect(frame).toContain("> hi there");
    expect(frame).toContain("Hello.");
  });

  it("offers a retry only when the error is retryable", async () => {
    const retryable = fakeBridge({
      type: "error",
      error: { message: "OpenRouter is having trouble.", retryable: true },
    });
    const first = await render(retryable.bridge);
    await first.mockInput.typeText("hi");
    first.mockInput.pressEnter();
    expect(await waitForScreen(first, (f) => f.includes("having trouble"))).toContain(
      "Send again to retry",
    );
    first.renderer.destroy();

    const final = fakeBridge({
      type: "error",
      error: { message: "OpenRouter rejected the API key.", retryable: false },
    });
    const second = await render(final.bridge);
    await second.mockInput.typeText("hi");
    second.mockInput.pressEnter();
    expect(await waitForScreen(second, (f) => f.includes("rejected"))).not.toContain(
      "Send again to retry",
    );
  });

  it("shows an error if the bridge rejects anyway", async () => {
    const { bridge } = fakeBridge(hello, { ask: () => Promise.reject(new Error("boom")) });
    const screen = await render(bridge);
    await screen.mockInput.typeText("hi");
    screen.mockInput.pressEnter();
    expect(await waitForScreen(screen, (f) => f.includes("stopped unexpectedly"))).toContain(
      "> hi",
    );
  });

  it("quits on Ctrl+C", async () => {
    const { bridge, calls } = fakeBridge(hello);
    const { mockInput } = await render(bridge);
    mockInput.pressCtrlC();
    expect(calls.quit).toBe(1);
  });
});

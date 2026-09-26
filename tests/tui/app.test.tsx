import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { App } from "~/tui/app";
import type { ChatBridge, UiEvent } from "~/tui/types";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

/** A bridge that replies with `events` and records what the app asked for. */
const fakeBridge = (events: ReadonlyArray<UiEvent>, overrides: Partial<ChatBridge> = {}) => {
  const calls = { sent: [] as Array<[string, string]>, quit: 0, exported: 0 };
  const bridge: ChatBridge = {
    chatId: "0f0e0d0c-0000-4000-8000-000000000000",
    initialModel: "openai/gpt-test",
    history: [],
    send: (text, model) => {
      calls.sent.push([text, model]);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
    listModels: async () => ({
      available: true,
      models: [
        { id: "openai/gpt-test", name: "GPT Test" },
        { id: "acme/cheap-model", name: "Cheap" },
      ],
    }),
    exportMarkdown: async () => {
      calls.exported += 1;
      return "orx-chat-0f0e0d0c.md";
    },
    quit: () => {
      calls.quit += 1;
    },
    ...overrides,
  };
  return { bridge, calls };
};

const render = async (bridge: ChatBridge) => {
  setup = await testRender(<App bridge={bridge} />, { width: 80, height: 20 });
  await setup.renderOnce();
  return setup;
};

describe("App", () => {
  it("shows the model and the key hints", async () => {
    const { captureCharFrame } = await render(fakeBridge([]).bridge);
    const frame = captureCharFrame();
    expect(frame).toContain("openai/gpt-test");
    expect(frame).toContain("Ctrl+P model");
  });

  it("sends the draft on Enter and renders the streamed reply, tool call, and usage", async () => {
    const { bridge, calls } = fakeBridge([
      { type: "tool", call: { name: "currentTime", input: '{"timeZone":"UTC"}' } },
      { type: "text", delta: "It is " },
      { type: "text", delta: "noon." },
      { type: "done", usage: "openai/gpt-test · 12 in / 5 out" },
    ]);
    const { mockInput, waitForFrame } = await render(bridge);
    await mockInput.typeText("what time is it");
    mockInput.pressEnter();
    const frame = await waitForFrame((f) => f.includes("12 in / 5 out"));
    expect(calls.sent).toEqual([["what time is it", "openai/gpt-test"]]);
    expect(frame).toContain("> what time is it");
    expect(frame).toContain("→ currentTime");
    expect(frame).toContain("It is noon.");
  });

  it("shows an error and whether sending again can help", async () => {
    const { bridge } = fakeBridge([
      { type: "error", error: { message: "OpenRouter is having trouble.", retryable: true } },
    ]);
    const { mockInput, waitForFrame } = await render(bridge);
    await mockInput.typeText("hi");
    mockInput.pressEnter();
    const frame = await waitForFrame((f) => f.includes("OpenRouter is having trouble."));
    expect(frame).toContain("send again to retry");
  });

  it("exports on Ctrl+E and says where", async () => {
    const { bridge, calls } = fakeBridge([]);
    const { mockInput, waitForFrame } = await render(bridge);
    mockInput.pressKey("e", { ctrl: true });
    await waitForFrame((f) => f.includes("Exported to orx-chat-0f0e0d0c.md"));
    expect(calls.exported).toBe(1);
  });

  it("picks a model with Ctrl+P, and the next message uses it", async () => {
    const { bridge, calls } = fakeBridge([{ type: "done", usage: "u" }]);
    const { mockInput, waitForFrame } = await render(bridge);
    mockInput.pressKey("p", { ctrl: true });
    await waitForFrame((f) => f.includes("acme/cheap-model"));
    await mockInput.typeText("cheap");
    mockInput.pressEnter();
    await waitForFrame((f) => !f.includes("Search models") && f.includes("acme/cheap-model"));
    await mockInput.typeText("hi");
    mockInput.pressEnter();
    await waitForFrame((f) => f.includes("> hi"));
    expect(calls.sent).toEqual([["hi", "acme/cheap-model"]]);
  });

  it("quits on Ctrl+C", async () => {
    const { bridge, calls } = fakeBridge([]);
    const { mockInput, waitFor } = await render(bridge);
    mockInput.pressCtrlC();
    await waitFor(() => calls.quit === 1);
  });
});

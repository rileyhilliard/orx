import { afterEach, describe, expect, it } from "bun:test";
import { App } from "~/tui/app";
import type { ChatBridge, UiApproval, UiDecision, UiEvent, UiMode } from "~/tui/types";
import { type RenderSetup, render as renderTui, waitForScreen } from "./render";

let setup: RenderSetup | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

/** A bridge that replies with `events` and records what the app asked for. */
const fakeBridge = (events: ReadonlyArray<UiEvent>, overrides: Partial<ChatBridge> = {}) => {
  const calls = {
    sent: [] as Array<[string, string]>,
    quit: 0,
    exported: 0,
    newChats: 0,
    answers: [] as Array<[string, UiDecision]>,
    modes: [] as Array<UiMode>,
  };
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
      return "Exported to orx-chat-0f0e0d0c.md";
    },
    quit: () => {
      calls.quit += 1;
    },
    listCommands: async () => [{ name: "review", description: "Review a file" }],
    listSkills: async () => [
      { name: "pdf", description: "Fill PDF forms" },
      { name: "review", description: "A skill the command shadows" },
    ],
    expandCommand: async (name, args) => {
      if (name === "review") return { text: `Review ${args}`, model: "acme/reviewer" };
      if (name === "pdf") return { text: `PDF steps${args ? `\n\nARGUMENTS: ${args}` : ""}` };
      return undefined;
    },
    newChat: async () => {
      calls.newChats += 1;
      return "1a2b3c4d-0000-4000-8000-000000000000";
    },
    answer: async (id, decision) => {
      calls.answers.push([id, decision]);
    },
    setMode: async (mode) => {
      calls.modes.push(mode);
    },
    watchMode: () => () => {},
    listFiles: async () => ["README.md", "docs/", "docs/readme-notes.txt", "src/app.tsx"],
    attachFiles: async (text) =>
      text.includes("@README.md") ? `${text}\n\n<file path="README.md">…</file>` : text,
    ...overrides,
  };
  return { bridge, calls };
};

const render = async (bridge: ChatBridge) => {
  setup = await renderTui(<App bridge={bridge} />, { width: 80, height: 20 });
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

  it("filters the picker's list as you type", async () => {
    const { bridge } = fakeBridge([]);
    const { mockInput, waitForFrame } = await render(bridge);
    mockInput.pressKey("p", { ctrl: true });
    await waitForFrame((f) => f.includes("▶ openai/gpt-test"));
    await mockInput.typeText("cheap");
    const frame = await waitForFrame((f) => f.includes("▶ acme/cheap-model"));
    expect(frame).not.toContain("  openai/gpt-test\n");
  });

  it("quits on Ctrl+C", async () => {
    const { bridge, calls } = fakeBridge([]);
    const { mockInput, waitFor } = await render(bridge);
    mockInput.pressCtrlC();
    await waitFor(() => calls.quit === 1);
  });
});

describe("slash commands", () => {
  const screen = (setup: RenderSetup, predicate: (frame: string) => boolean) =>
    waitForScreen(setup, predicate, 2000);
  // These wait with waitForScreen: the list loads through two bridge promises, which can land
  // after waitForFrame has given up on an idle renderer.
  /** Types `/`, waits for the list, then types `rest` into its filter. */
  const openList = async (setup: RenderSetup, rest = "") => {
    await setup.mockInput.typeText("/");
    await screen(setup, (f) => f.includes("Commands"));
    if (rest !== "") await setup.mockInput.typeText(rest);
  };

  it("opens a list of built-ins, commands, and skills on /, with descriptions", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await openList(setup);
    const first = await screen(setup, (f) => f.includes("/help"));
    expect(first).toContain("List commands and keys");
    await setup.mockInput.typeText("pdf");
    const frame = await screen(setup, (f) => f.includes("/pdf"));
    expect(frame).toContain("Fill PDF forms");
    expect(frame).not.toContain("/help");
    // The skill named like the command is listed once, as the command.
    await setup.mockInput.typeText("\b\b\breview");
    const review = await screen(setup, (f) => f.includes("Review a file"));
    expect(review).not.toContain("A skill the command shadows");
  });

  it("inserts the picked command into the composer, and Enter runs it", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await openList(setup, "hel");
    await screen(setup, (f) => f.includes("▶ /help"));
    setup.mockInput.pressEnter();
    await screen(setup, (f) => !f.includes("Commands") && f.includes("/help "));
    setup.mockInput.pressEnter();
    const frame = await screen(setup, (f) => f.includes("/export  Export the chat as Markdown"));
    expect(frame).toContain("Ctrl+C quit");
  });

  it("shows an error for an unknown command and sends nothing", async () => {
    const { bridge, calls } = fakeBridge([]);
    const setup = await render(bridge);
    await openList(setup);
    setup.mockInput.pressEscape();
    await screen(setup, (f) => !f.includes("Commands"));
    await setup.mockInput.typeText("nope now");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("Unknown command /nope"));
    expect(calls.sent).toEqual([]);
  });

  it("sends a custom command's expansion on its own model for that turn", async () => {
    const { bridge, calls } = fakeBridge([{ type: "done", usage: "u" }]);
    const setup = await render(bridge);
    await openList(setup);
    setup.mockInput.pressEscape();
    await screen(setup, (f) => !f.includes("Commands"));
    await setup.mockInput.typeText("review src/a.ts");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("> Review src/a.ts"));
    await setup.mockInput.typeText("next");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("> next"));
    expect(calls.sent).toEqual([
      ["Review src/a.ts", "acme/reviewer"],
      ["next", "openai/gpt-test"],
    ]);
  });

  it("sends a skill's body with the arguments appended", async () => {
    const { bridge, calls } = fakeBridge([{ type: "done", usage: "u" }]);
    const setup = await render(bridge);
    await openList(setup, "pdf");
    await screen(setup, (f) => f.includes("▶ /pdf"));
    setup.mockInput.pressEnter();
    await screen(setup, (f) => !f.includes("Commands") && f.includes("/pdf "));
    await setup.mockInput.typeText("form.pdf");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("> PDF steps"));
    expect(calls.sent).toEqual([["PDF steps\n\nARGUMENTS: form.pdf", "openai/gpt-test"]]);
  });

  it("runs /clear, /mode, /export, /model, and /quit", async () => {
    const { bridge, calls } = fakeBridge([{ type: "done", usage: "u" }]);
    const setup = await render(bridge);
    const { mockInput, waitFor } = setup;
    const waitForFrame = (predicate: (frame: string) => boolean) => screen(setup, predicate);
    const run = async (command: string) => {
      await openList(setup);
      mockInput.pressEscape();
      await waitForFrame((f) => !f.includes("Commands"));
      await mockInput.typeText(command);
      mockInput.pressEnter();
    };

    await mockInput.typeText("hi");
    mockInput.pressEnter();
    await waitForFrame((f) => f.includes("> hi"));
    await run("clear");
    let frame = await waitForFrame((f) => f.includes("chat 1a2b3c4d"));
    expect(frame).not.toContain("> hi");
    expect(calls.newChats).toBe(1);

    await run("mode plan");
    await waitForFrame((f) =>
      /plan\s*$/m.test(
        f
          .split("\n")
          .filter((l) => l.trim())
          .at(-1) ?? "",
      ),
    );
    await run("mode yolo");
    await waitForFrame((f) => f.includes('Unknown mode "yolo"'));

    await run("export");
    await waitForFrame((f) => f.includes("Exported to orx-chat-0f0e0d0c.md"));
    expect(calls.exported).toBe(1);

    await run("model");
    frame = await waitForFrame((f) => f.includes("Search models"));
    mockInput.pressEscape();
    await waitForFrame((f) => !f.includes("Search models"));

    await run("quit");
    await waitFor(() => calls.quit === 1);
  });
});

describe("the @ file picker", () => {
  const screen = (setup: RenderSetup, predicate: (frame: string) => boolean) =>
    waitForScreen(setup, predicate, 2000);

  it("opens on @, filters by fuzzy match with basename hits first, and Esc closes it", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await setup.mockInput.typeText("look at @");
    const all = await screen(setup, (f) => f.includes("Files") && f.includes("src/app.tsx"));
    expect(all).toContain("README.md");
    await setup.mockInput.typeText("read");
    const filtered = await screen(setup, (f) => !f.includes("src/app.tsx"));
    expect(filtered.indexOf("▶ README.md")).toBeGreaterThan(-1);
    expect(filtered).toContain("docs/readme-notes.txt");
    setup.mockInput.pressEscape();
    await screen(setup, (f) => !f.includes("Files"));
  });

  it("inserts the picked path at the @, and the model gets the attachment", async () => {
    const { bridge, calls } = fakeBridge([{ type: "done", usage: "u" }]);
    const setup = await render(bridge);
    await setup.mockInput.typeText("look at @");
    await screen(setup, (f) => f.includes("Files"));
    await setup.mockInput.typeText("READ");
    await screen(setup, (f) => f.includes("▶ README.md"));
    setup.mockInput.pressEnter();
    await screen(setup, (f) => !f.includes("Files") && f.includes("look at @README.md"));
    await setup.mockInput.typeText("please");
    setup.mockInput.pressEnter();
    const frame = await screen(
      setup,
      (f) => calls.sent.length === 1 && f.includes("look at @README.md please"),
    );
    expect(calls.sent).toEqual([
      ['look at @README.md please\n\n<file path="README.md">…</file>', "openai/gpt-test"],
    ]);
    expect(frame).not.toContain("<file");
  });
});

describe("the approval panel", () => {
  const screen = (setup: RenderSetup, predicate: (frame: string) => boolean) =>
    waitForScreen(setup, predicate, 2000);

  const bashApproval: UiApproval = {
    id: "approval-1",
    tool: "bash",
    summary: "bun test",
    canAlways: true,
  };

  /** A turn that asks for `request`, waits for the answer, then finishes with `after`. */
  const askingBridge = (request: UiApproval, after: ReadonlyArray<UiEvent> = []) => {
    let answered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const fake = fakeBridge([], {
      send: (text, model) => {
        fake.calls.sent.push([text, model]);
        return (async function* () {
          yield { type: "approval", request } satisfies UiEvent;
          await waiting;
          for (const event of after) yield event;
        })();
      },
      answer: async (id, decision) => {
        fake.calls.answers.push([id, decision]);
        answered();
      },
    });
    return fake;
  };

  it("shows the command with y / a / n in the footer, and y allows it", async () => {
    const { bridge, calls } = askingBridge(bashApproval, [
      { type: "text", delta: "tests pass" },
      { type: "done", usage: "u1" },
    ]);
    const setup = await render(bridge);
    await setup.mockInput.typeText("run the tests");
    setup.mockInput.pressEnter();
    const panel = await screen(setup, (f) => f.includes("Run  bun test"));
    expect(panel).toContain("y allow · a always · n deny · Esc stop");
    await setup.mockInput.typeText("y");
    const done = await screen(setup, (f) => f.includes("tests pass"));
    expect(calls.answers).toEqual([["approval-1", "yes"]]);
    expect(done).not.toContain("Run  bun test");
    // The y went to the panel, not the composer.
    expect(done).not.toContain("│ y");
  });

  it("offers always only when allowed, and n takes an optional note", async () => {
    const { bridge, calls } = askingBridge(
      {
        id: "approval-2",
        tool: "edit",
        summary: "Edit src/a.ts",
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new",
        canAlways: false,
      },
      [{ type: "done", usage: "u2" }],
    );
    const setup = await render(bridge);
    await setup.mockInput.typeText("edit it");
    setup.mockInput.pressEnter();
    const panel = await screen(setup, (f) => f.includes("Edit src/a.ts"));
    expect(panel).toContain("+new");
    expect(panel).toContain("y allow · n deny");
    await setup.mockInput.typeText("a");
    expect(calls.answers).toEqual([]);
    await setup.mockInput.typeText("n");
    await screen(setup, (f) => f.includes("Enter deny with this note"));
    await setup.mockInput.typeText("use a flag");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("u2"));
    expect(calls.answers).toEqual([["approval-2", { no: "use a flag" }]]);
    expect(calls.sent).toHaveLength(1);
  });

  it("closes when the request is cancelled or the turn ends", async () => {
    const { bridge } = fakeBridge([
      { type: "approval", request: bashApproval },
      { type: "approval-cancelled", id: "approval-1" },
      { type: "text", delta: "stopped" },
    ]);
    const setup = await render(bridge);
    await setup.mockInput.typeText("go");
    setup.mockInput.pressEnter();
    const frame = await screen(setup, (f) => f.includes("stopped") && !f.includes("Replying"));
    expect(frame).not.toContain("Run  bun test");
    expect(frame).toContain("Enter send");
  });

  it("cycles the permission mode with Shift+Tab and follows the bridge's changes", async () => {
    let push: (mode: UiMode) => void = () => {};
    const { bridge, calls } = fakeBridge([], {
      watchMode: (onMode) => {
        push = onMode;
        return () => {};
      },
    });
    const setup = await render(bridge);
    setup.mockInput.pressKey("\t", { shift: true });
    await screen(setup, (f) => /acceptEdits\s*$/m.test(f));
    setup.mockInput.pressKey("\t", { shift: true });
    await screen(setup, (f) => /plan\s*$/m.test(f));
    expect(calls.modes).toEqual(["acceptEdits", "plan"]);
    push("yolo");
    await screen(setup, (f) => /yolo\s*$/m.test(f));
  });
});

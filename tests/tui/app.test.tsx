import { afterEach, describe, expect, it } from "bun:test";
import { APPROVAL_ARM_MS, App } from "~/tui/app";
import { wrap } from "~/tui/approval-panel";
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

  it("fits the footer and a non-default mode in 80 columns", async () => {
    const { bridge } = fakeBridge([], {
      watchMode: (onMode) => {
        onMode("acceptEdits");
        return () => {};
      },
    });
    const { waitForFrame } = await render(bridge);
    const frame = await waitForFrame((f) => f.includes("acceptEdits"));
    const footer = frame.split("\n").find((l) => l.includes("Ctrl+C quit")) ?? "";
    expect(footer).toContain("@ files · / commands · Shift+Tab mode · Ctrl+P model · Ctrl+C quit");
    expect(footer.trimEnd().endsWith("acceptEdits")).toBe(true);
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

  it("marks a tool call still running when the turn ended as stopped", async () => {
    const { bridge } = fakeBridge([
      { type: "tool", call: { id: "t1", name: "slow", input: '{"n":1}', status: "running" } },
    ]);
    const { mockInput, waitForFrame } = await render(bridge);
    await mockInput.typeText("go");
    mockInput.pressEnter();
    const frame = await waitForFrame((f) => f.includes("→ slow") && !f.includes("Replying"));
    expect(frame).toContain('→ slow({"n":1}) · stopped');
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

  it("moves the highlight with Up/Down and picks the highlighted model on Enter", async () => {
    const { bridge, calls } = fakeBridge([{ type: "done", usage: "u" }]);
    const setup = await render(bridge);
    const { mockInput } = setup;
    // A key's state change can land after the renderer goes idle, so poll the screen.
    const waitForFrame = (predicate: (frame: string) => boolean) =>
      waitForScreen(setup, predicate, 2000);
    mockInput.pressKey("p", { ctrl: true });
    await waitForFrame((f) => f.includes("▶ openai/gpt-test"));
    mockInput.pressArrow("down");
    await waitForFrame((f) => f.includes("▶ acme/cheap-model"));
    // Past the end stays on the last item.
    mockInput.pressArrow("down");
    mockInput.pressArrow("up");
    await waitForFrame((f) => f.includes("▶ openai/gpt-test"));
    mockInput.pressArrow("down");
    await waitForFrame((f) => f.includes("▶ acme/cheap-model"));
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
    const frame = await screen(setup, (f) => f.includes("/pdf") && !f.includes("/help"));
    expect(frame).toContain("Fill PDF forms");
    expect(frame).not.toContain("/help");
    // The skill named like the command is listed once, as the command.
    await setup.mockInput.typeText("\b\b\breview");
    const review = await screen(setup, (f) => f.includes("Review a file"));
    expect(review).not.toContain("A skill the command shadows");
  });

  it("sizes the list to its items, with no empty rows", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await openList(setup);
    const frame = await screen(setup, (f) => f.includes("/pdf"));
    const lines = frame.split("\n");
    const top = lines.findIndex((l) => l.includes("Commands"));
    const bottom = lines.findIndex((l, i) => i > top && l.includes("└"));
    // The filter row plus one row per item: help, clear, model, mode, export, quit, review, pdf.
    expect(bottom - top - 1).toBe(9);
    expect(lines.slice(top + 1, bottom).every((l) => /│.*\S.*│/.test(l))).toBe(true);
    // Each description sits on its item's row.
    expect(frame).toMatch(/\/export\s+Export the chat as Markdown/);
  });

  it("picks the highlighted command with Up/Down and Tab, and a new filter starts at the top", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await openList(setup);
    await screen(setup, (f) => f.includes("▶ /help"));
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    await screen(setup, (f) => f.includes("▶ /model"));
    await setup.mockInput.typeText("e");
    await screen(setup, (f) => f.includes("▶ /export"));
    setup.mockInput.pressArrow("down");
    await screen(setup, (f) => f.includes("▶ /help"));
    setup.mockInput.pressTab();
    await screen(setup, (f) => !f.includes("Commands") && f.includes("/help "));
  });

  it("strips control characters from names and descriptions it didn't write", async () => {
    const setup = await render(
      fakeBridge([], {
        listCommands: async () => [{ name: "evil", description: "red\u001b[31mtext" }],
      }).bridge,
    );
    await openList(setup, "evil");
    const frame = await screen(setup, (f) => f.includes("/evil"));
    expect(frame).toContain("red[31mtext");
    expect(frame).not.toContain("\u001b");
  });

  it("cuts /help on a short terminal and says how much is left out", async () => {
    const view = await renderTui(<App bridge={fakeBridge([]).bridge} />, {
      width: 80,
      height: 14,
    });
    setup = view;
    await setup.mockInput.typeText("/help");
    await screen(setup, (f) => f.includes("Commands"));
    setup.mockInput.pressEscape();
    await screen(setup, (f) => !f.includes("Commands"));
    setup.mockInput.pressEnter();
    const frame = await screen(setup, (f) => f.includes("more lines; make the terminal taller"));
    expect(frame).toContain("/help    List commands and keys");
  });

  it("says when nothing matches, and Enter then reports the unknown command", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await openList(setup, "zzz");
    await screen(setup, (f) => f.includes("No matches"));
    setup.mockInput.pressEnter();
    const frame = await screen(setup, (f) => f.includes("Unknown command /zzz"));
    expect(frame).not.toContain("Commands");
  });

  it("runs the highlighted command on Enter, with the filter's extra words as arguments", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await openList(setup, "help");
    await screen(setup, (f) => f.includes("▶ /help"));
    setup.mockInput.pressEnter();
    const help = await screen(
      setup,
      (f) => f.includes("Start a new chat") && !f.includes("Commands"),
    );
    expect(help).toContain("/quit    Quit orx");
    expect(help).toMatch(/│ Message\s+│/);
    setup.mockInput.pressEscape();
    await screen(setup, (f) => !f.includes("Start a new chat"));
    await openList(setup, "mode plan");
    await screen(setup, (f) => f.includes("▶ /mode"));
    setup.mockInput.pressEnter();
    await screen(setup, (f) => !f.includes("Commands") && /plan\s*$/m.test(f));
  });

  it("closes on Backspace in an empty filter and takes the / back", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await openList(setup, "h");
    setup.mockInput.pressBackspace();
    await screen(setup, (f) => f.includes("▶ /help") && f.includes("/clear"));
    setup.mockInput.pressBackspace();
    const frame = await screen(setup, (f) => !f.includes("Commands"));
    expect(frame).toContain("Message");
    expect(frame).not.toContain("│ /");
  });

  it("lists every key in /help, in two columns at 80", async () => {
    const view = await renderTui(<App bridge={fakeBridge([]).bridge} />, {
      width: 80,
      height: 30,
    });
    setup = view;
    await setup.mockInput.typeText("/help");
    await screen(setup, (f) => f.includes("Commands"));
    setup.mockInput.pressEscape();
    await screen(setup, (f) => !f.includes("Commands"));
    setup.mockInput.pressEnter();
    const frame = await screen(setup, (f) => f.includes("Ctrl+C     quit"));
    expect(frame).toMatch(/Enter\s+send, or run a \/command\s+@\s+attach a file/);
    expect(frame).toContain("/quit    Quit orx");
    setup.mockInput.pressEscape();
    await screen(setup, (f) => !f.includes("Ctrl+C     quit"));
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

  it("shows a command's model error inline and sends nothing", async () => {
    const { bridge, calls } = fakeBridge([], {
      expandCommand: async () => ({
        error: "/review: acme/no-tools doesn't support tool calling, which the coding agent needs.",
      }),
    });
    const setup = await render(bridge);
    await openList(setup);
    setup.mockInput.pressEscape();
    await screen(setup, (f) => !f.includes("Commands"));
    await setup.mockInput.typeText("review a.ts");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("acme/no-tools doesn't support tool calling"));
    expect(calls.sent).toEqual([]);
  });

  it("sends a skill's body with the arguments appended", async () => {
    const { bridge, calls } = fakeBridge([{ type: "done", usage: "u" }]);
    const setup = await render(bridge);
    await openList(setup, "pdf");
    await screen(setup, (f) => f.includes("▶ /pdf"));
    // Tab inserts the command to add arguments; Enter would run it bare.
    setup.mockInput.pressTab();
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

  it("picks the highlighted path, and Backspace in the empty filter takes the @ back", async () => {
    const setup = await render(fakeBridge([]).bridge);
    await setup.mockInput.typeText("see ");
    await setup.mockInput.typeText("@");
    await screen(setup, (f) => f.includes("▶ README.md"));
    setup.mockInput.pressBackspace();
    await screen(setup, (f) => !f.includes("Files") && f.includes("│ see "));
    await setup.mockInput.typeText("@");
    await screen(setup, (f) => f.includes("▶ README.md"));
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("down");
    await screen(setup, (f) => f.includes("▶ docs/readme-notes.txt"));
    setup.mockInput.pressEnter();
    await screen(setup, (f) => !f.includes("Files") && f.includes("see @docs/readme-notes.txt"));
  });

  it("keeps a long path's file name in view", async () => {
    const long = `${"deeply/nested/".repeat(8)}component-name.tsx`;
    const setup = await render(fakeBridge([], { listFiles: async () => [long] }).bridge);
    await setup.mockInput.typeText("@");
    const frame = await screen(setup, (f) => f.includes("component-name.tsx"));
    expect(frame).toContain("▶ …");
  });

  it("inserts the picked path at the @ and sends the text as typed", async () => {
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
    // Attaching the file is the bridge's job (launch.tsx), so the typed text is what's sent.
    expect(calls.sent).toEqual([["look at @README.md please", "openai/gpt-test"]]);
    expect(frame).toContain("> look at @README.md please");
  });
});

describe("the approval panel", () => {
  const screen = (setup: RenderSetup, predicate: (frame: string) => boolean) =>
    waitForScreen(setup, predicate, 2000);

  /**
   * Types `key` until `done`: the panel ignores y / a / n for its first APPROVAL_ARM_MS, so a
   * press lands once it's armed. Checks between presses so no extra key reaches the composer.
   */
  const pressWhenArmed = async (setup: RenderSetup, key: string, done: () => boolean) => {
    const deadline = Date.now() + APPROVAL_ARM_MS + 2000;
    for (;;) {
      await setup.renderOnce();
      if (done()) return;
      if (Date.now() > deadline) throw new Error(`"${key}" never answered the panel`);
      await setup.mockInput.typeText(key);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const bashApproval: UiApproval = {
    id: "approval-1",
    tool: "bash",
    summary: "bun test",
    canAlways: true,
  };

  /**
   * A turn that yields `before`, waits for `release` (when given), asks for `request`, waits
   * for the answer, then finishes with `after`.
   */
  const askingBridge = (
    request: UiApproval,
    after: ReadonlyArray<UiEvent> = [],
    options: { before?: ReadonlyArray<UiEvent>; release?: Promise<void> } = {},
  ) => {
    let answered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const fake = fakeBridge([], {
      send: (text, model) => {
        fake.calls.sent.push([text, model]);
        return (async function* () {
          for (const event of options.before ?? []) yield event;
          await options.release;
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
    await pressWhenArmed(setup, "y", () => calls.answers.length > 0);
    const done = await screen(setup, (f) => f.includes("tests pass"));
    expect(calls.answers).toEqual([["approval-1", "yes"]]);
    expect(done).not.toContain("Run  bun test");
    // The y went to the panel, not the composer.
    expect(done).not.toContain("│ y");
  });

  it("ignores y / a / n typed before the panel has been on screen long enough to read", async () => {
    const { bridge, calls } = askingBridge(bashApproval, [{ type: "done", usage: "u1" }]);
    const setup = await render(bridge);
    await setup.mockInput.typeText("run the tests");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("Run  bun test"));
    // Type-ahead: an "always" the user never chose.
    await setup.mockInput.typeText("a");
    await setup.renderOnce();
    expect(calls.answers).toEqual([]);
    await pressWhenArmed(setup, "y", () => calls.answers.length > 0);
    expect(calls.answers).toEqual([["approval-1", "yes"]]);
  });

  it("closes an open list when an approval arrives, so its filter can't answer", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bridge, calls } = askingBridge(bashApproval, [{ type: "done", usage: "u1" }], {
      before: [{ type: "text", delta: "working" }],
      release: released,
    });
    const setup = await render(bridge);
    await setup.mockInput.typeText("go");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("working"));
    await setup.mockInput.typeText("/");
    await screen(setup, (f) => f.includes("Commands"));
    release();
    await screen(setup, (f) => f.includes("Run  bun test") && !f.includes("Commands"));
    await setup.mockInput.typeText("y");
    await setup.renderOnce();
    expect(calls.answers).toEqual([]);
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
    await pressWhenArmed(setup, "n", () =>
      setup.captureCharFrame().includes("Enter deny with this note"),
    );
    // A note isn't a message: / and @ don't open lists.
    await setup.mockInput.typeText("/ @");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("Commands");
    expect(setup.captureCharFrame()).not.toContain("Files");
    // `a` was never on offer; no answer yet.
    expect(calls.answers).toEqual([]);
    setup.mockInput.pressBackspace();
    setup.mockInput.pressBackspace();
    setup.mockInput.pressBackspace();
    await setup.mockInput.typeText("use a flag");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("u2"));
    expect(calls.answers).toEqual([["approval-2", { no: "use a flag" }]]);
    expect(calls.sent).toHaveLength(1);
  });

  it("goes back from the note to y / a / n on Esc, keeping the draft", async () => {
    const { bridge, calls } = askingBridge(bashApproval, [{ type: "done", usage: "u1" }]);
    const setup = await render(bridge);
    await setup.mockInput.typeText("run the tests");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("Run  bun test"));
    await pressWhenArmed(setup, "n", () =>
      setup.captureCharFrame().includes("Enter deny with this note"),
    );
    setup.mockInput.pressEscape();
    await screen(setup, (f) => f.includes("y allow · a always · n deny"));
    await pressWhenArmed(setup, "y", () => calls.answers.length > 0);
    expect(calls.answers).toEqual([["approval-1", "yes"]]);
    // The reply is still going; Esc only left the note.
    expect(calls.sent).toHaveLength(1);
  });

  it("shows the whole diff, scrolled with Up/Down and PgUp/PgDn, and strips control characters", async () => {
    const diff = [
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      ...Array.from({ length: 60 }, (_, i) => `+line ${i + 1}`),
    ].join("\n");
    const { bridge } = askingBridge(
      {
        id: "approval-3",
        tool: "edit",
        summary: "Edit \u001b[2Jsrc/big.ts\r",
        diff,
        canAlways: false,
      },
      [{ type: "done", usage: "u3" }],
    );
    const setup = await render(bridge);
    await setup.mockInput.typeText("edit it");
    setup.mockInput.pressEnter();
    const top = await screen(setup, (f) => f.includes("Edit [2Jsrc/big.ts"));
    expect(top).not.toContain("\u001b");
    expect(top).toContain("↑↓ scroll");
    expect(top).toMatch(/lines 1–\d+ of 62/);
    expect(top).not.toContain("+line 60");
    // PgDn, as a terminal sends it (the test keyboard has no name for it).
    for (let i = 0; i < 6; i++) setup.mockInput.pressKey("\u001b[6~");
    const bottom = await screen(setup, (f) => f.includes("+line 60"));
    expect(bottom).toMatch(/lines \d+–62 of 62/);
    // The summary stays in view while the diff scrolls.
    expect(bottom).toContain("Edit [2Jsrc/big.ts");
    setup.mockInput.pressArrow("up");
    await screen(setup, (f) => !f.includes("+line 60"));
  });

  it("wraps by terminal columns, expanding tabs, so no approved text is cut off", () => {
    expect(wrap("\tab", 6)).toEqual(["    ab"]);
    expect(wrap("a\tbcdef", 6)).toEqual(["a   bc", "def"]);
    // Wide characters take two columns each.
    expect(wrap("日本語テキスト", 6)).toEqual(["日本語", "テキス", "ト"]);
    expect(wrap("", 6)).toEqual([" "]);
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
    expect(frame).toContain("@ files");
  });

  it("shows a denied call apart from a failed one", async () => {
    const { bridge } = fakeBridge([
      { type: "tool", call: { id: "t1", name: "edit", input: "{}", status: "running" } },
      { type: "tool-result", id: "t1", status: "denied", summary: "edit a.ts · denied · no" },
      { type: "tool", call: { id: "t2", name: "read", input: "{}", status: "running" } },
      { type: "tool-result", id: "t2", status: "error", summary: "read b.ts · missing" },
      { type: "done", usage: "u4" },
    ]);
    const setup = await render(bridge);
    await setup.mockInput.typeText("go");
    setup.mockInput.pressEnter();
    await screen(setup, (f) => f.includes("u4"));
    const colorOf = (text: string) =>
      setup
        .captureSpans()
        .lines.flatMap((line) => line.spans)
        .find((span) => span.text.includes(text))?.fg;
    const denied = colorOf("edit a.ts · denied");
    const failed = colorOf("read b.ts · missing");
    expect(denied).toBeDefined();
    expect(failed).toBeDefined();
    expect(denied).not.toEqual(failed);
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
    // yolo isn't in the cycle: Shift+Tab leaves it for default.
    setup.mockInput.pressKey("\t", { shift: true });
    await screen(setup, (f) => !/yolo\s*$/m.test(f));
    expect(calls.modes.at(-1)).toBe("default");
  });
});

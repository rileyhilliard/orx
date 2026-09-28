import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askEvents, runCli, tempRoot } from "./helpers/cli";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());

const withStub = () => ({ env: { OPENROUTER_BASE_URL: stub.baseUrl } });

describe("stdout contract and exit codes", () => {
  it("prints help to stdout and exits 0", async () => {
    const run = await runCli(["--help"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("SUBCOMMANDS");
    expect(run.stderr).toBe("");
  });

  it("prints the version", async () => {
    const run = await runCli(["--version"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toMatch(/^orx v\d+\.\d+\.\d+/);
  });

  it("exits 2 on an unknown flag with nothing on stdout", async () => {
    const run = await runCli(["ask", "--bogus"]);
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("--bogus");
    expect(run.stderr).toContain("orx ask --help");
  });

  it("renders a usage error as JSON on stderr with --json", async () => {
    const run = await runCli(["ask", "--bogus", "--json"]);
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr)).toEqual({
      error: { tag: "UsageError", message: expect.stringContaining("--bogus"), retryable: false },
    });
  });

  it("exits 3 without a key, before any request", async () => {
    const run = await runCli(["ask", "hi"], {
      env: { OPENROUTER_API_KEY: "", OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("OPENROUTER_API_KEY");
  });

  it("ends --json output with one error event for any failure after parsing", async () => {
    const unknown = await runCli(["ask", "hi", "-m", "nope/x", "--json"], withStub());
    expect(unknown.exitCode).toBe(2);
    expect(askEvents(unknown.stdout)).toMatchObject([
      { type: "error", error: { tag: "UnknownModel", retryable: false } },
    ]);
    const empty = await runCli(["ask", "--json"], withStub());
    expect(askEvents(empty.stdout)).toMatchObject([{ type: "error", error: { tag: "BadInput" } }]);
  });

  it("ends --json output with an InternalError event when orx itself fails", async () => {
    // A data dir that is a file: saving the chat fails, which is a bug-class failure (exit 1).
    const dataDir = join(tempRoot(), "not-a-dir");
    writeFileSync(dataDir, "");
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl, ORX_DATA_DIR: dataDir },
    });
    expect(run.exitCode).toBe(1);
    expect(askEvents(run.stdout).at(-1)).toEqual({
      type: "error",
      error: {
        tag: "InternalError",
        message: expect.stringContaining("Something went wrong inside orx"),
        retryable: true,
      },
    });
  });

  it("exits 2 on an empty prompt", async () => {
    const run = await runCli(["ask"], withStub());
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
  });

  it("logs one command line with flag names and no values", async () => {
    const run = await runCli(["ask", "--model=secret/model", "--bogus"]);
    const lines = run.logs.filter((r) => r.msg === "command");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ command: "ask", exitCode: 2, flags: ["--model", "--bogus"] });
    expect(JSON.stringify(run.logs)).not.toContain("secret/model");
  });

  it("logs no prompt text that looks like a flag, and finds the command after global flags", async () => {
    const run = await runCli(["--log-level", "info", "ask", "- my secret list", "-5", "--", "--x"]);
    const [line] = run.logs.filter((r) => r.msg === "command");
    expect(line).toMatchObject({ command: "ask", flags: ["--log-level"] });
    expect(JSON.stringify(run.logs)).not.toContain("secret");
  });

  it("still logs the command line when a signal interrupts the run", async () => {
    stub.hangAfter = 1;
    const run = await runCli(["ask", "hi"], { ...withStub(), interruptAfterMs: 300 });
    stub.hangAfter = undefined;
    expect(run.exitCode).toBe(130);
    expect(run.logs.filter((r) => r.msg === "command")).toMatchObject([
      { command: "ask", exitCode: 130 },
    ]);
  });
});

describe("choosing a model", () => {
  it("accepts a variant suffix of a listed model", async () => {
    const run = await runCli(["ask", "hi", "-m", "acme/cheap-model:nitro", "--json"], withStub());
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests.at(-1)).toMatchObject({ model: "acme/cheap-model:nitro" });
  });

  it("asks a model that can't call tools without them, so it still answers", async () => {
    const models = stub.models;
    stub.models = [...models, { id: "acme/no-tools", name: "Acme: No Tools", tools: false }];
    const run = await runCli(["ask", "hi", "-m", "acme/no-tools", "--json"], withStub());
    stub.models = models;
    expect(run.exitCode).toBe(0);
    expect(askEvents(run.stdout).filter((e) => e.type === "text").length).toBeGreaterThan(0);
    const request = stub.chatRequests.at(-1) as { model: string; tools?: unknown };
    expect(request.model).toBe("acme/no-tools");
    expect(request).not.toHaveProperty("tools");
  });

  it("passes a named model through, with a warning, when the models list is down", async () => {
    stub.failModels = 10;
    const run = await runCli(["ask", "hi", "-m", "acme/unlisted"], withStub());
    stub.failModels = 0;
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests.at(-1)).toMatchObject({ model: "acme/unlisted" });
    expect(run.logs.some((r) => r.msg.startsWith("Models list unavailable"))).toBe(true);
  });
});

describe("orx ask", () => {
  it("streams the reply to stdout and the usage line to stderr", async () => {
    const run = await runCli(["ask", "say", "hi"], withStub());
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("Hello from the stub.\n");
    expect(run.stderr).toContain("openai/gpt-test");
    expect(run.stderr).toContain("12 in / 5 out");
    expect(run.stderr).toMatch(/chat [0-9a-f-]{36}/);
  });

  it("attributes its requests to orx (https://openrouter.ai/docs/app-attribution)", async () => {
    const run = await runCli(["ask", "hi"], withStub());
    expect(run.exitCode).toBe(0);
    expect(stub.chatHeaders.at(-1)).toMatchObject({
      "http-referer": "https://github.com/rileyhilliard/orx",
      "x-openrouter-title": "orx",
      "x-openrouter-categories": "cli-agent",
    });
  });

  it("reads the prompt from piped stdin", async () => {
    stub.chatRequests.length = 0;
    const run = await runCli(["ask"], { ...withStub(), stdin: "from a pipe\n" });
    expect(run.exitCode).toBe(0);
    expect(JSON.stringify(stub.chatRequests.at(-1))).toContain("from a pipe");
  });

  it("emits NDJSON events ending in done with --json", async () => {
    const run = await runCli(["ask", "hi", "--json"], withStub());
    expect(run.exitCode).toBe(0);
    const events = askEvents(run.stdout);
    expect(events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      model: "openai/gpt-test",
      usage: { inputTokens: 12, outputTokens: 5, cost: 0.00042 },
    });
  });

  it("runs the tool loop across steps from recorded OpenRouter streams", async () => {
    stub.replay(["tool.1", "tool.2"]);
    const run = await runCli(["ask", "what time is it in Tokyo", "--json"], withStub());
    expect(run.exitCode).toBe(0);
    const types = askEvents(run.stdout).map((e) => e.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types.at(-1)).toBe("done");
  });

  it("exits 4 when OpenRouter fails, with a JSON error event", async () => {
    stub.failCompletions = { status: 500, times: 3 };
    const run = await runCli(["ask", "hi", "--json"], withStub());
    stub.failCompletions = undefined;
    expect(run.exitCode).toBe(4);
    const events = askEvents(run.stdout);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { tag: "UpstreamUnavailable", retryable: true },
    });
    expect(JSON.parse(run.stderr)).toMatchObject({ error: { tag: "UpstreamUnavailable" } });
  });

  it("does not retry a rejected key", async () => {
    stub.failCompletions = { status: 401 };
    stub.chatRequests.length = 0;
    const run = await runCli(["ask", "hi"], withStub());
    stub.failCompletions = undefined;
    expect(run.exitCode).toBe(4);
    expect(stub.chatRequests).toHaveLength(1);
    expect(run.stderr).toMatch(/key/i);
  });

  it("saves the exchange, which chats and export read back", async () => {
    const first = await runCli(["ask", "remember", "me", "--json"], withStub());
    const done = askEvents(first.stdout).at(-1) as { chatId: string };
    const listed = await runCli(["chats", "--json"], { ...withStub(), root: first.root });
    expect((JSON.parse(listed.stdout) as Array<{ id: string }>).map((c) => c.id)).toEqual([
      done.chatId,
    ]);
    const exported = await runCli(["export", done.chatId], { ...withStub(), root: first.root });
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain("remember me");
    expect(exported.stdout).toContain("Hello from the stub.");
  });

  it("names the path when -o can't be written: 2 for a missing directory, 6 when denied", async () => {
    const first = await runCli(["ask", "hi", "--json"], withStub());
    const { chatId } = askEvents(first.stdout).at(-1) as { chatId: string };
    const missing = await runCli(["export", chatId, "-o", join(first.root, "nope", "x.md")], {
      root: first.root,
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("nope");

    const locked = join(first.root, "locked");
    mkdirSync(locked, { mode: 0o555 });
    try {
      const denied = await runCli(["export", chatId, "-o", join(locked, "x.md")], {
        root: first.root,
      });
      expect(denied.exitCode).toBe(6);
      expect(denied.stderr).toContain("permission denied");
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("exits 6 naming the data dir, with no done event, when the chat can't be saved there", async () => {
    const dataDir = join(tempRoot(), "data");
    mkdirSync(dataDir, { mode: 0o555 });
    try {
      const run = await runCli(["ask", "hi", "--json"], {
        env: { OPENROUTER_BASE_URL: stub.baseUrl, ORX_DATA_DIR: dataDir },
      });
      // The finished turn is saved before `done`, so a save the user can fix is their error,
      // not a bug reported after the turn already said it was done.
      expect(run.exitCode).toBe(6);
      const events = askEvents(run.stdout);
      expect(events.some((e) => e.type === "done")).toBe(false);
      const message = `${dataDir}/chats isn't writable (permission denied)`;
      expect(events.at(-1)).toMatchObject({
        type: "error",
        error: {
          tag: "PermissionDenied",
          retryable: false,
          message: expect.stringContaining(message),
        },
      });
      expect(JSON.parse(run.stderr)).toMatchObject({ error: { tag: "PermissionDenied" } });
      expect(run.logs.filter((r) => r.level === "error")).toEqual([]);
    } finally {
      chmodSync(dataDir, 0o755);
    }
  });

  it("exits 2 exporting a chat that doesn't exist", async () => {
    const run = await runCli(["export", "00000000-0000-4000-8000-000000000000"]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("orx chats");
  });
});

describe("a closed stdout", () => {
  it("ends the run quietly with exit 0, not 130 or a bug report", async () => {
    const run = await runCli(["models", "--json"], { ...withStub(), stdoutClosed: true });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.logs.filter((r) => r.level === "error")).toEqual([]);
  });
});

describe("orx models", () => {
  it("searches the models list", async () => {
    const run = await runCli(["models", "cheap", "--json"], withStub());
    expect(run.exitCode).toBe(0);
    const list = JSON.parse(run.stdout) as { models: Array<{ id: string }>; available: boolean };
    expect(list.available).toBe(true);
    expect(list.models.map((m) => m.id)).toEqual(["acme/cheap-model"]);
  });

  it("logs one warning with OpenRouter's status after the retries, not one per attempt", async () => {
    stub.failModels = 10;
    const run = await runCli(["models", "--json"], withStub());
    stub.failModels = 0;
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ available: false });
    const warnings = run.logs.filter((r) => r.level === "warn");
    expect(warnings.map((r) => r.msg)).toEqual(["Models list unavailable"]);
    expect(JSON.stringify(warnings[0])).toContain("HTTP 500");
  });

  it("shows a variable (-1, as openrouter/auto has) or unreadable price as unknown", async () => {
    const models = stub.models;
    stub.models = [
      { id: "openrouter/auto", name: "Auto Router", prompt: "-1", completion: "-1" },
      { id: "acme/odd", name: "Acme: Odd", prompt: "n/a", completion: "0.000002" },
    ];
    const json = await runCli(["models", "--json"], withStub());
    const table = await runCli(["models"], withStub());
    stub.models = models;
    expect(JSON.parse(json.stdout).models).toMatchObject([
      { id: "openrouter/auto", promptPrice: null, completionPrice: null },
      { id: "acme/odd", promptPrice: null, completionPrice: 0.000002 },
    ]);
    expect(table.stdout).toMatch(/openrouter\/auto\s+128k\s+varies\s+varies/);
  });

  it("rejects an unknown --model with exit 2 and a suggestion", async () => {
    const run = await runCli(["ask", "hi", "-m", "openai/gpt-tset"], withStub());
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("openai/gpt-test");
  });
});

describe("orx (the session)", () => {
  it("exits 2 without a terminal and points at ask", async () => {
    const run = await runCli([], { ...withStub(), stdin: "" });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("orx ask");
  });

  it("refuses to resume a chat from another workspace unless --cwd picks one", async () => {
    const root = tempRoot();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "orx-elsewhere-")));
    const id = "0f8c2d4e-3b1a-4c5d-8e9f-1a2b3c4d5e6f";
    mkdirSync(join(root, "data", "chats"), { recursive: true });
    writeFileSync(
      join(root, "data", "chats", `${id}.json`),
      JSON.stringify({
        id,
        cwd: elsewhere,
        model: "openai/gpt-test",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [{ role: "user", text: "hi" }],
      }),
    );
    const here = await runCli(["--resume", id], { ...withStub(), root, stdoutIsTerminal: true });
    expect(here.exitCode).toBe(2);
    expect(here.stdout).toBe("");
    expect(here.stderr).toContain(`ran in ${elsewhere}`);
    expect(here.stderr).toContain("--cwd");
    // With --cwd the check passes; the run then stops at the TUI, which vitest can't start.
    const chosen = await runCli(["--resume", id, "--cwd", elsewhere], {
      ...withStub(),
      root,
      stdoutIsTerminal: true,
    });
    expect(chosen.stderr).not.toContain("ran in");
    expect(chosen.exitCode).toBe(3);
    expect(chosen.stdout).toBe("");
    expect(chosen.stderr).toMatch(/orx: The terminal UI couldn't (load|start)/);
  });
});

describe("orx doctor --tui", () => {
  // vitest runs on Node, where OpenTUI's native FFI isn't available, so this path is certain.
  it("reports the TUI failure, then exits 3 with a TuiUnavailable error on stderr", async () => {
    const run = await runCli(["doctor", "--tui", "--json"]);
    expect(run.exitCode).toBe(3);
    // The report still reaches stdout, so a bug report has both it and the exit code.
    expect(JSON.parse(run.stdout)).toMatchObject({
      tui: {
        nativeLib: false,
        renderer: null,
        error: expect.stringMatching(/The terminal UI couldn't (load|start)/),
      },
    });
    expect(JSON.parse(run.stderr)).toEqual({
      error: {
        tag: "TuiUnavailable",
        message: expect.stringMatching(/^The terminal UI couldn't (load|start)/),
        retryable: false,
      },
    });
  });
});

describe("orx extract", () => {
  it("prints the contact as JSON", async () => {
    stub.completion = {
      ...stub.completion,
      text: JSON.stringify({
        name: "Ada Lovelace",
        email: "ada@example.com",
        phone: null,
        company: null,
      }),
    };
    const run = await runCli(["extract", "Ada Lovelace, ada@example.com", "--json"], withStub());
    stub.completion = { ...stub.completion, text: "Hello from the stub." };
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: null,
      company: null,
    });
  });

  it("asks for strict structured output (https://openrouter.ai/docs/guides/features/structured-outputs)", async () => {
    await runCli(["extract", "Ada"], withStub());
    expect(stub.chatRequests.at(-1)).toMatchObject({
      response_format: { type: "json_schema", json_schema: { name: "Contact", strict: true } },
    });
  });

  it("waits out a short Retry-After on a 429, and gives up on a long one", async () => {
    const contact = { name: "Ada", email: null, phone: null, company: null };
    stub.completion = { ...stub.completion, text: JSON.stringify(contact) };
    try {
      stub.failCompletions = { status: 429, headers: { "retry-after": "1" }, times: 1 };
      const started = Date.now();
      const waited = await runCli(["extract", "Ada"], withStub());
      expect(waited.exitCode).toBe(0);
      // The backoff alone is about 500 ms; Retry-After asks for a second.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);

      stub.chatRequests.length = 0;
      stub.failCompletions = { status: 429, headers: { "retry-after": "60" } };
      const gaveUp = await runCli(["extract", "Ada"], withStub());
      expect(gaveUp.exitCode).toBe(4);
      expect(stub.chatRequests).toHaveLength(1);
    } finally {
      stub.failCompletions = undefined;
      stub.completion = { ...stub.completion, text: "Hello from the stub." };
    }
  });

  it("exits 5 when the model's output isn't a contact", async () => {
    stub.completion = { ...stub.completion, text: JSON.stringify({ nope: true }) };
    const run = await runCli(["extract", "Ada"], withStub());
    stub.completion = { ...stub.completion, text: "Hello from the stub." };
    expect(run.exitCode).toBe(5);
  });
});

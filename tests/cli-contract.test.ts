import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ndjson, runCli } from "./helpers/cli";
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

  it("reads the prompt from piped stdin", async () => {
    stub.chatRequests.length = 0;
    const run = await runCli(["ask"], { ...withStub(), stdin: "from a pipe\n" });
    expect(run.exitCode).toBe(0);
    expect(JSON.stringify(stub.chatRequests.at(-1))).toContain("from a pipe");
  });

  it("emits NDJSON events ending in done with --json", async () => {
    const run = await runCli(["ask", "hi", "--json"], withStub());
    expect(run.exitCode).toBe(0);
    const events = ndjson(run.stdout);
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
    const types = ndjson(run.stdout).map((e) => e.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types.at(-1)).toBe("done");
  });

  it("exits 4 when OpenRouter fails, with a JSON error event", async () => {
    stub.failCompletions = { status: 500, times: 3 };
    const run = await runCli(["ask", "hi", "--json"], withStub());
    stub.failCompletions = undefined;
    expect(run.exitCode).toBe(4);
    const events = ndjson(run.stdout);
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
    const done = ndjson(first.stdout).at(-1) as { chatId: string };
    const listed = await runCli(["chats", "--json"], { ...withStub(), root: first.root });
    expect((JSON.parse(listed.stdout) as Array<{ id: string }>).map((c) => c.id)).toEqual([
      done.chatId,
    ]);
    const exported = await runCli(["export", done.chatId], { ...withStub(), root: first.root });
    expect(exported.exitCode).toBe(0);
    expect(exported.stdout).toContain("remember me");
    expect(exported.stdout).toContain("Hello from the stub.");
  });

  it("exits 2 exporting a chat that doesn't exist", async () => {
    const run = await runCli(["export", "00000000-0000-4000-8000-000000000000"]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("orx chats");
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

  it("rejects an unknown --model with exit 2 and a suggestion", async () => {
    const run = await runCli(["ask", "hi", "-m", "openai/gpt-tset"], withStub());
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("openai/gpt-test");
  });
});

describe("orx chat", () => {
  it("exits 2 without a terminal and points at ask", async () => {
    const run = await runCli(["chat"], { ...withStub(), stdin: "" });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("orx ask");
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

  it("exits 5 when the model's output isn't a contact", async () => {
    stub.completion = { ...stub.completion, text: JSON.stringify({ nope: true }) };
    const run = await runCli(["extract", "Ada"], withStub());
    stub.completion = { ...stub.completion, text: "Hello from the stub." };
    expect(run.exitCode).toBe(5);
  });
});

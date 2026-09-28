import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./helpers/cli";
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

  it("keeps stdout empty and prints the error as JSON on stderr with --json", async () => {
    const run = await runCli(["ask", "--json"], withStub());
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(JSON.parse(run.stderr)).toEqual({
      error: { tag: "BadInput", message: expect.stringContaining("empty"), retryable: false },
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

describe("orx ask", () => {
  it("prints the reply to stdout and the usage line to stderr", async () => {
    const run = await runCli(["ask", "say", "hi"], withStub());
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("Hello from the stub.\n");
    expect(run.stderr).toContain("openai/gpt-test");
    expect(run.stderr).toContain("12 in / 5 out");
    expect(stub.chatRequests.at(-1)).toMatchObject({
      model: "openai/gpt-test",
      messages: [{ role: "user", content: "say hi" }],
    });
  });

  it("reads the prompt from piped stdin", async () => {
    const run = await runCli(["ask"], { ...withStub(), stdin: "from a pipe\n" });
    expect(run.exitCode).toBe(0);
    expect(JSON.stringify(stub.chatRequests.at(-1))).toContain("from a pipe");
  });

  it("sends the model named with --model", async () => {
    const run = await runCli(["ask", "hi", "-m", "acme/cheap-model"], withStub());
    expect(run.exitCode).toBe(0);
    expect(stub.chatRequests.at(-1)).toMatchObject({ model: "acme/cheap-model" });
  });

  it("prints one result object with --json", async () => {
    const run = await runCli(["ask", "hi", "--json"], withStub());
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      text: "Hello from the stub.",
      model: "openai/gpt-test",
      usage: { inputTokens: 12, outputTokens: 5, cost: 0.00042 },
    });
  });

  it("logs one llm call line with the model, tokens, and cost", async () => {
    const run = await runCli(["ask", "hi"], withStub());
    expect(run.logs.filter((r) => r.msg === "llm call")).toMatchObject([
      { requestedModel: "openai/gpt-test", inputTokens: 12, outputTokens: 5, cost: 0.00042 },
    ]);
  });

  it("retries a failing OpenRouter, then exits 4 with a retryable error", async () => {
    stub.failCompletions = { status: 500, times: 3 };
    stub.chatRequests.length = 0;
    const run = await runCli(["ask", "hi", "--json"], withStub());
    stub.failCompletions = undefined;
    expect(run.exitCode).toBe(4);
    expect(run.stdout).toBe("");
    expect(stub.chatRequests).toHaveLength(3);
    expect(JSON.parse(run.stderr)).toMatchObject({
      error: { tag: "UpstreamUnavailable", retryable: true },
    });
  });

  it("recovers when a retry succeeds", async () => {
    stub.failCompletions = { status: 500, times: 1 };
    const run = await runCli(["ask", "hi"], withStub());
    stub.failCompletions = undefined;
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("Hello from the stub.\n");
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
});

describe("a closed stdout", () => {
  it("ends the run quietly with exit 0, not 130 or a bug report", async () => {
    const run = await runCli(["ask", "hi", "--json"], { ...withStub(), stdoutClosed: true });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.logs.filter((r) => r.level === "error")).toEqual([]);
  });
});

describe("orx ui", () => {
  it("exits 2 without a terminal and points at ask", async () => {
    const run = await runCli(["ui"], { ...withStub(), stdin: "" });
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("orx ask");
  });
});

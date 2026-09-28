import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ndjson, runCli } from "./helpers/cli";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.chatRequests.length = 0;
  stub.toolCalls = [];
});

const workspace = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orx-ask-agent-")));
  writeFileSync(join(dir, "math.js"), "export const add = (a, b) => a + b;\n");
  return dir;
};

const readThenEdit = (dir: string) => [
  { name: "read", arguments: JSON.stringify({ path: "math.js" }) },
  {
    name: "edit",
    arguments: JSON.stringify({
      path: join(dir, "math.js"),
      old_string: "a + b",
      new_string: "a + b + 0",
    }),
  },
];

const toolResults = (stdout: string) =>
  ndjson(stdout).filter((e) => e.type === "tool-result") as Array<{
    name: string;
    isFailure: boolean;
    output: unknown;
  }>;

describe("orx ask --agent", () => {
  it("reads and edits in the workspace with --permission-mode acceptEdits", async () => {
    const dir = workspace();
    stub.toolCalls = readThenEdit(dir);
    const run = await runCli(
      ["ask", "fix it", "--agent", "--cwd", dir, "--permission-mode", "acceptEdits", "--json"],
      { env: { OPENROUTER_BASE_URL: stub.baseUrl } },
    );
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(dir, "math.js"), "utf8")).toBe(
      "export const add = (a, b) => a + b + 0;\n",
    );
    expect(toolResults(run.stdout).map((r) => [r.name, r.isFailure])).toEqual([
      ["read", false],
      ["edit", false],
    ]);
    // The model got the agent's system prompt, with the workspace root in it.
    const first = stub.chatRequests[0] as { messages: Array<{ role: string; content: unknown }> };
    expect(JSON.stringify(first.messages[0]?.content)).toContain(dir);
  });

  it("denies the edit in the default mode, since nobody can be asked", async () => {
    const dir = workspace();
    stub.toolCalls = readThenEdit(dir);
    const run = await runCli(["ask", "fix it", "--agent", "--cwd", dir, "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(join(dir, "math.js"), "utf8")).toBe(
      "export const add = (a, b) => a + b;\n",
    );
    const edit = toolResults(run.stdout).find((r) => r.name === "edit");
    expect(edit?.isFailure).toBe(true);
    expect(JSON.stringify(edit?.output)).toContain("interactive");
    // Bare `orx` is the interactive session; there is no `orx chat`.
    expect(JSON.stringify(edit?.output)).toContain("(run orx, or pass");
  });

  it("reports a denied call as a permission-denied event before its tool-result", async () => {
    const dir = workspace();
    stub.toolCalls = readThenEdit(dir);
    const run = await runCli(["ask", "fix it", "--agent", "--cwd", dir, "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(0);
    const events = ndjson(run.stdout) as Array<{ type: string; id?: string; name?: string }>;
    const denied = events.filter((e) => e.type === "permission-denied");
    const editCall = events.find((e) => e.type === "tool-call" && e.name === "edit");
    expect(denied).toEqual([
      {
        type: "permission-denied",
        id: editCall?.id,
        tool: "edit",
        message: expect.stringContaining("edit needs an interactive session"),
      },
    ]);
    const deniedAt = events.indexOf(denied[0] as (typeof events)[number]);
    expect(events[deniedAt + 1]).toMatchObject({ type: "tool-result", id: editCall?.id });
  });

  it("notes a failed or denied tool call on stderr in text mode", async () => {
    const dir = workspace();
    stub.toolCalls = [
      { name: "read", arguments: JSON.stringify({ path: "nope.txt" }) },
      ...readThenEdit(dir),
    ];
    const run = await runCli(["ask", "fix it", "--agent", "--cwd", dir], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("✗");
    expect(run.stderr).toContain("✗ read: nope.txt: no such file");
    expect(run.stderr).toContain("✗ edit: Edit math.js: denied. edit needs an interactive session");
  });

  it("notes why a bash command failed, not the output it printed first", async () => {
    stub.toolCalls = [
      {
        name: "bash",
        arguments: JSON.stringify({ command: "echo started; sleep 5", timeout_ms: 300 }),
      },
    ];
    const run = await runCli(
      ["ask", "run it", "--agent", "--cwd", workspace(), "--permission-mode", "yolo"],
      { env: { OPENROUTER_BASE_URL: stub.baseUrl } },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("✗ bash: (timed out after 0.3 s");
    expect(run.stderr).not.toContain("✗ bash: started");
  });

  it("refuses --cwd and --permission-mode without --agent", async () => {
    const env = { OPENROUTER_BASE_URL: stub.baseUrl };
    const cwd = await runCli(["ask", "hi", "--cwd", workspace()], { env });
    expect(cwd.exitCode).toBe(2);
    expect(cwd.stderr).toContain("--cwd needs --agent");
    const mode = await runCli(["ask", "hi", "--permission-mode", "yolo"], { env });
    expect(mode.exitCode).toBe(2);
    expect(mode.stderr).toContain("--permission-mode needs --agent");
    // Naming the default mode is still a mode without --agent.
    const explicitDefault = await runCli(["ask", "hi", "--permission-mode", "default"], { env });
    expect(explicitDefault.exitCode).toBe(2);
    expect(explicitDefault.stderr).toContain("--permission-mode needs --agent");
    expect(stub.chatRequests).toHaveLength(0);
  });

  it("refuses a model that can't call tools with exit 2", async () => {
    const models = stub.models;
    stub.models = [{ id: "acme/no-tools", name: "Acme: No Tools", tools: false }];
    const run = await runCli(
      ["ask", "hi", "--agent", "--cwd", workspace(), "--model", "acme/no-tools"],
      { env: { OPENROUTER_BASE_URL: stub.baseUrl } },
    );
    stub.models = models;
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("doesn't support tool calling");
    expect(stub.chatRequests).toHaveLength(0);
  });

  it("warns when it can't check that the model calls tools", async () => {
    stub.failModels = 10;
    const run = await runCli(["ask", "hi", "--agent", "--cwd", workspace()], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    stub.failModels = 0;
    expect(run.exitCode).toBe(0);
    const warnings = run.logs.filter((r) => r.level === "warn" && /tool calling/.test(r.msg));
    expect(warnings).toHaveLength(1);
  });

  it("gives plain ask no workspace tools", async () => {
    const run = await runCli(["ask", "hi", "--json"], {
      env: { OPENROUTER_BASE_URL: stub.baseUrl },
    });
    expect(run.exitCode).toBe(0);
    const request = stub.chatRequests[0] as { tools?: Array<{ function: { name: string } }> };
    expect(request.tools?.map((t) => t.function.name)).toEqual(["currentTime"]);
  });
});

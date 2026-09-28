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

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ndjson, runCli, tempRoot } from "./helpers/cli";
import { type StubOpenRouter, startStubOpenRouter } from "./helpers/stub-openrouter";

// A user-level skill (~/.config/orx/skills/<name>/) through a whole agent turn: the model sees
// its description, loads it with the skill tool, and may read the skill's own supporting files
// even though they live outside the workspace. Nothing else outside the workspace opens up.

let stub: StubOpenRouter;
beforeAll(async () => {
  stub = await startStubOpenRouter();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.chatRequests.length = 0;
  stub.steps = [];
});

const call = (name: string, input: Record<string, unknown>) => ({
  name,
  arguments: JSON.stringify(input),
});

type ToolResult = { type: string; name: string; isFailure: boolean; output: unknown };

describe("a user-level skill in an agent turn", () => {
  it("offers the skill, loads it, and reads its supporting file, but no other outside file", async () => {
    const root = tempRoot();
    const skillDir = join(root, "config", "orx", "skills", "release");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: release\ndescription: Cut a release of this project\n---\nFollow checklist.md.\n",
    );
    writeFileSync(join(skillDir, "checklist.md"), "1. bump the version\n");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "orx-elsewhere-")));
    writeFileSync(join(elsewhere, "private.txt"), "not for the model\n");
    const work = realpathSync(mkdtempSync(join(tmpdir(), "orx-skill-work-")));

    stub.steps = [
      { toolCalls: [call("skill", { name: "release" })] },
      {
        toolCalls: [
          call("read", { path: join(skillDir, "checklist.md") }),
          call("read", { path: join(elsewhere, "private.txt") }),
        ],
      },
      { toolCalls: [call("write", { path: join(skillDir, "checklist.md"), content: "hijack" })] },
      { text: "Released." },
    ];
    const run = await runCli(
      ["ask", "cut a release", "--agent", "--cwd", work, "--permission-mode", "yolo", "--json"],
      { root, env: { OPENROUTER_BASE_URL: stub.baseUrl } },
    );
    expect(run.exitCode).toBe(0);

    // The system prompt names the skill and what it's for.
    const first = stub.chatRequests[0] as { messages: Array<{ role: string; content: unknown }> };
    const system = JSON.stringify(first.messages[0]?.content);
    expect(system).toContain("release");
    expect(system).toContain("Cut a release of this project");

    const results = (ndjson(run.stdout) as ToolResult[]).filter((e) => e.type === "tool-result");
    const byOutput = (text: string) => results.find((r) => JSON.stringify(r.output).includes(text));
    expect(results.find((r) => r.name === "skill")).toMatchObject({ isFailure: false });
    expect(JSON.stringify(results.find((r) => r.name === "skill")?.output)).toContain(
      "Follow checklist.md.",
    );
    expect(byOutput("bump the version")).toMatchObject({ name: "read", isFailure: false });
    const outside = results.find(
      (r) => r.name === "read" && JSON.stringify(r.output).includes("private.txt"),
    );
    expect(outside).toMatchObject({ isFailure: true });
    expect(JSON.stringify(results)).not.toContain("not for the model");
    // A skill's directory is readable, not writable: even yolo can't change it.
    expect(results.find((r) => r.name === "write")).toMatchObject({ isFailure: true });
    expect(readFileSync(join(skillDir, "checklist.md"), "utf8")).toBe("1. bump the version\n");
  });
});

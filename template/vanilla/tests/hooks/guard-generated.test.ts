import { afterAll, describe, expect, it } from "bun:test";
import { denyReason, makeFixture, REPO, runHook, write } from "../helpers/hooks";

const run = (filePath: string, env?: Record<string, string>) =>
  runHook("PreToolUse", "guard-generated", write(filePath, "x"), { env });

describe.concurrent("guard-generated denies", () => {
  it.each([
    [`${REPO}/dist/orx`, "is build output"],
    ["dist/SHA256SUMS", "is build output"],
    ["coverage/index.html", "is a coverage report"],
    [`${REPO}/bun.lock`, "bun.lock is written by bun"],
  ])("%s", async (filePath, reason) => {
    expect(denyReason(await run(filePath))).toContain(reason);
  });
});

describe.concurrent("guard-generated allows", () => {
  it.each([
    `${REPO}/src/bin.ts`,
    `${REPO}/src/dist/helper.ts`,
    `${REPO}/tests/fixtures/other/case.json`,
    "distribution/notes.ts",
    "/somewhere/else/dist/orx",
  ])("%s", async (filePath) => {
    const result = await run(filePath);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("guard-generated with a project dir that isn't symlink-resolved", () => {
  const fixture = makeFixture();
  afterAll(fixture.cleanup);

  it("compares against the project dir as given", async () => {
    const result = await run(`${fixture.dir}/dist/orx`, { CLAUDE_PROJECT_DIR: fixture.dir });
    expect(denyReason(result)).toContain("is build output");
  });
});

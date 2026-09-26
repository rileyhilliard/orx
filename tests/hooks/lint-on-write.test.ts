import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, makeFixture, REPO, runHook } from "../helpers/hooks";

let project: Fixture;
let tmp: string;

beforeEach(() => {
  project = makeFixture();
  writeFileSync(join(project.dir, "biome.json"), "{}\n");
  tmp = mkdtempSync(join(tmpdir(), "orx-hook-tmp-"));
});
afterEach(() => {
  project.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

const lint = (filePath: string, options: { session?: string; cwd?: string; root?: string } = {}) =>
  runHook(
    "PostToolUse",
    "lint-on-write",
    {
      session_id: options.session ?? "lint-session",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: filePath },
      cwd: options.cwd ?? project.dir,
    },
    { env: { CLAUDE_PROJECT_DIR: options.root ?? project.dir, TMPDIR: tmp } },
  );

const put = (dir: string, name: string, content: string) => {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const context = (result: Awaited<ReturnType<typeof lint>>) =>
  result.output?.hookSpecificOutput?.additionalContext;

describe("lint-on-write", { timeout: 30_000 }, () => {
  it("hands biome's diagnostics back, naming the project-relative file", async () => {
    const result = await lint(put(project.dir, "src/bad.ts", "debugger;\n"));
    expect(result.output?.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(context(result)).toMatch(
      /^biome check found issues in src\/bad\.ts\. Fix them before moving on:\n/,
    );
    expect(context(result)).toContain("noDebugger");
    expect(context(result)).not.toContain(project.real);
  });

  it("says nothing about a clean file", async () => {
    const result = await lint(put(project.dir, "clean.ts", "export const a = 1;\n"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["in node_modules", "node_modules/pkg/index.ts"],
    ["with an extension it doesn't lint", "notes.txt"],
  ])("says nothing about a file %s", async (_, name) => {
    expect((await lint(put(project.dir, name, "debugger;\n"))).stdout).toBe("");
  });

  it("ignores a file outside the project and the working directory", async () => {
    const elsewhere = makeFixture();
    try {
      writeFileSync(join(elsewhere.dir, "biome.json"), "{}\n");
      expect((await lint(put(elsewhere.dir, "bad.ts", "debugger;\n"))).stdout).toBe("");
    } finally {
      elsewhere.cleanup();
    }
  });

  it("lints a file outside the project that is under the payload's cwd (a worktree)", async () => {
    const worktree = makeFixture();
    try {
      writeFileSync(join(worktree.dir, "biome.json"), "{}\n");
      const result = await lint(put(worktree.dir, "bad.ts", "debugger;\n"), { cwd: worktree.dir });
      expect(context(result)).toContain("noDebugger");
    } finally {
      worktree.cleanup();
    }
  });

  it("records the written path in the session's list, under a sanitized session id", async () => {
    const file = put(project.dir, "clean.ts", "export const a = 1;\n");
    await lint(file, { session: "../evil id" });
    const list = readFileSync(join(tmp, "orx-hooks", "evilid.files"), "utf8");
    expect(list).toBe(`${join(project.real, "clean.ts")}\n`);
  });

  it("applies this repo's config, including the boundaries plugin", async () => {
    // A real file under src/ (the plugin only matches src/). Dot-prefixed so a tsc run alongside
    // skips it; a run killed mid-test leaves one behind, so sweep those first.
    const isTempFile = (name: string) => name.startsWith(".hooktest-");
    for (const name of readdirSync(join(REPO, "src")).filter(isTempFile)) {
      rmSync(join(REPO, "src", name), { force: true });
    }
    const file = join(REPO, "src", `.hooktest-${randomUUID()}.ts`);
    writeFileSync(file, 'export const f = () => console.log("hi");\n');
    try {
      const result = await lint(file, { cwd: REPO, root: REPO });
      expect(context(result)).toContain("No console in src/");
    } finally {
      rmSync(file, { force: true });
    }
  });
});

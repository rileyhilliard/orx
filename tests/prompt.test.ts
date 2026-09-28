import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Paths } from "~/config";
import {
  buildSystemPrompt,
  DEFAULT_AGENT_PROMPT,
  gatherEnv,
  loadMemory,
  MEMORY_MAX_CHARS,
} from "~/core/prompt";
import { Host } from "~/services/Host";

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "orx-prompt-")));

const env = {
  root: "/work/app",
  platform: "darwin",
  date: "2026-09-28",
  isGitRepo: true,
  branch: "main",
};

describe("buildSystemPrompt", () => {
  it("puts the base prompt, the environment, skills, then memory, in that order", () => {
    const prompt = buildSystemPrompt({
      env,
      memory: ["Contents of /work/AGENTS.md:\n\nUse tabs."],
      skills: [{ name: "release", description: "Cut a release" }],
    });
    expect(prompt.startsWith(DEFAULT_AGENT_PROMPT)).toBe(true);
    expect(prompt).toContain(
      "<env>\nWorkspace root: /work/app\nPlatform: darwin\nDate: 2026-09-28\nGit repository: yes (branch main)\n</env>",
    );
    expect(prompt).toContain("- release: Cut a release");
    const order = ["<env>", "- release:", "Use tabs."].map((text) => prompt.indexOf(text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("uses a custom base, and leaves out empty skills and memory", () => {
    const prompt = buildSystemPrompt({
      base: "Custom.",
      env: { ...env, isGitRepo: false, branch: undefined },
      memory: [],
      skills: [],
    });
    expect(prompt.startsWith("Custom.\n\n<env>")).toBe(true);
    expect(prompt).toContain("Git repository: no");
    expect(prompt).not.toContain("Skills");
    expect(prompt).not.toContain("AGENTS.md");
  });

  it("carries the tool rules", () => {
    for (const rule of [
      "Read a file before you edit",
      "glob",
      "grep",
      "no persistent shell",
      "Stay in the workspace",
    ]) {
      expect(DEFAULT_AGENT_PROMPT).toContain(rule);
    }
  });
});

const pathsFor = (configHome: string) =>
  Layer.succeed(Paths, {
    home: Option.none(),
    configFile: join(configHome, "orx", "config.json"),
    dataDir: join(configHome, "data"),
    logFile: Option.none(),
  });

const memoryFor = (root: string, configHome: string) =>
  Effect.runPromise(
    loadMemory(root).pipe(Effect.provide(pathsFor(configHome)), Effect.provide(NodeServices.layer)),
  );

describe("loadMemory", () => {
  it("reads the user's file, then AGENTS.md from the git root down, CLAUDE.md as the fallback", async () => {
    const base = tempDir();
    const repo = join(base, "repo");
    const app = join(repo, "packages", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(app, { recursive: true });
    mkdirSync(join(base, "config", "orx"), { recursive: true });
    writeFileSync(join(base, "AGENTS.md"), "above the repo: not read");
    writeFileSync(join(base, "config", "orx", "AGENTS.md"), "user");
    writeFileSync(join(repo, "AGENTS.md"), "repo agents");
    writeFileSync(join(repo, "CLAUDE.md"), "repo claude: not read");
    writeFileSync(join(repo, "packages", "CLAUDE.md"), "packages claude");
    writeFileSync(join(app, "AGENTS.md"), "app agents");

    const memory = await memoryFor(app, join(base, "config"));
    expect(memory).toEqual([
      `Contents of ${join(base, "config", "orx", "AGENTS.md")}:\n\nuser`,
      `Contents of ${join(repo, "AGENTS.md")}:\n\nrepo agents`,
      `Contents of ${join(repo, "packages", "CLAUDE.md")}:\n\npackages claude`,
      `Contents of ${join(app, "AGENTS.md")}:\n\napp agents`,
    ]);
  });

  it("reads only the root's file outside a git repo", async () => {
    const base = tempDir();
    const root = join(base, "project");
    mkdirSync(root);
    writeFileSync(join(base, "AGENTS.md"), "parent");
    writeFileSync(join(root, "AGENTS.md"), "root");
    expect(await memoryFor(root, join(base, "config"))).toEqual([
      `Contents of ${join(root, "AGENTS.md")}:\n\nroot`,
    ]);
  });

  it("caps memory at 32 KiB with a truncation note", async () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "config", "orx"), { recursive: true });
    writeFileSync(join(root, "config", "orx", "AGENTS.md"), "u".repeat(MEMORY_MAX_CHARS - 2000));
    writeFileSync(join(root, "AGENTS.md"), "p".repeat(3000));
    const memory = await memoryFor(root, join(root, "config"));
    expect(memory).toHaveLength(3);
    expect(memory.slice(0, 2).join("").length).toBe(MEMORY_MAX_CHARS);
    expect(memory[2]).toBe("[memory truncated at 32 KiB; the rest was left out]");
  });
});

describe("gatherEnv", () => {
  const host = Host.layer({ execPath: "orx", compiled: true, platform: "linux", arch: "x64" });
  const envFor = (root: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 8, 28, 12));
        return yield* gatherEnv(root);
      }).pipe(Effect.provide(Layer.mergeAll(host, NodeServices.layer, TestClock.layer()))),
    );

  it("reads the branch from .git/HEAD, a worktree's gitdir, or a detached hash", async () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
    expect(await envFor(repo)).toEqual({
      root: repo,
      platform: "linux",
      date: "2026-09-28",
      isGitRepo: true,
      branch: "feat/x",
    });

    const worktree = tempDir();
    mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(repo, ".git", "worktrees", "wt", "HEAD"), "0123456789abcdef\n");
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
    expect((await envFor(worktree)).branch).toBe("0123456");
  });

  it("says no git outside a repo", async () => {
    const root = tempDir();
    expect(await envFor(root)).toMatchObject({ isGitRepo: false, branch: undefined });
  });
});

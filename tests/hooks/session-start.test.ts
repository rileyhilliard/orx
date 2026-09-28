import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_ENV, type GitRepo, makeGitRepo, runHook } from "../helpers/hooks";
import { waitFor } from "../helpers/wait";

// Each test spawns the hook (and biome, tsc, or git), so it gets more than the default 5 s.
const TIMEOUT = 30_000;

let repo: string;
let git: GitRepo["git"];
let put: GitRepo["put"];
let cleanup: () => void;
// Where the hook keeps its log offset; per test, so no state leaks between them or from the machine.
let tmp: string;

// The bun that runs the hook (the one on PATH), so a fixture can pin it or not.
const BUN_VERSION = spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim();
const NATIVE = `@opentui/core-${process.platform}-${process.arch}`;

const commitAll = () => {
  git("add", "-A");
  git("commit", "-q", "-m", "init");
};
const sessionStart = async () => {
  const result = await runHook(
    "SessionStart",
    "session-start",
    { session_id: "s", hook_event_name: "SessionStart", source: "startup" },
    { env: { CLAUDE_PROJECT_DIR: repo, TMPDIR: tmp, ...GIT_ENV } },
  );
  expect(result.code).toBe(0);
  return result.stdout;
};

beforeEach(() => {
  ({ dir: repo, git, put, cleanup } = makeGitRepo());
  tmp = mkdtempSync(join(tmpdir(), "orx-hook-tmp-"));
});
afterEach(() => {
  cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

describe("session-start", () => {
  it(
    "reports the branch and the number of changed files, without nudging before the first commit",
    async () => {
      put("a.txt");
      put("b.txt");
      const out = await sessionStart();
      expect(out).toContain("Repo state: branch `main`, 2 changed file(s).");
      expect(out).not.toContain("create a branch");
    },
    TIMEOUT,
  );

  it(
    "nudges off main once there is a commit, unless the repo opts out",
    async () => {
      put("a.txt");
      commitAll();
      expect(await sessionStart()).toContain(
        "You're on `main`: create a branch before committing non-trivial work.",
      );
      git("config", "orx.allowMain", "true");
      expect(await sessionStart()).not.toContain("create a branch");
    },
    TIMEOUT,
  );

  it(
    "prints only the repo line for a set-up checkout on a feature branch",
    async () => {
      put("package.json", JSON.stringify({ packageManager: `bun@${BUN_VERSION}` }));
      put("node_modules/.keep");
      put(".gitignore", "node_modules/\n");
      commitAll();
      git("checkout", "-q", "-b", "feature");
      expect(await sessionStart()).toBe("Repo state: branch `feature`, 0 changed file(s).\n");
    },
    TIMEOUT,
  );

  it(
    "notes a missing .env when there is an .env.example",
    async () => {
      put(".env.example", "OPENROUTER_API_KEY=\n");
      expect(await sessionStart()).toContain(".env is missing. Copy .env.example to .env");
    },
    TIMEOUT,
  );

  it(
    "notes missing node_modules with the install command for the lockfile",
    async () => {
      put("package.json", "{}\n");
      put("bun.lock", "");
      expect(await sessionStart()).toContain(
        "Dependencies not installed (missing node_modules), so lint-on-write and format-changed skip those files. Install with `bun install`.",
      );
    },
    TIMEOUT,
  );

  it(
    "notes a bun that differs from packageManager",
    async () => {
      put("package.json", JSON.stringify({ packageManager: "bun@0.0.1" }));
      expect(await sessionStart()).toContain(
        `bun ${BUN_VERSION} is on PATH, but package.json pins bun@0.0.1 (packageManager)`,
      );
    },
    TIMEOUT,
  );

  it(
    "says nothing about bun when it matches packageManager",
    async () => {
      put("package.json", JSON.stringify({ packageManager: `bun@${BUN_VERSION}` }));
      expect(await sessionStart()).not.toContain("packageManager");
    },
    TIMEOUT,
  );

  it(
    "notes a missing OpenTUI native package for this host",
    async () => {
      put("node_modules/@opentui/core/package.json", "{}\n");
      expect(await sessionStart()).toContain(
        `node_modules/${NATIVE} is missing, so OpenTUI can't load its native library`,
      );
      put(`node_modules/${NATIVE}/package.json`, "{}\n");
      expect(await sessionStart()).not.toContain("OpenTUI");
    },
    TIMEOUT,
  );

  it(
    "counts warn and error lines in logs/orx.jsonl",
    async () => {
      put(
        "logs/orx.jsonl",
        [
          '{"time":"t","level":"info","msg":"command"}',
          '{"time":"t","level":"warn","msg":"Model call failed before any output; retrying"}',
          '{"time":"t","level":"error","msg":"defect"}',
          '{"time":"t","level":"fatal","msg":"boom"}',
          "",
        ].join("\n"),
      );
      expect(await sessionStart()).toContain("logs/orx.jsonl has 3 warn/error line(s): jq -c");
    },
    TIMEOUT,
  );

  it(
    "counts only the lines appended since the previous session started",
    async () => {
      const first = '{"time":"t","level":"error","msg":"old"}\n';
      put("logs/orx.jsonl", first);
      expect(await sessionStart()).toContain("logs/orx.jsonl has 1 warn/error line(s)");
      // Nothing new: the old error was reported last time.
      expect(await sessionStart()).not.toContain("orx.jsonl");

      appendFileSync(
        join(repo, "logs/orx.jsonl"),
        '{"time":"t","level":"warn","msg":"new"}\n{"time":"t","level":"info","msg":"command"}\n',
      );
      expect(await sessionStart()).toContain(
        `logs/orx.jsonl has 1 new warn/error line(s) since the last session started: tail -c +${first.length + 1} logs/orx.jsonl | jq -c`,
      );
      expect(await sessionStart()).not.toContain("orx.jsonl");
    },
    TIMEOUT,
  );

  it(
    "leaves a line still being written for the next session",
    async () => {
      put(
        "logs/orx.jsonl",
        '{"time":"t","level":"info","msg":"command"}\n{"time":"t","level":"err',
      );
      expect(await sessionStart()).not.toContain("orx.jsonl");
      appendFileSync(join(repo, "logs/orx.jsonl"), 'or","msg":"defect"}\n');
      expect(await sessionStart()).toContain("logs/orx.jsonl has 1 new warn/error line(s)");
    },
    TIMEOUT,
  );

  it(
    "starts over when the log was rotated or truncated",
    async () => {
      put("logs/orx.jsonl", '{"time":"t1","level":"error","msg":"old"}\n'.repeat(3));
      expect(await sessionStart()).toContain("has 3 warn/error line(s)");

      // Rotated (scripts/orx-dev.ts renames it to orx.prev.jsonl): a new file, even if it's longer.
      renameSync(join(repo, "logs/orx.jsonl"), join(repo, "logs/orx.prev.jsonl"));
      put("logs/orx.jsonl", '{"time":"t2","level":"warn","msg":"new"}\n'.repeat(4));
      expect(await sessionStart()).toContain("logs/orx.jsonl has 4 warn/error line(s): jq -c");

      // Truncated in place to something shorter.
      put("logs/orx.jsonl", '{"time":"t3","level":"warn","msg":"new"}\n');
      expect(await sessionStart()).toContain("logs/orx.jsonl has 1 warn/error line(s): jq -c");
    },
    TIMEOUT,
  );

  it(
    "keeps a separate offset per checkout",
    async () => {
      put("logs/orx.jsonl", '{"time":"t","level":"error","msg":"x"}\n');
      expect(await sessionStart()).toContain("has 1 warn/error line(s)");
      const other = makeGitRepo();
      try {
        other.put("logs/orx.jsonl", '{"time":"t","level":"error","msg":"x"}\n');
        const result = await runHook(
          "SessionStart",
          "session-start",
          { session_id: "s", hook_event_name: "SessionStart", source: "startup" },
          { env: { CLAUDE_PROJECT_DIR: other.dir, TMPDIR: tmp, ...GIT_ENV } },
        );
        expect(result.stdout).toContain("logs/orx.jsonl has 1 warn/error line(s)");
      } finally {
        other.cleanup();
      }
    },
    TIMEOUT,
  );

  it(
    "says nothing about a clean log",
    async () => {
      put("logs/orx.jsonl", '{"time":"t","level":"info","msg":"command"}\n');
      expect(await sessionStart()).not.toContain("orx.jsonl");
    },
    TIMEOUT,
  );

  describe("with the stub servers running from the checkout", () => {
    let stub: ChildProcess | undefined;
    afterEach(() => {
      stub?.kill();
      stub = undefined;
    });

    it(
      "says they are running and how to stop them",
      async () => {
        put("scripts/stub-server.ts", "setTimeout(() => {}, 60_000);\n");
        stub = spawn("bun", [join(repo, "scripts/stub-server.ts")], { stdio: "ignore" });
        const pid = stub.pid as number;
        // Wait until ps shows the process by its script name, which is what the hook looks for.
        await waitFor(() => {
          const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
          expect(ps.stdout).toContain("scripts/stub-server.ts");
        });
        put("logs/stub.pid", `${pid} 5190 5191\n`);
        expect(await sessionStart()).toContain(
          `The stub OpenRouter and releases servers are running (pid ${pid});`,
        );
      },
      TIMEOUT,
    );

    it(
      "ignores a stale pid file",
      async () => {
        put("logs/stub.pid", "999999\n");
        expect(await sessionStart()).not.toContain("stub");
      },
      TIMEOUT,
    );
  });
});

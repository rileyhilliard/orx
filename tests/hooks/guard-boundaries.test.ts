import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { denyReason, edit, makeFixture, REPO, runHook, write } from "../helpers/hooks";

const check = (relPath: string, content: string) =>
  runHook("PreToolUse", "guard-boundaries", write(`${REPO}/${relPath}`, content));

const PLATFORM = "imports Bun or OpenTUI outside src/bin.ts and src/tui/";
const BUN_GLOBAL = "uses the Bun global outside src/bin.ts and src/tui/";
const ENV = "reads process.env";
const CONSOLE = "calls console.*";
const ZOD = "imports zod or @effect/schema";
const TUI_EFFECT = "imports effect in a TUI component";
const STDOUT = "uses process.stdout";
const STDERR = "uses process.stderr";
const TUI_IMPORT = "statically imports src/tui/ from outside it";

describe.concurrent("guard-boundaries denies", () => {
  it.each([
    ["src/core/chat.ts", 'import { createCliRenderer } from "@opentui/core";', PLATFORM],
    ["src/services/Output.ts", 'import { BunStdio } from "@effect/platform-bun";', PLATFORM],
    [
      "src/services/Host.ts",
      'import { BunRuntime } from "@effect/platform-bun/BunRuntime";',
      PLATFORM,
    ],
    ["src/core/update.ts", 'import { $ } from "bun";', PLATFORM],
    ["src/core/stdin.ts", 'import { Database } from "bun:sqlite";', PLATFORM],
    ["src/commands/chat.ts", 'const m = await import("@opentui/react");', PLATFORM],
    ["src/cli.ts", '} from "@opentui/core";', PLATFORM],
    ["src/core/export.ts", "const f = Bun.file(path);", BUN_GLOBAL],
    ["src/services/ChatStore.ts", "const dir = process.env.ORX_DATA_DIR;", ENV],
    ["src/tui/app.tsx", 'const debug = process.env["DEBUG"];', ENV],
    ["src/core/models.ts", 'console.log("models", list);', CONSOLE],
    ["src/bin.ts", 'console.error("orx: failed");', CONSOLE],
    ["src/tui/app.tsx", "  console.warn(error);", CONSOLE],
    ["src/schemas/chat.ts", 'import { z } from "zod";', ZOD],
    ["src/schemas/chat.ts", 'import { Schema } from "@effect/schema";', ZOD],
    ["src/tui/app.tsx", 'import { Effect } from "effect";', TUI_EFFECT],
    ["src/tui/message-list.tsx", 'import { AiError } from "effect/unstable/ai";', TUI_EFFECT],
    ["src/services/Output.ts", "process.stdout.write(text);", STDOUT],
    ["src/logging.ts", "const tty = process.stdout.isTTY;", STDOUT],
    ["src/tui/app.tsx", 'process.stdout.write("\\x1b[?25h");', STDOUT],
    ["src/core/stdin.ts", 'process.stderr.write("reading stdin\\n");', STDERR],
    ["src/services/Output.ts", "const tty = process.stderr.isTTY;", STDERR],
    ["src/commands/chat.ts", 'import { launchChat } from "../tui/launch";', TUI_IMPORT],
    ["src/cli.ts", 'import type { ChatBridge } from "./tui/types";', TUI_IMPORT],
    ["src/core/chat.ts", '} from "~/tui/theme";', TUI_IMPORT],
    ["src/commands/doctor.ts", 'export { probeTui } from "../tui/launch";', TUI_IMPORT],
    ["src/main.ts", 'import "./tui";', TUI_IMPORT],
  ])("%s: %s", async (relPath, content, reason) => {
    expect(denyReason(await check(relPath, content))).toContain(reason);
  });

  it("checks an Edit's new_string", async () => {
    const payload = edit(
      `${REPO}/src/core/chat.ts`,
      'import { useKeyboard } from "@opentui/react";',
    );
    expect(denyReason(await runHook("PreToolUse", "guard-boundaries", payload))).toContain(
      PLATFORM,
    );
  });

  it("checks every edit in a MultiEdit", async () => {
    const payload = {
      tool_name: "Edit",
      tool_input: {
        file_path: `${REPO}/src/core/chat.ts`,
        edits: [{ new_string: "const a = 1;" }, { new_string: "console.log(a);" }],
      },
    };
    expect(denyReason(await runHook("PreToolUse", "guard-boundaries", payload))).toContain(CONSOLE);
  });

  it("names every problem in one write", async () => {
    const reason = denyReason(
      await check("src/core/chat.ts", 'import "bun";\nconsole.log(process.env.X);'),
    );
    expect(reason).toContain(PLATFORM);
    expect(reason).toContain(ENV);
    expect(reason).toContain(CONSOLE);
  });
});

describe.concurrent("guard-boundaries allows", () => {
  it.each([
    [
      "the entry point using Bun",
      "src/bin.ts",
      'import { BunRuntime } from "@effect/platform-bun";\nconst p = Bun.argv;',
    ],
    ["the entry point clearing DEV", "src/bin.ts", "delete process.env.DEV;"],
    [
      "the TUI importing OpenTUI",
      "src/tui/app.tsx",
      'import { useKeyboard } from "@opentui/react";',
    ],
    [
      "the TUI bridge importing effect",
      "src/tui/launch.tsx",
      'import { Effect, Stream } from "effect";',
    ],
    ["config reading the environment", "src/config.ts", "const env = process.env;"],
    [
      "Effect's Console service",
      "src/core/chat.ts",
      'import { Console } from "effect";\nyield* Console.log("x");',
    ],
    [
      "a comment mentioning process.env",
      "src/core/chat.ts",
      "// never read process.env here\nconst a = 1;",
    ],
    [
      "a JSDoc line mentioning console.log",
      "src/core/chat.ts",
      "/**\n * Not console.log(x): use Output.\n */",
    ],
    ["a trailing comment", "src/core/chat.ts", "const a = 1; // Bun.file would be wrong here"],
    ["a URL in a string", "src/core/chat.ts", 'const u = "http://127.0.0.1:9";'],
    ["an identifier ending in Bun", "src/core/chat.ts", "const notBun = myBun.x;"],
    [
      "a scoped @effect import in core",
      "src/core/chat.ts",
      'import { OpenRouterClient } from "@effect/ai-openrouter";',
    ],
    [
      "a platform-bun import in a test",
      "tests/config.test.ts",
      'import { BunServices } from "@effect/platform-bun";\nconsole.log(process.env.X);',
    ],
    [
      "a script using Bun",
      "scripts/build.ts",
      "await Bun.build({});\nconsole.log(process.env.CI);",
    ],
    ["a non-TypeScript file under src", "src/notes.md", "console.log(process.env.X)"],
    [
      "the entry point handing main its writers",
      "src/bin.ts",
      "stdout: (text) => process.stdout.write(text),\nstderr: (text) => process.stderr.write(text),",
    ],
    ["the terminal log sink writing stderr", "src/logging.ts", "process.stderr.write(line);"],
    ["config checking stderr for color", "src/config.ts", "() => process.stderr.isTTY === true"],
    [
      "a comment mentioning process.stdout",
      "src/core/chat.ts",
      "// never process.stdout.write here\nconst a = 1;",
    ],
    ["an identifier ending in process", "src/core/chat.ts", "const x = subprocess.stdout;"],
    [
      "a dynamic import of the TUI",
      "src/commands/chat.ts",
      'const { launchChat } = yield* Effect.promise(() => import("../tui/launch"));',
    ],
    ["the TUI loader", "src/commands/load-tui.ts", 'try: () => import("../tui/launch"),'],
    ["a TUI file importing another", "src/tui/app.tsx", 'import { theme } from "./theme";'],
    ["a path that only ends in tui", "src/commands/chat.ts", 'import { x } from "../core/tui";'],
    ["a directory named like tui", "src/commands/chat.ts", 'import { x } from "../tuix/a";'],
    ["a sibling module named tui", "src/commands/chat.ts", 'import { importTui } from "./tui";'],
    ["a tui directory under core", "src/core/chat.ts", 'import { x } from "./tui/x";'],
    ["a path that climbs out of src", "src/cli.ts", 'import { x } from "../tui/x";'],
    [
      "a comment naming a static TUI import",
      "src/commands/chat.ts",
      '// not: import { launchChat } from "../tui/launch";\nconst a = 1;',
    ],
  ])("%s", async (_, relPath, content) => {
    const result = await check(relPath, content);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("guard-boundaries in a worktree", () => {
  const fixture = makeFixture();
  const worktree = join(fixture.real, ".claude/worktrees/feat");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(fixture.real, "package.json"), "{}\n");
  writeFileSync(join(worktree, "package.json"), "{}\n");
  afterAll(fixture.cleanup);

  it("resolves src/ against the worktree's package root", async () => {
    const result = await runHook(
      "PreToolUse",
      "guard-boundaries",
      write(join(worktree, "src/core/chat.ts"), 'import "@opentui/core";'),
      { env: { CLAUDE_PROJECT_DIR: fixture.real } },
    );
    expect(denyReason(result)).toContain("src/core/chat.ts imports Bun or OpenTUI");
  });
});

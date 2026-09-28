import { describe, expect, it } from "bun:test";
import { bash, denyReason, runHook } from "../helpers/hooks";

const run = (command: string) => runHook("PreToolUse", "guard-commands", bash(command));

const VITEST = "vitest isn't used here. The test runner is bun test";
const PM = "bun is the package manager here";
const NOT_USED = "isn't used here.";
const RUNNER = "The test runner is bun test";

describe.concurrent("guard-commands denies", () => {
  it.each([
    ["vitest", VITEST],
    ["vitest run tests/config.test.ts", VITEST],
    ["bunx vitest run", VITEST],
    ["npx vitest", VITEST],
    ["./node_modules/.bin/vitest tests/hooks", VITEST],
    ["bun --bun vitest run", VITEST],
    ["bun x vitest", VITEST],
    ["bun run vitest", VITEST],
    ["cd src && vitest", VITEST],
    ["npm install", PM],
    ["npm i effect", PM],
    ["pnpm add effect", PM],
    ["yarn", PM],
    ["yarn add effect", PM],
    ["bun add zod", NOT_USED],
    ["bun add zod@^3.25", NOT_USED],
    ["bun add @effect/schema", NOT_USED],
    ["bun add -d @effect/platform", NOT_USED],
    ["bun add @effect/platform@0.90.0", NOT_USED],
    ["bun add -d vitest", RUNNER],
    ["bun add -d @effect/vitest@4.0.0-rc.117", RUNNER],
    ["bun add -d jest", RUNNER],
    ["bun add ink react", NOT_USED],
    ["bun install @modelcontextprotocol/sdk", NOT_USED],
    ["bun i x\ry zod", NOT_USED],
    // rr runs the quoted command on a remote host (or here, with --local).
    ['rr run "bunx vitest run"', VITEST],
    ["rr exec --local 'npm install'", PM],
    ['rr -q --no-phases run "vitest"', VITEST],
    ["rr exec --local=true 'npm install'", PM],
  ])("%j", async (command, reason) => {
    expect(denyReason(await run(command))).toContain(reason);
  });
});

describe.concurrent("guard-commands allows", () => {
  it.each([
    "bun test",
    "bun test ./tests/config.test.ts",
    "bun test tests/config.test.ts",
    'bun test ./tests/hooks -t "streams"',
    "bun test ./tests/tui/app.test.tsx",
    "bun test --timeout 20000 ./e2e",
    "bun run test",
    'bun run test ./tests/config.test.ts -t "streams"',
    "bun run test:tui",
    "bun run coverage",
    "bun run e2e",
    "bun add effect",
    "bun add @effect/platform-bun",
    "bun install --frozen-lockfile",
    "npm view effect version",
    "npx tsc --version",
    "bun --bun scripts/tool.ts",
    "git commit -m 'vitest is banned here'",
    // A test name holding the command it tests.
    'bun test ./tests/hooks -t "vitest"',
    "cat <<EOF\nvitest\nEOF",
    'rr run --host m1-mini "bun test ./tests/config.test.ts -t streams"',
    'rr test -- ./tests/hooks -t "vitest"',
  ])("%j", async (command) => {
    const result = await run(command);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});

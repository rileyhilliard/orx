import { describe, expect, it } from "vitest";
import { bash, denyReason, runHook } from "../helpers/hooks";

const run = (command: string) => runHook("PreToolUse", "guard-commands", bash(command));

const BUN_TEST = "bun test here runs only the TUI tests and e2e";
const VITEST_TUI = "tests/tui needs Bun";
const TEST_ARGS = "bun run test chains test:unit and test:tui";
const NODE = "vitest runs on Node in this project.";
const PM = "bun is the package manager here";
const NOT_USED = "isn't used here.";

describe.concurrent("guard-commands denies", () => {
  it.each([
    ["bun test", BUN_TEST],
    ["bun test tests/config.test.ts", BUN_TEST],
    ["bun test ./tests/config.test.ts", BUN_TEST],
    ["bun test -t picker", BUN_TEST],
    ["bun test ./tests/tui ./tests/hooks", BUN_TEST],
    ["cd src && bun test", BUN_TEST],
    ['bash -c "bun test"', BUN_TEST],
    ["bunx vitest run tests/tui", VITEST_TUI],
    ["vitest run tests/tui/app.test.tsx", VITEST_TUI],
    ["./node_modules/.bin/vitest tests/tui", VITEST_TUI],
    ["bun run test:unit tests/tui/app.test.tsx", VITEST_TUI],
    ["bun run test tests/config.test.ts", TEST_ARGS],
    ['bun run test -t "streams"', TEST_ARGS],
    ["bunx --bun vitest", NODE],
    ["bun --bun vitest run", NODE],
    ["bun run --bun test:unit", NODE],
    ["bun --bun run coverage", NODE],
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
    ["bun add ink react", NOT_USED],
    ["bun install @modelcontextprotocol/sdk", NOT_USED],
    ["bun i x\ry zod", NOT_USED],
    // rr runs the quoted command on a remote host (or here, with --local).
    ['rr run "bun test"', BUN_TEST],
    ['rr run --host m1-mini --cwd src "bun run test -t streams"', TEST_ARGS],
    ["rr exec --local 'npm install'", PM],
    ['rr -q --no-phases run "bun test"', BUN_TEST],
    ["rr exec --local=true 'npm install'", PM],
  ])("%j", async (command, reason) => {
    expect(denyReason(await run(command))).toContain(reason);
  });
});

describe.concurrent("guard-commands allows", () => {
  it.each([
    "bun run test",
    "bun run test:unit",
    'bun run test:unit tests/config.test.ts -t "streams"',
    "bun run test:unit tests/hooks",
    "bun run test:tui",
    "bun test ./tests/tui",
    "bun test ./tests/tui/app.test.tsx",
    'bun test ./tests/tui -t "picker/search"',
    "bun test --timeout 20000 ./e2e",
    "bun run e2e",
    "bunx vitest run tests/config.test.ts",
    "bun add effect",
    "bun add -d @effect/platform-node@4.0.0-rc.117",
    "bun add @effect/platform-bun",
    "bun install --frozen-lockfile",
    "npm view effect version",
    "npx tsc --version",
    "bun --bun scripts/tool.ts",
    "git commit -m 'bun test is banned here'",
    // A test name holding the command it tests.
    'bun run test:unit tests/hooks -t "bun test"',
    "cat <<EOF\nbun test\nEOF",
    'rr run --host m1-mini "bun run test:unit tests/config.test.ts -t streams"',
    'rr unit -- tests/hooks -t "bun test"',
  ])("%j", async (command) => {
    const result = await run(command);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});

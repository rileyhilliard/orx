// PreToolUse (Bash): deny commands that are wrong for this stack, with the fix.
//
//   bun test without ./tests/tui or ./e2e   bun's runner is only for the TUI tests and e2e; a bare
//                                           run also picks up the vitest files and fails on them
//   vitest on tests/tui                     those tests need Bun (OpenTUI); vitest runs on Node
//   bun run test <args>                     `test` chains test:unit and test:tui, so an argument
//                                           lands on the wrong runner
//   --bun on vitest                         vitest runs on Node here; --bun swaps in bun's runtime
//   installing zod, @effect/schema,         Effect Schema is the schema library; @effect/schema and
//   @effect/platform (v3), ink,             @effect/platform are Effect 3; the TUI is OpenTUI; MCP
//   @modelcontextprotocol/sdk               is Effect's McpServer
//   npm / pnpm / yarn installs              bun is the package manager (bun.lock)
//
// Commands are read the way bash runs them (see _shell.ts), so a quoted mention (a commit message,
// bun run test:unit -t "bun test") passes.
import { basename } from "node:path";
import { deny, readPayload, text } from "./_lib";
import { type Command, commands } from "./_shell";

const BUN_TEST_PATH = /^\.\/(tests\/tui|e2e)(\/|$)/;
const BUN_TEST_VALUE_FLAGS = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--preload",
  "--rerun-each",
  "--retry",
  "--seed",
  "--max-concurrency",
  "--reporter",
  "--reporter-outfile",
  "--coverage-reporter",
  "--coverage-dir",
]);
const TUI_TESTS = /(^|\/)tests\/tui(\/|$)/;
const VITEST_SCRIPTS = new Set(["test:unit", "test:watch", "coverage"]);
const INSTALL = new Set(["add", "install", "i", "a"]);

const BANNED: Record<string, string> = {
  zod: 'Schemas are Effect Schema (`import { Schema } from "effect"`). zod is only a transitive dependency; don\'t use it in app code.',
  "@effect/schema": '@effect/schema was folded into effect. Import Schema from "effect" instead.',
  "@effect/platform":
    "@effect/platform is Effect 3. In Effect 4, FileSystem, Path, Stdio, and HttpClient are in effect (effect/unstable/http for HTTP), and the runtimes are @effect/platform-bun (src/bin.ts) and @effect/platform-node (tests), pinned to the same version as effect.",
  ink: "The TUI is OpenTUI (@opentui/react), in src/tui/. Load the opentui skill.",
  "@modelcontextprotocol/sdk":
    "orx mcp is Effect's McpServer (effect/unstable/ai), serving the Toolkit in src/tools/mcp.ts.",
};

/** The package name in an install spec: `zod@3`, `@effect/platform@4.0.0` -> the name. */
function packageName(spec: string): string {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}

function reasonFor(cmd: Command): string | undefined {
  const [first = "", ...args] = cmd.argv;
  const name = basename(first);

  if (name === "npm" || name === "pnpm" || name === "yarn") {
    const sub = args[0];
    const installs =
      sub === undefined
        ? name === "yarn"
        : ["install", "i", "add", "ci", "remove", "uninstall", "rm", "update", "up"].includes(sub);
    if (installs) {
      return `bun is the package manager here (bun.lock). Use bun add / bun remove / bun install instead of ${name}; ${name} would write its own lockfile.`;
    }
    return undefined;
  }

  const vitest =
    name === "vitest" ||
    (["bun", "bunx", "npx"].includes(name) && args.some((a) => basename(a) === "vitest"));
  const vitestScript =
    name === "bun" &&
    args.includes("run") &&
    args.some((a) => VITEST_SCRIPTS.has(a) || a === "test");

  if (name === "bun" || name === "bunx") {
    if (args.includes("--bun") && (vitest || vitestScript)) {
      return "vitest runs on Node in this project. Drop --bun (bun run test:unit, or bunx vitest run).";
    }
  }
  if ((vitest || vitestScript) && args.some((a) => TUI_TESTS.test(a))) {
    return "tests/tui needs Bun (OpenTUI's native renderer), so vitest excludes it. Run bun run test:tui, or bun test ./tests/tui/<file> for one file.";
  }

  if (name !== "bun") return undefined;
  const [sub, ...rest] = args;

  if (sub === "test") {
    // Positional arguments, without the values of flags that take one (-t "<name>").
    const positional = rest.filter(
      (a, i) => !a.startsWith("-") && !BUN_TEST_VALUE_FLAGS.has(rest[i - 1] ?? ""),
    );
    const pathLike = positional.filter((a) => a.includes("/") || /\.[cm]?[jt]sx?$/.test(a));
    const scoped = pathLike.length > 0 && pathLike.every((a) => BUN_TEST_PATH.test(a));
    if (!scoped) {
      return "bun test here runs only the TUI tests and e2e (./tests/tui, ./e2e); everything else is vitest. Use bun run test:unit [file] [-t name] for vitest, bun run test:tui or bun test ./tests/tui/<file> for the TUI, bun run e2e for the binary (it builds first), or bun run test for both runners.";
    }
    return undefined;
  }

  const runIndex = args.indexOf("run");
  if (runIndex !== -1 && args[runIndex + 1] === "test" && args.length > runIndex + 2) {
    return "bun run test chains test:unit and test:tui, so arguments land on the wrong runner. Scope with bun run test:unit <file> [-t name] (vitest) or bun test ./tests/tui/<file> (TUI).";
  }

  if (INSTALL.has(sub ?? "")) {
    for (const arg of rest) {
      if (arg.startsWith("-")) continue;
      const reason = BANNED[packageName(arg)];
      if (reason) return `${packageName(arg)} isn't used here. ${reason}`;
    }
  }
  return undefined;
}

const command = text(readPayload()?.tool_input?.command);
const reason = command
  ? commands(command)
      .map(reasonFor)
      .find((r) => r !== undefined)
  : undefined;
if (reason) deny(`BLOCKED: ${reason}`);

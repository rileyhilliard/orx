// PreToolUse (Bash): deny commands that are wrong for this stack, with the fix.
//
//   vitest; installing vitest,              bun test is the only test runner (bun:test); vitest and
//   @effect/vitest, or jest                 @effect/vitest were removed
//   installing zod, @effect/schema,         Effect Schema is the schema library; @effect/schema and
//   @effect/platform (v3), ink,             @effect/platform are Effect 3; the TUI is OpenTUI; MCP
//   @modelcontextprotocol/sdk               is Effect's McpServer
//   npm / pnpm / yarn installs              bun is the package manager (bun.lock)
//
// Commands are read the way bash runs them (see _shell.ts), so a quoted mention (a commit message,
// bun test -t "vitest") passes.
import { basename } from "node:path";
import { deny, readPayload, text } from "./_lib";
import { type Command, commands } from "./_shell";

const INSTALL = new Set(["add", "install", "i", "a"]);
/** Flags of bun, bunx, and npx that take the next argument as their value. */
const VALUE_FLAGS = new Set(["--cwd", "--package", "-p", "--preload", "-r", "--config", "-c"]);

const RUNNER =
  "The test runner is bun test (import from bun:test): bun run test for everything under tests/, bun test ./tests/<file> [-t name] for one file, bun run e2e for the binary. An Effect test body runs with runTest from tests/helpers/effect.ts.";

const BANNED: Record<string, string> = {
  zod: 'Schemas are Effect Schema (`import { Schema } from "effect"`). zod is only a transitive dependency; don\'t use it in app code.',
  "@effect/schema": '@effect/schema was folded into effect. Import Schema from "effect" instead.',
  "@effect/platform":
    "@effect/platform is Effect 3. In Effect 4, FileSystem, Path, Stdio, and HttpClient are in effect (effect/unstable/http for HTTP), and the runtime is @effect/platform-bun, pinned to the same version as effect.",
  vitest: RUNNER,
  "@effect/vitest": RUNNER,
  jest: RUNNER,
  ink: "The TUI is OpenTUI (@opentui/react), in src/tui/. Load the opentui skill.",
  "@modelcontextprotocol/sdk":
    "An MCP server here is Effect's McpServer (effect/unstable/ai), not the MCP SDK.",
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
  }

  // The program bun, bunx, or npx would run: the first argument that isn't a flag, a flag's value
  // (`--cwd dir`), or bun's `x` or `run`, so `bun test -t vitest` isn't a vitest run.
  const runs = ["bun", "bunx", "npx"].includes(name)
    ? args.find(
        (a, i) =>
          !a.startsWith("-") &&
          !VALUE_FLAGS.has(args[i - 1] ?? "") &&
          !(name === "bun" && (a === "x" || a === "run")),
      )
    : undefined;
  const vitest =
    name === "vitest" || (runs !== undefined && packageName(basename(runs)) === "vitest");
  if (vitest) return `vitest isn't used here. ${RUNNER}`;

  if (name !== "bun") return undefined;
  const [sub, ...rest] = args;
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

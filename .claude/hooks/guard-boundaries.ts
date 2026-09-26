// PreToolUse (Edit|Write) on src/**/*.ts(x): deny code that breaks the platform boundary or the
// stdout contract. The same rules are in biome-plugins/boundaries.grit, which catches them at
// lint time; this hook stops them before the write, with the fix in the reason.
//
//   Bun, bun:*, @effect/platform-bun, @opentui/*, the Bun global
//                             only in src/bin.ts and src/tui/**: everything else runs under
//                             vitest on Node, through Effect's FileSystem, Path, Stdio, HttpClient
//   process.env               only in src/config.ts (Effect Config) and src/bin.ts (the DEV clear)
//   console.*                 nowhere in src/: results go through Output, diagnostics through
//                             Effect.log*; a stray stdout line corrupts `--json` and `orx mcp`
//   zod, @effect/schema       nowhere in src/: schemas are Effect Schema
//   effect in TUI components  only src/tui/launch.tsx imports effect; components get plain
//                             functions from the bridge
//
// Checked per line on the written text (a Write's content, an Edit's new_string), with `//`
// comments and JSDoc lines dropped first, so a comment that mentions process.env passes.
import { dirname, isAbsolute, resolve } from "node:path";
import { deny, findUp, projectRoot, readPayload, text, writtenText } from "./_lib";

const SPEC = `[ \\t]*\\(?[ \\t]*["']`;
const importOf = (pattern: string) =>
  new RegExp(`(^|[^\\w$.])(from|import)${SPEC}(${pattern})["']`);

const PLATFORM_IMPORT = importOf(
  "bun|bun:[^\"']*|@effect/platform-bun(/[^\"']*)?|@opentui/[^\"']*",
);
const BUN_GLOBAL = /(^|[^\w$.])Bun\.\w/;
const PROCESS_ENV = /(^|[^\w$.])process\.env\b/;
const CONSOLE = /(^|[^\w$.])console\.\w+[ \t]*\(/;
const ZOD_IMPORT = importOf("zod(/[^\"']*)?|@effect/schema(/[^\"']*)?");
const EFFECT_IMPORT = importOf("effect(/[^\"']*)?|@effect/[^\"']*");

/** The written text as lines, without `//` comments and JSDoc/block-comment lines. */
function codeLines(written: string): string[] {
  return written
    .split("\n")
    .filter((line) => !/^[ \t]*(\/\*|\*)/.test(line))
    .map((line) => line.replace(/(^|[ \t])\/\/.*$/, ""));
}

/** The path under src/ ("core/chat.ts"), relative to the nearest package root; else undefined. */
function srcPath(filePath: string): string | undefined {
  if (!/\.tsx?$/.test(filePath)) return undefined;
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot(), filePath);
  // The nearest package.json above the file: the repo, or a worktree under .claude/worktrees/.
  const pkg = findUp(dirname(abs), "package.json");
  if (!pkg) return undefined;
  const rel = abs.slice(pkg.length + 1);
  return rel.startsWith("src/") ? rel.slice(4) : undefined;
}

function reasonsFor(file: string, lines: string[]): string[] {
  const has = (re: RegExp) => lines.some((line) => re.test(line));
  const bunSide = file === "bin.ts" || file.startsWith("tui/");
  const reasons: string[] = [];
  if (!bunSide && has(PLATFORM_IMPORT)) {
    reasons.push(
      "imports Bun or OpenTUI outside src/bin.ts and src/tui/. This code runs under vitest on Node: use Effect's FileSystem, Path, Stdio, or HttpClient (BunServices is provided in src/bin.ts, NodeServices in tests). A command that needs the TUI dynamic-imports src/tui/launch.tsx (see src/commands/chat.ts).",
    );
  }
  if (!bunSide && has(BUN_GLOBAL)) {
    reasons.push(
      "uses the Bun global outside src/bin.ts and src/tui/. This code runs under vitest on Node: use the Effect platform services instead.",
    );
  }
  if (file !== "config.ts" && file !== "bin.ts" && has(PROCESS_ENV)) {
    reasons.push(
      "reads process.env. Only src/config.ts reads the environment (Effect Config, empty counts as unset): add the variable there, to .env.example, and to the README table, and take it from AppConfig.",
    );
  }
  if (has(CONSOLE)) {
    reasons.push(
      "calls console.*. stdout carries results only: write results through the Output service (src/services/Output.ts), notes for the person through Output.note, and diagnostics with Effect.logInfo/logWarning/logError. A stray stdout line breaks --json and corrupts orx mcp's JSON-RPC.",
    );
  }
  if (has(ZOD_IMPORT)) {
    reasons.push(
      'imports zod or @effect/schema. Schemas are Effect Schema (`import { Schema } from "effect"`), in src/schemas/.',
    );
  }
  if (file.startsWith("tui/") && file !== "tui/launch.tsx" && has(EFFECT_IMPORT)) {
    reasons.push(
      "imports effect in a TUI component. Only src/tui/launch.tsx imports effect: add what the component needs to ChatBridge (src/tui/types.ts) as a plain function, promise, or async iterable, built in launch.tsx.",
    );
  }
  return reasons;
}

const payload = readPayload();
const filePath = text(payload?.tool_input?.file_path);
const file = filePath ? srcPath(filePath) : undefined;
if (file !== undefined) {
  const written = writtenText(payload?.tool_input);
  const reasons = written ? reasonsFor(file, codeLines(written)) : [];
  if (reasons.length > 0) {
    deny(
      `BLOCKED: src/${file} ${reasons.join("\nAlso: it ")}\nSee .claude/rules/src/cli.md (Platform boundary, stdout contract).`,
    );
  }
}

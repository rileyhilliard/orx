// PreToolUse (Edit|Write) on src/**/*.ts(x): deny code that breaks the platform boundary or the
// stdout contract. The same rules are in biome-plugins/boundaries.grit, which catches them at
// lint time; this hook stops them before the write, with the fix in the reason.
//
//   Bun, bun:*, @effect/platform-bun, @opentui/*, the Bun global
//                             only in src/bin.ts and src/tui/**: everything else is platform-free
//                             and gets Effect's FileSystem, Path, Stdio, HttpClient from src/bin.ts
//   process.env               only in src/config.ts (Effect Config) and src/bin.ts (the DEV clear)
//   console.*                 nowhere in src/: results go through Output, diagnostics through
//                             Effect.log*; a stray stdout line corrupts `--json`
//   process.stdout            only in src/bin.ts, which hands main its stdout writer
//   process.stderr            only in src/bin.ts (main's stderr writer, the startup failure),
//                             src/logging.ts (the terminal log sink and its one "can't write the
//                             log file" warning, both below Effect's Stdio), and src/config.ts
//                             (process.stderr.isTTY decides the color default)
//   static import of src/tui/ from outside it: the TUI loads OpenTUI, so commands reach it only
//                             through the dynamic import in src/commands/load-tui.ts
//   zod, @effect/schema       nowhere in src/: schemas are Effect Schema
//   effect in TUI components  only src/tui/launch.tsx imports effect; components get plain
//                             functions from the bridge
//
// Checked per line on the written text (a Write's content, an Edit's new_string), with `//`
// comments and JSDoc lines dropped first, so a comment that mentions process.env passes.
import { dirname, isAbsolute, posix, resolve } from "node:path";
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
const PROCESS_STDOUT = /(^|[^\w$.])process\.stdout\b/;
const PROCESS_STDERR = /(^|[^\w$.])process\.stderr\b/;
const STDERR_FILES = new Set(["bin.ts", "logging.ts", "config.ts"]);
// A static import or re-export source (`from "x"`, `import "x"`), not a dynamic `import("x")`.
const STATIC_SOURCE = /(?:(?:^|[^\w$.])from|^[ \t]*import)[ \t]*["']([^"']+)["']/g;
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

/** Whether a static import in src/<file> resolves under src/tui/ (relative or `~/`). */
function importsTui(file: string, lines: string[]): boolean {
  return lines.some((line) =>
    [...line.matchAll(STATIC_SOURCE)].some(([, spec = ""]) => {
      let target: string;
      if (spec.startsWith("~/")) target = `src/${spec.slice(2)}`;
      else if (spec.startsWith(".")) target = posix.join(posix.dirname(`src/${file}`), spec);
      else return false;
      return target === "src/tui" || target.startsWith("src/tui/");
    }),
  );
}

function reasonsFor(file: string, lines: string[]): string[] {
  const has = (re: RegExp) => lines.some((line) => re.test(line));
  const bunSide = file === "bin.ts" || file.startsWith("tui/");
  const reasons: string[] = [];
  if (!bunSide && has(PLATFORM_IMPORT)) {
    reasons.push(
      "imports Bun or OpenTUI outside src/bin.ts and src/tui/. The rest of src/ is platform-free: use Effect's FileSystem, Path, Stdio, or HttpClient (BunServices is provided in src/bin.ts, and in tests by tests/helpers/cli.ts). A command that needs the TUI loads it with importTui (src/commands/load-tui.ts), a dynamic import of src/tui/launch.tsx.",
    );
  }
  if (!bunSide && has(BUN_GLOBAL)) {
    reasons.push(
      "uses the Bun global outside src/bin.ts and src/tui/. The rest of src/ is platform-free: use the Effect platform services instead.",
    );
  }
  if (file !== "config.ts" && file !== "bin.ts" && has(PROCESS_ENV)) {
    reasons.push(
      "reads process.env. Only src/config.ts reads the environment (Effect Config, empty counts as unset): add the variable there, to .env.example, and to the table in docs/reference.md, and take it from AppConfig.",
    );
  }
  if (has(CONSOLE)) {
    reasons.push(
      "calls console.*. stdout carries results only: write results through the Output service (src/services/Output.ts), notes for the person through Output.note, and diagnostics with Effect.logInfo/logWarning/logError. A stray stdout line breaks --json and pipes.",
    );
  }
  if (file !== "bin.ts" && has(PROCESS_STDOUT)) {
    reasons.push(
      "uses process.stdout. Only src/bin.ts touches it (it hands main the stdout writer): write results through the Output service (src/services/Output.ts). A stray stdout write breaks --json and pipes.",
    );
  }
  if (!STDERR_FILES.has(file) && has(PROCESS_STDERR)) {
    reasons.push(
      "uses process.stderr. Only src/bin.ts, src/logging.ts, and src/config.ts touch it: notes for the person go through Output.note, diagnostics through Effect.logInfo/logWarning/logError, and color on stderr comes from outputConfig in src/config.ts.",
    );
  }
  if (!file.startsWith("tui/") && importsTui(file, lines)) {
    reasons.push(
      "statically imports src/tui/ from outside it. That loads OpenTUI on every run and in every test file that imports it: load it with importTui from src/commands/load-tui.ts (a dynamic import), as src/commands/session.ts does, and put shared types outside src/tui/.",
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

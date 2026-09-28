import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";
import { GlobInput, ToolFailure } from "~/schemas";
import { mtimeOf } from "../services/file-state";
import { Workspace } from "../services/workspace";
import { GLOB_MAX_RESULTS } from "./limits";

export const Glob = Tool.make("glob", {
  description: [
    "Find files in the workspace by glob pattern (e.g. src/**/*.ts, **/package.json), matched",
    "against paths relative to the search directory. Skips .git and anything .gitignore excludes.",
    `Returns at most ${GLOB_MAX_RESULTS} paths, most recently modified first.`,
    "Use it instead of bash find or ls.",
  ].join(" "),
  parameters: GlobInput,
  success: Schema.String,
  failure: ToolFailure,
  failureMode: "return",
});

export interface WalkEntry {
  /** Absolute path, as found under the walk's start. */
  readonly path: string;
  /** The file's real path (different from `path` when a symlink is on the way). */
  readonly realPath: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface IgnoreRule {
  /** The directory holding the .gitignore. */
  readonly base: string;
  readonly rules: Ignore;
}

/**
 * Every file under `start` (a resolved path inside `root`), skipping `.git` and whatever the
 * `.gitignore` files from `root` down say. Symlinks are followed only when they resolve inside
 * `root` (files and directories alike), and each real directory is walked once. Unreadable
 * entries are skipped: a search lists what it can see.
 */
export const walkFiles = (root: string, start: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const within = (dir: string) => {
      const rel = path.relative(root, dir);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`));
    };

    const loadRules = (dir: string) =>
      fs
        .readFileString(path.join(dir, ".gitignore"))
        .pipe(
          Effect.option,
          Effect.map(Option.map((text): IgnoreRule => ({ base: dir, rules: ignore().add(text) }))),
        );
    const isIgnored = (rules: ReadonlyArray<IgnoreRule>, file: string, isDir: boolean) =>
      rules.some(({ base, rules }) =>
        rules.ignores(path.relative(base, file) + (isDir ? "/" : "")),
      );

    // The .gitignore files above `start`, from the root down, apply to it too.
    const inherited: Array<IgnoreRule> = [];
    for (let dir = start; dir !== root && within(dir); ) {
      dir = path.dirname(dir);
      const rule = yield* loadRules(dir);
      if (Option.isSome(rule)) inherited.unshift(rule.value);
    }

    const files: Array<WalkEntry> = [];
    const seen = new Set<string>();
    const visit = (
      dir: string,
      real: string,
      parentRules: ReadonlyArray<IgnoreRule>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (seen.has(real)) return;
        seen.add(real);
        const own = yield* loadRules(dir);
        const rules = Option.isSome(own) ? [...parentRules, own.value] : parentRules;
        const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
        for (const name of names.sort()) {
          if (name === ".git") continue;
          const file = path.join(dir, name);
          const info = yield* Effect.option(fs.stat(file));
          if (Option.isNone(info)) continue;
          if (info.value.type === "Directory") {
            if (isIgnored(rules, file, true)) continue;
            const realDir = yield* Effect.option(fs.realPath(file));
            if (Option.isSome(realDir) && within(realDir.value)) {
              yield* visit(file, realDir.value, rules);
            }
          } else if (info.value.type === "File" && !isIgnored(rules, file, false)) {
            const realFile = yield* Effect.option(fs.realPath(file));
            if (Option.isNone(realFile) || !within(realFile.value)) continue;
            files.push({
              path: file,
              realPath: realFile.value,
              mtimeMs: mtimeOf(info.value),
              size: Number(info.value.size),
            });
          }
        }
      });
    yield* visit(start, start, inherited);
    return files;
  });

/** A picomatch matcher; a pattern it rejects (it throws) is a ToolFailure the model can fix. */
export const compileGlob = (pattern: string, options: picomatch.PicomatchOptions) =>
  Effect.try({
    try: () => picomatch(pattern, options),
    catch: (error) =>
      new ToolFailure({
        message: `invalid glob: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

export const newestFirst = (a: WalkEntry, b: WalkEntry) =>
  b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path);

/** The `glob` tool: matching files, newest first, capped at GLOB_MAX_RESULTS. */
export const globFiles = ({ pattern, path: input }: GlobInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* Workspace;
    const start = yield* workspace.resolve(input ?? ".");
    const info = yield* fs
      .stat(start)
      .pipe(
        Effect.mapError(
          () => new ToolFailure({ message: `${workspace.display(start)}: no such directory` }),
        ),
      );
    if (info.type !== "Directory") {
      return yield* new ToolFailure({ message: `${workspace.display(start)} is not a directory` });
    }
    const isMatch = yield* compileGlob(pattern, { dot: true });
    const matches = (yield* walkFiles(workspace.root, start))
      .filter((entry) => isMatch(path.relative(start, entry.path)))
      .sort(newestFirst);
    if (matches.length === 0) return `No files match ${pattern}`;
    const listed = matches
      .slice(0, GLOB_MAX_RESULTS)
      .map((entry) => workspace.display(entry.path))
      .join("\n");
    return matches.length > GLOB_MAX_RESULTS
      ? `${listed}\n(showing ${GLOB_MAX_RESULTS} of ${matches.length} matches; narrow the pattern or path)`
      : listed;
  });

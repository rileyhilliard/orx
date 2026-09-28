import { Effect, Fiber, FileSystem, Option, Path, Schema, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import picomatch from "picomatch";
import { GrepInput, type GrepOutputMode, ToolFailure } from "~/schemas";
import { mtimeOf } from "../services/file-state";
import { isSecretPath, Workspace } from "../services/workspace";
import { newestFirst, type WalkEntry, walkFiles } from "./glob";
import {
  BINARY_SNIFF_BYTES,
  GREP_DEFAULT_HEAD_LIMIT,
  GREP_MAX_FILE_BYTES,
  GREP_MAX_LINE_CHARS,
} from "./limits";

export const Grep = Tool.make("grep", {
  description: [
    "Search file contents in the workspace with a regular expression (ripgrep syntax).",
    "output_mode files_with_matches (default) lists matching files, newest first; content shows",
    "matching lines as path:line:text; count shows matching lines per file. Filter files with",
    `glob (e.g. *.ts). At most ${GREP_DEFAULT_HEAD_LIMIT} results unless head_limit is set.`,
    "Skips .git, .gitignored files, and secret-shaped files (.env*, *.pem, *.key, id_*).",
    "Use it instead of bash grep or rg.",
  ].join(" "),
  parameters: GrepInput,
  success: Schema.String,
  failure: ToolFailure,
  failureMode: "return",
});

/** One `match` line of `rg --json`. A path or line that isn't UTF-8 comes as `bytes` and is skipped. */
const RgMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: Schema.Number,
  }),
});
const decodeRgLine = Schema.decodeUnknownOption(Schema.fromJsonString(RgMatch));

/** Whether `rg` runs here. The toolkit checks once per session. */
export const hasRipgrep = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.exitCode(ChildProcess.make("rg", ["--version"], { stdin: "ignore" })).pipe(
    Effect.map((code) => code === 0),
    Effect.orElseSucceed(() => false),
  );
});

interface MatchLine {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Matches from either search path. Content mode keeps up to `limit + 1` lines (the extra one
 * says there were more) and then stops the search; the other modes count every file.
 */
const makeCollector = (mode: GrepOutputMode, limit: number) => {
  const counts = new Map<string, number>();
  const lines: Array<MatchLine> = [];
  const full = () => mode === "content" && lines.length > limit;
  let secretsSkipped = 0;
  return {
    counts,
    lines,
    full,
    /** Secret-shaped files in scope whose contents weren't searched. */
    secretsSkipped: () => secretsSkipped,
    skipSecrets: (n: number) => {
      secretsSkipped += n;
    },
    /** Adds one matching line (absolute path); false once the search can stop. */
    add: (file: string, line: number, text: string): boolean => {
      counts.set(file, (counts.get(file) ?? 0) + 1);
      if (mode === "content") lines.push({ file, line, text: text.replace(/\r?\n$/, "") });
      return !full();
    },
  };
};
type Collector = ReturnType<typeof makeCollector>;

/** rg globs for the files `isSecretPath` flags: their contents are never searched. */
const SECRET_GLOBS = [".env*", "*.pem", "*.key", "id_*"];

const failed = (message: string) => new ToolFailure({ message: `grep failed: ${message}` });

const ripgrep = (root: string, target: string, input: GrepInput, collector: Collector) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    // --no-config: a RIPGREP_CONFIG_PATH file could add --follow and reach outside the root.
    // Without --follow, rg skips symlinks it meets while walking.
    const scope = ["--no-config", "--hidden", "--no-require-git", "--glob", "!.git"];
    if (input.glob !== undefined) scope.push("--glob", input.glob);
    const relative = path.relative(root, target) || ".";
    // The files in scope, to count the secret-shaped ones the search below leaves out.
    const listed = yield* Effect.forkChild(
      spawner
        .string(
          ChildProcess.make("rg", ["--files", ...scope, "--", relative], {
            cwd: root,
            stdin: "ignore",
          }),
        )
        .pipe(
          Effect.map(
            (out) => out.split("\n").filter((file) => file !== "" && isSecretPath(file)).length,
          ),
          Effect.orElseSucceed(() => 0),
        ),
    );
    // Later globs win in rg, so the exclusions come after the caller's glob.
    const args = ["--json", ...scope, ...SECRET_GLOBS.flatMap((glob) => ["--glob", `!${glob}`])];
    // Content mode stops early, so the order must not depend on rg's threads.
    if (input.output_mode === "content") args.push("--sort", "path");
    args.push("--regexp", input.pattern, "--", relative);
    const handle = yield* spawner.spawn(
      ChildProcess.make("rg", args, { cwd: root, stdin: "ignore" }),
    );
    const stderr = yield* Effect.forkChild(Stream.mkString(Stream.decodeText(handle.stderr)));
    yield* Stream.decodeText(handle.stdout).pipe(
      Stream.splitLines,
      Stream.takeWhile((json) =>
        Option.match(decodeRgLine(json), {
          onNone: () => true,
          onSome: ({ data }) =>
            collector.add(path.resolve(root, data.path.text), data.line_number, data.lines.text),
        }),
      ),
      Stream.runDrain,
    );
    collector.skipSecrets(yield* Fiber.join(listed));
    // Stopped early: closing the scope kills rg.
    if (collector.full()) return;
    // rg exits 1 for no matches and 2 for an error (a bad regex, an unreadable file).
    if ((yield* handle.exitCode) === 2 && collector.counts.size === 0) {
      const message = yield* Effect.orElseSucceed(Fiber.join(stderr), () => "");
      return yield* failed(message.trim() || "rg exited with an error");
    }
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error.message))),
  );

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);

/** The search when rg isn't installed: the glob walker, a JS RegExp, files up to 5 MB. */
const jsGrep = (root: string, target: string, input: GrepInput, collector: Collector) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const regex = yield* Effect.try({
      try: () => new RegExp(input.pattern),
      catch: (error) => failed(error instanceof Error ? error.message : String(error)),
    });
    const info = yield* Effect.option(fs.stat(target));
    const files: ReadonlyArray<WalkEntry> =
      Option.isSome(info) && info.value.type === "File"
        ? [{ path: target, realPath: target, mtimeMs: 0, size: Number(info.value.size) }]
        : yield* walkFiles(root, target);
    // Like rg --glob: a pattern without a slash matches the file name at any depth.
    const matchesGlob =
      input.glob === undefined
        ? () => true
        : picomatch(input.glob, { dot: true, basename: !input.glob.includes("/") });
    for (const file of files) {
      if (!matchesGlob(path.relative(target, file.path) || path.basename(file.path))) continue;
      // A symlink's name can hide what it points at (notes.txt -> .env).
      if (isSecretPath(file.path) || isSecretPath(file.realPath)) {
        collector.skipSecrets(1);
        continue;
      }
      if (file.size > GREP_MAX_FILE_BYTES) continue;
      const bytes = yield* Effect.option(fs.readFile(file.path));
      if (Option.isNone(bytes) || isBinary(bytes.value)) continue;
      const lines = new TextDecoder().decode(bytes.value).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (regex.test(line) && !collector.add(file.path, index + 1, line)) return;
      }
    }
  });

const cut = (text: string) =>
  text.length > GREP_MAX_LINE_CHARS ? `${text.slice(0, GREP_MAX_LINE_CHARS)} [line cut]` : text;

/**
 * The `grep` tool: rg when `useRipgrep`, else the JS fallback. Returns root-relative paths
 * (newest first), `path:line:text` lines, or `path:count`, capped at `head_limit` with a note.
 */
export const grepFiles = (input: GrepInput, useRipgrep: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* Workspace;
    const target = yield* workspace.resolve(input.path ?? ".");
    const shown = workspace.display;
    if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new ToolFailure({ message: `${shown(target)}: no such file or directory` });
    }
    const mode = input.output_mode ?? "files_with_matches";
    const limit = input.head_limit ?? GREP_DEFAULT_HEAD_LIMIT;
    const collector = makeCollector(mode, limit);
    // rg searches a file named on its command line whatever the globs say.
    const isFile = fs.stat(target).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    if (isSecretPath(target) && (yield* isFile)) collector.skipSecrets(1);
    else yield* (useRipgrep ? ripgrep : jsGrep)(workspace.root, target, input, collector);

    const skipped = collector.secretsSkipped();
    const secretNote =
      skipped === 0
        ? ""
        : `\n(${skipped} secret-shaped ${skipped === 1 ? "file" : "files"} (.env*, *.pem, *.key, id_*) not searched; read one by path if you need it)`;
    if (collector.counts.size === 0) return `No matches for ${input.pattern}${secretNote}`;
    if (mode === "content") {
      const body = collector.lines
        .slice(0, limit)
        .map(({ file, line, text }) => `${shown(file)}:${line}:${cut(text)}`)
        .join("\n");
      return collector.full()
        ? `${body}\n(showing the first ${limit} matching lines; narrow the search or raise head_limit)${secretNote}`
        : `${body}${secretNote}`;
    }
    const files = [...collector.counts.keys()];
    if (mode === "count") files.sort((a, b) => a.localeCompare(b));
    else {
      const stamped = yield* Effect.forEach(files, (file) =>
        fs.stat(file).pipe(
          Effect.map((info) => mtimeOf(info)),
          Effect.orElseSucceed(() => 0),
          Effect.map((mtimeMs): WalkEntry => ({ path: file, realPath: file, mtimeMs, size: 0 })),
        ),
      );
      files.splice(0, files.length, ...stamped.sort(newestFirst).map((entry) => entry.path));
    }
    const body = files
      .slice(0, limit)
      .map((file) =>
        mode === "count" ? `${shown(file)}:${collector.counts.get(file)}` : shown(file),
      )
      .join("\n");
    return files.length > limit
      ? `${body}\n(showing ${limit} of ${files.length} files; narrow the search or raise head_limit)${secretNote}`
      : `${body}${secretNote}`;
  });

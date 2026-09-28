import { Effect, FileSystem, Path, Schema, SchemaIssue } from "effect";
import { Paths } from "../config";
import { UnknownModel } from "../errors";
import { CommandFrontmatter } from "../schemas";
import { resolveToolModel } from "./models";

/**
 * Custom slash commands: saved prompts in `<root>/.orx/commands/**.md` (the workspace) and
 * `~/.config/orx/commands/**.md` (the user; `$XDG_CONFIG_HOME/orx` when that is set). A file in
 * a subdirectory is namespaced: `git/commit.md` is `/git:commit`. A workspace command wins a
 * name clash. Commands grant nothing: the expanded text is sent as an ordinary user message.
 *
 * This file also holds the Markdown-with-frontmatter reader that skills (skills.ts) share.
 */

export interface CustomCommand {
  readonly name: string;
  readonly description: string;
  /** The model for the turn this command sends, when its frontmatter sets one. */
  readonly model?: string;
  readonly body: string;
  /** The file it came from, for warnings. */
  readonly file: string;
}

/** What a loader found, plus what it skipped or thinks is wrong (already logged). */
export interface Loaded<A> {
  readonly items: ReadonlyArray<A>;
  readonly warnings: ReadonlyArray<string>;
}

const unquote = (value: string) => {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
};

/**
 * The frontmatter's `key: value` lines as strings. A small subset of YAML: quoted or bare scalars,
 * `>` and `|` blocks, and indented continuation lines. Anything else (lists, nested maps) is
 * skipped, which is fine because the schemas only read scalars and ignore unknown keys.
 */
const parseFields = (source: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  let current: { key: string; separator: string } | undefined;
  for (const line of source.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const field = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (field?.[1] !== undefined) {
      const key = field[1];
      const raw = (field[2] ?? "").trim();
      if (/^[>|][-+]?$/.test(raw)) {
        fields[key] = "";
        current = { key, separator: raw.startsWith("|") ? "\n" : " " };
      } else {
        fields[key] = unquote(raw);
        current = raw === "" ? undefined : { key, separator: " " };
      }
    } else if (/^\s/.test(line) && current !== undefined) {
      const previous = fields[current.key] ?? "";
      const next = line.trim();
      fields[current.key] = previous === "" ? next : `${previous}${current.separator}${next}`;
    } else {
      current = undefined;
    }
  }
  return fields;
};

/** Splits `---`-delimited frontmatter from the body. No frontmatter: every field is absent. */
export const parseMarkdown = (
  text: string,
): { readonly fields: Record<string, string>; readonly body: string } => {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { fields: {}, body: normalized.trim() };
  return { fields: parseFields(match[1] ?? ""), body: normalized.slice(match[0].length).trim() };
};

const formatIssue = SchemaIssue.makeFormatterDefault();

/** Decodes frontmatter fields with an open schema (unknown keys ignored); a failure is a message. */
export const decodeFrontmatter =
  <A>(schema: Schema.Decoder<A>) =>
  (fields: Record<string, string>, file: string) =>
    Schema.decodeUnknownEffect(schema)(fields).pipe(
      Effect.mapError((error) => `${file}: ${formatIssue(error.issue).replace(/\n\s*/g, " ")}`),
    );

/** The workspace's and the user's `.orx`-style directories, user first so the workspace wins. */
export const slashDirs = (root: string, name: "commands" | "skills") =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { configFile } = yield* Paths;
    return [
      path.join(path.dirname(configFile), name),
      path.join(path.resolve(root), ".orx", name),
    ] as const;
  });

/** A file's text, or a warning when it can't be read. */
export const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((error) => `Can't read ${file}: ${error.message}`));
  });

/** Whether a directory exists; a missing one is the normal case, not a warning. */
export const isDirectory = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.stat(dir).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  });

const segment = /^[\w.-]+$/;

/** The first line of the body, as a description when the frontmatter has none. */
const firstLine = (body: string) => {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  const trimmed = line.replace(/^#+\s*/, "").trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
};

const loadCommandDir = (dir: string, warnings: Array<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* isDirectory(dir))) return [];
    const entries = yield* fs.readDirectory(dir, { recursive: true }).pipe(
      Effect.catch((error) => {
        warnings.push(`Can't list ${dir}: ${error.message}`);
        return Effect.succeed([] as Array<string>);
      }),
    );
    const commands: Array<CustomCommand> = [];
    for (const entry of [...entries].sort()) {
      if (!entry.endsWith(".md")) continue;
      const file = path.join(dir, entry);
      const segments = entry.slice(0, -".md".length).split(/[\\/]/);
      if (!segments.every((s) => segment.test(s))) {
        warnings.push(`${file}: skipped; a command's path may use only letters, digits, ".-_"`);
        continue;
      }
      const loaded = yield* Effect.result(
        Effect.gen(function* () {
          const { fields, body } = parseMarkdown(yield* readText(file));
          const meta = yield* decodeFrontmatter(CommandFrontmatter)(fields, file);
          const command: CustomCommand = {
            name: segments.join(":"),
            description: meta.description?.trim() || firstLine(body),
            ...(meta.model !== undefined && meta.model.trim() !== ""
              ? { model: meta.model.trim() }
              : {}),
            body,
            file,
          };
          return command;
        }),
      );
      if (loaded._tag === "Success") commands.push(loaded.success);
      else warnings.push(loaded.failure);
    }
    return commands;
  });

/** Logs each warning once, where the loading happens. */
export const logWarnings = (warnings: ReadonlyArray<string>) =>
  Effect.forEach(warnings, (warning) => Effect.logWarning(warning), { discard: true });

/** Merges user-then-workspace lists by name (later wins), sorted by name. */
export const byName = <A extends { readonly name: string }>(
  lists: ReadonlyArray<ReadonlyArray<A>>,
): ReadonlyArray<A> => {
  const merged = new Map<string, A>();
  for (const list of lists) for (const item of list) merged.set(item.name, item);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/** Every custom command, the workspace's winning over the user's. */
export const loadCommands = (root: string) =>
  Effect.gen(function* () {
    const warnings: Array<string> = [];
    const lists: Array<ReadonlyArray<CustomCommand>> = [];
    for (const dir of yield* slashDirs(root, "commands")) {
      lists.push(yield* loadCommandDir(dir, warnings));
    }
    yield* logWarnings(warnings);
    return { items: byName(lists), warnings } satisfies Loaded<CustomCommand>;
  });

/**
 * `$ARGUMENTS` in the body is replaced by `args` (every occurrence); a body without it gets
 * `ARGUMENTS: <args>` appended when there are any.
 */
export const withArguments = (body: string, args: string): string => {
  if (body.includes("$ARGUMENTS")) return body.split("$ARGUMENTS").join(args.trim());
  return args.trim() === "" ? body : `${body}\n\nARGUMENTS: ${args.trim()}`;
};

/** The user message a command sends, and the model for that turn when it names one. */
export const expandCommand = (
  command: CustomCommand,
  args: string,
): { readonly text: string; readonly model?: string } => ({
  text: withArguments(command.body, args),
  ...(command.model !== undefined ? { model: command.model } : {}),
});

/**
 * `expandCommand` for the coding session, whose turns need tool calling: a command's `model:`
 * is checked the way the session's own model is (`resolveToolModel`), so an unknown model, or
 * one without tool calling, fails with UnknownModel naming the command's file.
 */
export const expandSessionCommand = (command: CustomCommand, args: string) =>
  Effect.gen(function* () {
    const expanded = expandCommand(command, args);
    if (command.model === undefined) return expanded;
    const fix = `Change the model: line in ${command.file}.`;
    const model = yield* resolveToolModel(command.model, fix).pipe(
      // An unknown id fails in resolveModel, whose message doesn't know about the file.
      Effect.catchTag("UnknownModel", (error) =>
        Effect.fail(
          error.message.endsWith(fix)
            ? error
            : new UnknownModel({ message: `${error.message} ${fix}`, model: error.model }),
        ),
      ),
    );
    return { ...expanded, model };
  });

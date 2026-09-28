import { Effect, FileSystem, Option, Path } from "effect";
import { Workspace } from "../services/workspace";
import { walkFiles } from "../tools/glob";
import { readFile } from "../tools/read";

/** A directory mention lists at most this many files. */
export const MENTION_DIR_MAX_ENTRIES = 500;

/**
 * The `@path` tokens in a message, in order and without repeats: an `@` at the start or after
 * whitespace, up to the next whitespace. `a@b.com` is not a mention.
 */
export const mentionTokens = (text: string): ReadonlyArray<string> => {
  const tokens: Array<string> = [];
  for (const match of text.matchAll(/(?<=^|\s)@(\S+)/g)) {
    const token = match[1];
    if (token !== undefined && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
};

/** Trailing punctuation a sentence can put after a path (`see @a.ts.`). */
const trimPunctuation = (token: string) => token.replace(/[.,;:!?)\]}'"`]+$/, "");

/**
 * Every file in the workspace, root-relative and sorted, plus each directory holding one (with
 * a trailing `/`), for the `@` picker. Skips `.git` and what `.gitignore` excludes.
 */
export const listWorkspaceFiles = Effect.gen(function* () {
  const workspace = yield* Workspace;
  const path = yield* Path.Path;
  const files = (yield* walkFiles(workspace.root, workspace.root)).map((entry) =>
    path.relative(workspace.root, entry.path).split(path.sep).join("/"),
  );
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  return [...files, ...dirs].sort();
});

type Resolved = { readonly path: string; readonly isDir: boolean };

/** The token as an existing file or directory inside the workspace, trying it as typed first. */
const resolveToken = (token: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* Workspace;
    for (const candidate of new Set([token, trimPunctuation(token)])) {
      if (candidate === "") continue;
      const path = yield* Effect.option(workspace.resolve(candidate));
      if (Option.isNone(path)) continue;
      const info = yield* Effect.option(fs.stat(path.value));
      if (Option.isNone(info)) continue;
      if (info.value.type === "Directory" || info.value.type === "File") {
        return Option.some<Resolved>({
          path: path.value,
          isDir: info.value.type === "Directory",
        });
      }
    }
    return Option.none<Resolved>();
  });

const block = (tag: "file" | "directory", path: string, body: string) =>
  `<${tag} path="${path}">\n${body}\n</${tag}>`;

const attachment = ({ path, isDir }: Resolved) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const pathApi = yield* Path.Path;
    const shown = workspace.display(path);
    if (isDir) {
      const label = shown === "." ? "./" : `${shown}/`;
      const files = (yield* walkFiles(workspace.root, path))
        .map((entry) => workspace.display(entry.path))
        .sort();
      if (files.length === 0) return block("directory", label, "(no files)");
      const listed = files.slice(0, MENTION_DIR_MAX_ENTRIES).join("\n");
      return block(
        "directory",
        label,
        files.length > MENTION_DIR_MAX_ENTRIES
          ? `${listed}\n(showing ${MENTION_DIR_MAX_ENTRIES} of ${files.length} files; use glob for the rest)`
          : listed,
      );
    }
    if (workspace.isSecretPath(pathApi.basename(path))) {
      return block(
        "file",
        shown,
        "(not attached: the name looks like a credentials file; read it only if the user asks)",
      );
    }
    // Through the read tool's implementation: numbered lines, the first 2000 with a note when
    // there are more, and the read recorded in FileState so edits can follow.
    const body = yield* readFile({ path }).pipe(
      Effect.catchTag("ToolFailure", (failure) => Effect.succeed(`(${failure.message})`)),
    );
    return block("file", shown, body);
  });

/**
 * The attachments for a message: a `<file>` block for each `@path` naming a file inside the
 * workspace and a `<directory>` listing for each directory, separated by blank lines, or `""`
 * when there are none. Tokens that don't resolve (outside the workspace, missing, or not meant
 * as paths) attach nothing. The message text itself is kept apart (`UserMessage.attachments`).
 */
export const mentionAttachments = (text: string) =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const blocks: Array<string> = [];
    for (const token of mentionTokens(text)) {
      const resolved = yield* resolveToken(token);
      if (Option.isNone(resolved) || seen.has(resolved.value.path)) continue;
      seen.add(resolved.value.path);
      blocks.push(yield* attachment(resolved.value));
    }
    return blocks.join("\n\n");
  });

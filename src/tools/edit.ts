import { Effect, FileSystem, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { EditInput, ToolFailure } from "~/schemas";
import { FileState } from "../services/file-state";
import { Workspace } from "../services/workspace";
import { freshnessFailure, permit } from "./permit";
import { unifiedDiff } from "./write";

export const Edit = Tool.make("edit", {
  description: [
    "Replace text in a file you have read: old_string must match the file exactly (whitespace",
    "included, without read's line-number prefix) and be unique unless replace_all is set.",
    "Returns the diff. Fails if the file changed since you read it; read it again then.",
  ].join(" "),
  parameters: EditInput,
  success: Schema.String,
  failure: ToolFailure,
  failureMode: "return",
});

/** A `read` line prefix: the line number right-aligned in 6 columns, then a tab. */
const LINE_PREFIX = /^ *\d+\t/;

/**
 * `text` without the `cat -n` prefixes a model copied from read's output, when every non-empty
 * line has one; otherwise unchanged.
 */
export const stripLineNumbers = (text: string) => {
  const lines = text.split("\n");
  const numbered = lines.filter((line) => line !== "");
  if (numbered.length === 0 || !numbered.every((line) => LINE_PREFIX.test(line))) return text;
  return lines.map((line) => line.replace(LINE_PREFIX, "")).join("\n");
};

const countOf = (text: string, search: string) => text.split(search).length - 1;

const indentOf = (line: string) => /^[ \t]*/.exec(line)?.[0] ?? "";

/** `lines` re-indented from `from` to `to`, applied to the leading indentation of each line. */
const reindent = (lines: ReadonlyArray<string>, from: string, to: string) =>
  lines.map((line) => {
    if (line.trim() === "") return line;
    if (to.startsWith(from)) return to.slice(from.length) + line;
    if (from.startsWith(to) && line.startsWith(from.slice(to.length))) {
      return line.slice(from.length - to.length);
    }
    return line.startsWith(from) ? to + line.slice(from.length) : line;
  });

export type Replacement =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

/**
 * `content` with `oldString` replaced by `newString` (all LF). Exact match first; with no
 * exact match, one fallback that compares lines with leading and trailing whitespace trimmed
 * and re-indents `newString` by the matched block's indentation. Zero matches, or several
 * without `replaceAll`, is an error with the count.
 */
export const replaceIn = (
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Replacement => {
  const exact = countOf(content, oldString);
  if (exact === 1 || (exact > 1 && replaceAll)) {
    return { ok: true, text: content.split(oldString).join(newString) };
  }
  if (exact > 1) {
    return {
      ok: false,
      message: `old_string matches ${exact} places; add surrounding lines to make it unique, or set replace_all`,
    };
  }

  const fileLines = content.split("\n");
  const oldLines = oldString.replace(/\n$/, "").split("\n");
  const newLines = newString.replace(/\n$/, "").split("\n");
  const key = (line: string) => line.trim();
  const starts: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    if (oldLines.every((line, j) => key(line) === key(fileLines[i + j] ?? ""))) {
      starts.push(i);
      i += oldLines.length - 1;
    }
  }
  if (starts.length === 0) {
    return {
      ok: false,
      message:
        "old_string not found (0 matches, also ignoring indentation); read the file again and copy the text exactly",
    };
  }
  if (starts.length > 1 && !replaceAll) {
    return {
      ok: false,
      message: `old_string matches ${starts.length} places (ignoring indentation); add surrounding lines to make it unique, or set replace_all`,
    };
  }
  const firstIndented = (lines: ReadonlyArray<string>) =>
    indentOf(lines.find((line) => line.trim() !== "") ?? "");
  const result = [...fileLines];
  for (const start of [...starts].reverse()) {
    const matched = fileLines.slice(start, start + oldLines.length);
    const replaced = reindent(newLines, firstIndented(oldLines), firstIndented(matched));
    result.splice(start, oldLines.length, ...(newString === "" ? [] : replaced));
  }
  return { ok: true, text: result.join("\n") };
};

/**
 * The `edit` tool. Holds the file's lock from the freshness check to recording the new
 * contents: match, diff, ask Permissions with the diff, check freshness again, write with the
 * file's own line endings. Returns the diff.
 */
export const editFile = (input: EditInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* Workspace;
    const fileState = yield* FileState;
    const path = yield* workspace.resolve(input.path);
    const shown = workspace.display(path);
    const failed = (message: string) => new ToolFailure({ message: `${shown}: ${message}` });

    return yield* fileState.withLock(path)(
      Effect.gen(function* () {
        const ensureFresh = Effect.gen(function* () {
          const freshness = yield* fileState.checkFresh(path);
          if (freshness !== "ok") return yield* freshnessFailure(shown, freshness);
        });
        yield* ensureFresh;
        const raw = yield* fs
          .readFileString(path)
          .pipe(Effect.mapError((e) => failed(e.reason._tag)));
        const crlf = raw.includes("\r\n");
        const before = crlf ? raw.replace(/\r\n/g, "\n") : raw;
        const lf = (text: string) => text.replace(/\r\n/g, "\n");
        let oldString = lf(input.old_string);
        let newString = lf(input.new_string);
        if (countOf(before, oldString) === 0) {
          oldString = stripLineNumbers(oldString);
          newString = stripLineNumbers(newString);
        }
        if (oldString === "")
          return yield* failed("old_string is empty; use write to create a file");
        if (oldString === newString) return yield* failed("old_string and new_string are the same");
        const replaced = replaceIn(before, oldString, newString, input.replace_all ?? false);
        if (!replaced.ok) return yield* failed(replaced.message);

        const diff = unifiedDiff(shown, before, replaced.text);
        yield* permit({ tool: "edit", summary: `Edit ${shown}`, diff, path: shown });
        yield* ensureFresh;

        const bytes = new TextEncoder().encode(
          crlf ? replaced.text.replace(/\n/g, "\r\n") : replaced.text,
        );
        yield* fs.writeFile(path, bytes).pipe(Effect.mapError((e) => failed(e.reason._tag)));
        yield* fileState.record(path, bytes).pipe(Effect.mapError((e) => failed(e.reason._tag)));
        return diff;
      }),
    );
  });

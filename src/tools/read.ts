import { Effect, FileSystem, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { ReadInput, ToolFailure } from "~/schemas";
import { FileState } from "../services/file-state";
import { Workspace } from "../services/workspace";
import { BINARY_SNIFF_BYTES, READ_DEFAULT_LINES, READ_MAX_LINE_CHARS } from "./limits";

export const Read = Tool.make("read", {
  description: [
    "Read a text file from the workspace. Returns numbered lines (line number, a tab, the line),",
    `at most ${READ_DEFAULT_LINES} lines from offset (1-based); pass offset and limit to page`,
    "through longer files. Lines over 2000 characters are cut. Read a file before editing it.",
  ].join(" "),
  parameters: ReadInput,
  success: Schema.String,
  failure: ToolFailure,
  failureMode: "return",
});

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);

/** `cat -n` style: the line number right-aligned in 6 columns, a tab, the line. */
const numbered = (line: string, number: number) => {
  const text =
    line.length > READ_MAX_LINE_CHARS
      ? `${line.slice(0, READ_MAX_LINE_CHARS)} [line cut at ${READ_MAX_LINE_CHARS} characters]`
      : line;
  return `${String(number).padStart(6)}\t${text}`;
};

/**
 * The `read` tool: a file's lines, numbered, with a note for an empty file, a binary file, an
 * offset past the end, or more lines left. Records what it read in FileState, so a later write
 * or edit can tell whether the file changed since.
 */
export const readFile = ({ path: input, offset = 1, limit = READ_DEFAULT_LINES }: ReadInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* Workspace;
    const fileState = yield* FileState;
    const path = yield* workspace.resolveReadable(input);
    const shown = workspace.display(path);
    if (workspace.isSecretPath(path)) {
      return yield* new ToolFailure({
        message: `${shown} looks like it holds credentials, so orx doesn't read it. Ask the user to share what you need from it.`,
      });
    }
    const failed = (message: string) => new ToolFailure({ message: `${shown}: ${message}` });
    const info = yield* fs
      .stat(path)
      .pipe(
        Effect.mapError((error) =>
          failed(error.reason._tag === "NotFound" ? "no such file" : error.reason._tag),
        ),
      );
    if (info.type === "Directory") return yield* failed("is a directory; use glob to list it");
    const bytes = yield* fs.readFile(path).pipe(Effect.mapError((e) => failed(e.reason._tag)));
    if (isBinary(bytes)) return `(${shown} is a binary file, ${bytes.length} bytes; not shown)`;
    yield* fileState.record(path, bytes).pipe(Effect.mapError((e) => failed(e.reason._tag)));
    if (bytes.length === 0) return `(${shown} is empty)`;

    const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    if (offset > lines.length) {
      return `(offset ${offset} is past the end of ${shown}, which has ${lines.length} lines)`;
    }
    const end = Math.min(lines.length, offset - 1 + limit);
    const body = lines
      .slice(offset - 1, end)
      .map((line, i) => numbered(line, offset + i))
      .join("\n");
    return end < lines.length
      ? `${body}\n(showing lines ${offset}-${end} of ${lines.length}; pass offset ${end + 1} to read more)`
      : body;
  });

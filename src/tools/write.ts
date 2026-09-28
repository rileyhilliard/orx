import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { Effect, FileSystem, Option, Path, type PlatformError, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { ToolFailure, WriteInput } from "~/schemas";
import { FileState } from "../services/file-state";
import { Workspace } from "../services/workspace";
import { WRITE_MAX_DIFF_CHARS } from "./limits";
import { ensureResolvesTo, freshnessFailure, permit, platformFailure, readUtf8 } from "./permit";

export const Write = Tool.make("write", {
  description: [
    "Create a file, or replace a whole file, in the workspace. Parent directories are created.",
    "An existing file must have been read first and be unchanged since. Prefer edit for changes",
    "to an existing file; use write for new files or complete rewrites.",
  ].join(" "),
  parameters: WriteInput,
  success: Schema.String,
  failure: ToolFailure,
  failureMode: "return",
});

/** A unified diff of `before` to `after`, headed with the file name, three lines of context. */
export const unifiedDiff = (shown: string, before: string, after: string) =>
  createTwoFilesPatch(shown, shown, before, after, undefined, undefined, {
    context: 3,
    headerOptions: FILE_HEADERS_ONLY,
  });

const BOM = "\uFEFF";

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

/**
 * The `write` tool. Returns a one-line summary, and for an overwrite the diff under it. Holds
 * the file's lock from the freshness check to recording the new
 * contents, asks Permissions with the diff, and checks again after the answer (the user may
 * have edited or created the file, or swapped in a symlink, while the panel was open). An
 * existing file's byte order mark is kept.
 */
export const writeFile = ({ path: input, content }: WriteInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const workspace = yield* Workspace;
    const fileState = yield* FileState;
    const path = yield* workspace.resolve(input);
    const shown = workspace.display(path);
    const failed = (message: string) => new ToolFailure({ message: `${shown}: ${message}` });
    const failedWith = (error: PlatformError.PlatformError) => platformFailure(shown, error);

    return yield* fileState.withLock(path)(
      Effect.gen(function* () {
        // Only NotFound means a new file; any other stat failure is reported, not guessed at.
        const info = yield* fs.stat(path).pipe(
          Effect.map(Option.some),
          Effect.catchIf(isNotFound, () => Effect.succeedNone),
          Effect.mapError(failedWith),
        );
        const exists = Option.isSome(info);
        if (exists && info.value.type === "Directory") return yield* failed("is a directory");
        const ensureFresh = Effect.gen(function* () {
          if (!exists) return;
          const freshness = yield* fileState.checkFresh(path);
          if (freshness !== "ok") return yield* freshnessFailure(shown, freshness);
        });
        yield* ensureFresh;
        const before = exists ? yield* readUtf8(path, shown) : "";
        const after = before.startsWith(BOM) && !content.startsWith(BOM) ? BOM + content : content;
        const diff = unifiedDiff(shown, before, after);
        yield* permit({
          tool: "write",
          summary: `${exists ? "Overwrite" : "Create"} ${shown}`,
          diff,
          path: shown,
        });
        yield* ensureResolvesTo(input, path, shown);
        yield* ensureFresh;
        const appeared = fs.stat(path).pipe(
          Effect.as(true),
          Effect.catchIf(isNotFound, () => Effect.succeed(false)),
          Effect.mapError(failedWith),
        );
        if (!exists && (yield* appeared)) {
          return yield* failed("was created since you started; read it, then write again");
        }

        const bytes = new TextEncoder().encode(after);
        yield* fs
          .makeDirectory(pathService.dirname(path), { recursive: true })
          .pipe(Effect.mapError(failedWith));
        yield* fs.writeFile(path, bytes).pipe(Effect.mapError(failedWith));
        yield* fileState.record(path, bytes).pipe(Effect.mapError(failedWith));
        const lines =
          content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
        // An overwrite returns its diff, as edit does, unless it would flood the context; a new
        // file's diff would only repeat the content the model just sent.
        if (!exists) return `Created ${shown} (${lines} lines)`;
        return diff.length > WRITE_MAX_DIFF_CHARS
          ? `Overwrote ${shown} (${lines} lines; the diff is too large to show)`
          : `Overwrote ${shown} (${lines} lines)\n${diff}`;
      }),
    );
  });

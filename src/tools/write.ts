import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { ToolFailure, WriteInput } from "~/schemas";
import { FileState } from "../services/file-state";
import { Workspace } from "../services/workspace";
import { ensureResolvesTo, freshnessFailure, permit, readUtf8 } from "./permit";

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

/**
 * The `write` tool. Holds the file's lock from the freshness check to recording the new
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

    return yield* fileState.withLock(path)(
      Effect.gen(function* () {
        const info = yield* Effect.option(fs.stat(path));
        const exists = Option.isSome(info);
        if (exists && info.value.type === "Directory") return yield* failed("is a directory");
        const ensureFresh = Effect.gen(function* () {
          if (!exists) return;
          const freshness = yield* fileState.checkFresh(path);
          if (freshness !== "ok") return yield* freshnessFailure(shown, freshness);
        });
        yield* ensureFresh;
        const before = exists ? yield* readUtf8(path, failed) : "";
        const after = before.startsWith(BOM) && !content.startsWith(BOM) ? BOM + content : content;
        yield* permit({
          tool: "write",
          summary: `${exists ? "Overwrite" : "Create"} ${shown}`,
          diff: unifiedDiff(shown, before, after),
          path: shown,
        });
        yield* ensureResolvesTo(input, path, shown);
        yield* ensureFresh;
        if (!exists && (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => true)))) {
          return yield* failed("was created since you started; read it, then write again");
        }

        const bytes = new TextEncoder().encode(after);
        yield* fs
          .makeDirectory(pathService.dirname(path), { recursive: true })
          .pipe(Effect.mapError((e) => failed(e.reason._tag)));
        yield* fs.writeFile(path, bytes).pipe(Effect.mapError((e) => failed(e.reason._tag)));
        yield* fileState.record(path, bytes).pipe(Effect.mapError((e) => failed(e.reason._tag)));
        const lines =
          content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
        return `${exists ? "Overwrote" : "Created"} ${shown} (${lines} lines)`;
      }),
    );
  });

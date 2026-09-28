import { Effect, FileSystem } from "effect";
import { ToolFailure } from "~/schemas";
import { type PermissionRequest, Permissions } from "../services/permissions";
import { Workspace } from "../services/workspace";

/** Asks Permissions; a denial becomes a ToolFailure (marked `denied`) the model reads. */
export const permit = (request: PermissionRequest) =>
  Effect.gen(function* () {
    const result = yield* (yield* Permissions).check(request);
    if (result !== "allow") {
      return yield* new ToolFailure({
        message: `${request.summary}: denied. ${result.deny}`,
        denied: true,
      });
    }
  });

/** What write and edit report back when a file changed after it was read. */
export const freshnessFailure = (shown: string, freshness: "not-read" | "stale") =>
  new ToolFailure({
    message:
      freshness === "not-read"
        ? `${shown}: read it first; write and edit only change files you have read`
        : `${shown} changed since you read it; read it again before changing it`,
  });

/**
 * After the approval wait, `input` must still resolve to `path`: a symlink swapped in while the
 * panel was open would otherwise send the approved write somewhere else.
 */
export const ensureResolvesTo = (input: string, path: string, shown: string) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const now = yield* workspace.resolve(input);
    if (now !== path) {
      return yield* new ToolFailure({
        message: `${shown} now leads to ${workspace.display(now)} (a symlink changed); try again`,
      });
    }
  });

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A file's text for write and edit. UTF-8 only: another encoding would be rewritten as mojibake.
 * A byte order mark stays in the text (U+FEFF), so encoding the text again writes it back.
 */
export const readUtf8 = (path: string, failed: (message: string) => ToolFailure) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(path).pipe(Effect.mapError((e) => failed(e.reason._tag)));
    return yield* Effect.try({
      try: () => utf8.decode(bytes),
      catch: () => failed("not UTF-8 text; write and edit only change UTF-8 files"),
    });
  });

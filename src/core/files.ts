import { Effect, FileSystem, type PlatformError } from "effect";
import { BadInput, PermissionDenied } from "../errors";

/**
 * Writes a file the user named (`export -o`, the TUI's export). A path the user can fix is a
 * tagged error, not a defect: permission denied exits 6, a missing directory (or any other
 * reason the path can't be written) exits 2.
 */
export const writeUserFile = (path: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(path, content)
      .pipe(
        Effect.mapError((error: PlatformError.PlatformError) =>
          error.reason._tag === "PermissionDenied"
            ? new PermissionDenied({ message: `Can't write ${path}: permission denied.` })
            : new BadInput({ message: `Can't write ${path}: ${error.reason._tag}.` }),
        ),
      );
  });

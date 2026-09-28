import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Option, type PlatformError } from "effect";

/** What a file looked like when the model last read it. */
export interface FileStamp {
  readonly mtimeMs: number;
  readonly size: number;
  /** sha256 of the contents, so a touch without a change doesn't count as stale. */
  readonly hash: string;
}

export type Freshness = "ok" | "not-read" | "stale";

export interface FileStateShape {
  /** Remember `path` as read with these contents (stats the file for mtime and size). */
  readonly record: (
    path: string,
    content: Uint8Array,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly get: (path: string) => Effect.Effect<Option.Option<FileStamp>>;
  /**
   * Whether `path` is unchanged since it was read: "not-read" when it never was, "stale" when
   * its contents differ now (or it's gone). Write and edit refuse anything but "ok".
   */
  readonly checkFresh: (path: string) => Effect.Effect<Freshness>;
}

const hashOf = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");

/** A stat's mtime in milliseconds (0 when the platform has none). */
export const mtimeOf = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });

const makeFileState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stamps = new Map<string, FileStamp>();

  return {
    record: (path, content) =>
      Effect.map(fs.stat(path), (info) => {
        stamps.set(path, {
          mtimeMs: mtimeOf(info),
          size: Number(info.size),
          hash: hashOf(content),
        });
      }),
    get: (path) => Effect.sync(() => Option.fromNullishOr(stamps.get(path))),
    checkFresh: (path) =>
      Effect.gen(function* () {
        const stamp = stamps.get(path);
        if (stamp === undefined) return "not-read";
        const info = yield* Effect.option(fs.stat(path));
        if (Option.isNone(info)) return "stale";
        if (mtimeOf(info.value) === stamp.mtimeMs && Number(info.value.size) === stamp.size)
          return "ok";
        const content = yield* Effect.option(fs.readFile(path));
        return Option.isSome(content) && hashOf(content.value) === stamp.hash ? "ok" : "stale";
      }),
  } satisfies FileStateShape;
});

/** Which files the model has read this session, and what they looked like then. */
export class FileState extends Context.Service<FileState, FileStateShape>()("orx/FileState") {
  /** Fresh, empty state per build: one per session (a resumed chat starts empty). */
  static readonly layer = Layer.effect(FileState, makeFileState);
}

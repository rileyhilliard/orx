import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Option, type PlatformError, Semaphore } from "effect";

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
  /**
   * Runs `effect` holding `path`'s lock, so parallel writes and edits to one file serialize
   * (diff, ask, recheck, write, record) instead of racing.
   */
  readonly withLock: (
    path: string,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Forgets every read, for a new chat: its model hasn't seen those files. The locks stay, so a
   * write still running from the last chat keeps its file.
   */
  readonly reset: Effect.Effect<void>;
}

const hashOf = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");

/** A stat's mtime in milliseconds (0 when the platform has none). */
export const mtimeOf = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });

const makeFileState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stamps = new Map<string, FileStamp>();
  const locks = new Map<string, Semaphore.Semaphore>();

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
        // Always the content: a same-size rewrite inside the mtime's resolution (whole
        // milliseconds on Bun) keeps the mtime and size, so they can't prove it unchanged.
        const content = yield* Effect.option(fs.readFile(path));
        return Option.isSome(content) && hashOf(content.value) === stamp.hash ? "ok" : "stale";
      }),
    withLock: (path) => (effect) => {
      let lock = locks.get(path);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(path, lock);
      }
      return Semaphore.withPermit(lock)(effect);
    },
    reset: Effect.sync(() => stamps.clear()),
  } satisfies FileStateShape;
});

/** Which files the model has read this session, and what they looked like then. */
export class FileState extends Context.Service<FileState, FileStateShape>()("orx/FileState") {
  /** Fresh, empty state per build: one per session (a resumed chat starts empty). */
  static readonly layer = Layer.effect(FileState, makeFileState);
}

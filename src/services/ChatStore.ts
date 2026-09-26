import { join } from "node:path";
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { type ChatId, StoredChat } from "~/schemas";
import { Paths } from "../config";

export interface ChatStoreShape {
  readonly get: (id: ChatId) => Effect.Effect<Option.Option<StoredChat>>;
  readonly save: (chat: StoredChat) => Effect.Effect<void>;
  /** Every saved chat, newest first. Unreadable files are skipped (and logged). */
  readonly list: Effect.Effect<ReadonlyArray<StoredChat>>;
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredChat));
const encode = Schema.encodeEffect(Schema.fromJsonString(StoredChat));

const newestFirst = (a: StoredChat, b: StoredChat) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * One JSON file per chat in `<data dir>/chats/`. Writes go to a temp file in the same
 * directory and are renamed over the old one, so Ctrl+C mid-write can't leave half a chat.
 * Two processes saving the same chat: the last write wins. A failed read or write is a
 * defect: it means the data dir is broken, and the log says which file.
 */
const makeFileStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = join((yield* Paths).dataDir, "chats");
  const fileFor = (id: ChatId) => join(dir, `${id}.json`);

  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.flatMap(decode),
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logWarning("Skipping an unreadable chat file", { file, error: String(error) }).pipe(
          Effect.as(Option.none<StoredChat>()),
        ),
      ),
    );

  return {
    get: (id) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(fileFor(id)))) return Option.none();
        return yield* read(fileFor(id));
      }).pipe(Effect.orDie),
    save: (chat) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true });
        const temp = `${fileFor(chat.id)}.${process.pid}.tmp`;
        yield* fs.writeFileString(temp, yield* encode(chat)).pipe(
          Effect.andThen(fs.rename(temp, fileFor(chat.id))),
          Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)),
        );
      }).pipe(Effect.orDie),
    list: Effect.gen(function* () {
      if (!(yield* fs.exists(dir))) return [];
      const names = (yield* fs.readDirectory(dir)).filter((name) => name.endsWith(".json"));
      const chats = yield* Effect.forEach(names, (name) => read(join(dir, name)));
      return chats.flatMap(Option.toArray).sort(newestFirst);
    }).pipe(Effect.orDie),
  } satisfies ChatStoreShape;
});

const makeMemoryStore = (chats: Map<string, StoredChat>): ChatStoreShape => ({
  get: (id) => Effect.sync(() => Option.fromNullishOr(chats.get(id))),
  save: (chat) =>
    Effect.sync(() => {
      chats.set(chat.id, structuredClone(chat));
    }),
  list: Effect.sync(() => [...chats.values()].sort(newestFirst)),
});

export class ChatStore extends Context.Service<ChatStore, ChatStoreShape>()("orx/ChatStore") {
  static readonly layer = Layer.effect(ChatStore, makeFileStore);
  /** Fresh in-memory state per build, for tests. */
  static readonly layerMemory = Layer.sync(ChatStore, () => makeMemoryStore(new Map()));
}

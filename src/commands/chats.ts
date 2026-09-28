import { Effect, Schema } from "effect";
import { Command } from "effect/unstable/cli";
import { StoredChat } from "~/schemas";
import { chatsTable } from "../core/format";
import { ChatStore } from "../services/ChatStore";
import { Output } from "../services/Output";
import { jsonFlag } from "./shared";

// Encoded, so a reply's model steps print as the JSON the chat file holds.
const encodeChats = Schema.encodeEffect(Schema.Array(StoredChat));

export const chats = Command.make("chats", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const list = yield* (yield* ChatStore).list;
    if (json) return yield* out.json(yield* Effect.orDie(encodeChats(list)));
    if (list.length === 0)
      return yield* out.note("No saved chats yet. `orx ask` or `orx` starts one.");
    yield* out.line(chatsTable(list));
  }),
).pipe(Command.withDescription("List saved chats, newest first"));

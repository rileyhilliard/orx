import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { chatsTable } from "../core/format";
import { ChatStore } from "../services/ChatStore";
import { Output } from "../services/Output";
import { jsonFlag } from "./shared";

export const chats = Command.make("chats", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const list = yield* (yield* ChatStore).list;
    if (json) return yield* out.json(list);
    if (list.length === 0)
      return yield* out.note("No saved chats yet. `orx ask` or `orx chat` starts one.");
    yield* out.line(chatsTable(list));
  }),
).pipe(Command.withDescription("List saved chats, newest first"));

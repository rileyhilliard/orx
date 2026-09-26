import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChatId } from "~/schemas";
import { loadChat } from "../core/chat";
import { chatToMarkdown } from "../core/export";
import { writeUserFile } from "../core/files";
import { decodeInput } from "../core/input";
import { Output } from "../services/Output";

const chatId = Argument.String("chat-id").pipe(Argument.withDescription("From `orx chats`"));
const outFile = Flag.String("output").pipe(
  Flag.withAlias("o"),
  Flag.withDescription("Write to this file instead of stdout"),
  Flag.optional,
);

export const exportChat = Command.make(
  "export",
  { chatId, output: outFile },
  ({ chatId, output }) =>
    Effect.gen(function* () {
      const id = yield* decodeInput(ChatId)(chatId);
      const markdown = chatToMarkdown(yield* loadChat(id));
      const out = yield* Output;
      if (Option.isNone(output)) return yield* out.write(markdown);
      yield* writeUserFile(output.value, markdown);
      yield* out.note(`Wrote ${output.value}`);
    }),
).pipe(Command.withDescription("Print a saved chat as Markdown"));

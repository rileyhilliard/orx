import { Effect, Option, Stdio } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChatId } from "~/schemas";
import { loadChat, newChat } from "../core/chat";
import { decodeInput } from "../core/input";
import { resolveModel } from "../core/models";
import { NotInteractive } from "../errors";
import { modelFlag, newChatId } from "./shared";

const resume = Flag.String("resume").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Continue a saved chat (an id from `orx chats`)"),
  Flag.optional,
);

/** The interactive chat. The TUI is imported only here, so nothing else loads OpenTUI. */
export const chat = Command.make("chat", { resume, model: modelFlag }, ({ resume, model }) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
      return yield* new NotInteractive({
        message:
          "orx chat needs a terminal. For pipes and scripts, use `orx ask` (with --json for NDJSON).",
      });
    }
    const requested = Option.getOrUndefined(model);
    const initial = Option.isSome(resume)
      ? yield* decodeInput(ChatId)(resume.value).pipe(Effect.flatMap(loadChat))
      : newChat(yield* newChatId, yield* resolveModel(requested));
    const start =
      requested && Option.isSome(resume)
        ? { ...initial, model: yield* resolveModel(requested) }
        : initial;
    const { launchChat } = yield* Effect.promise(() => import("../tui/launch"));
    yield* launchChat(start);
  }),
).pipe(
  Command.withDescription("Chat in the terminal UI (Ctrl+P model, Ctrl+E export, Ctrl+C quit)"),
);

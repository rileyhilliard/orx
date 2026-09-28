import { Effect, Option, Stdio } from "effect";
import { Flag } from "effect/unstable/cli";
import { ChatId } from "~/schemas";
import { loadChat, newChat } from "../core/chat";
import { decodeInput } from "../core/input";
import { resolveModel } from "../core/models";
import { prepareSession } from "../core/session";
import { NotInteractive } from "../errors";
import { importTui } from "./load-tui";
import { cwdFlag, modelFlag, newChatId } from "./shared";

const resume = Flag.String("resume").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Continue a saved chat (an id from `orx chats`)"),
  Flag.optional,
);

const skipPermissions = Flag.Boolean("dangerously-skip-permissions").pipe(
  Flag.withDescription(
    "Run every tool without asking. File tools stay in the workspace; bash does not",
  ),
  Flag.withDefault(false),
);

/** The flags of a bare `orx`, the coding session. */
export const sessionFlags = {
  resume,
  model: modelFlag,
  cwd: cwdFlag,
  dangerouslySkipPermissions: skipPermissions,
};

/**
 * Bare `orx`: the coding session in the terminal UI, working in the cwd (or --cwd). The TUI
 * is imported only here and in doctor, so nothing else loads OpenTUI.
 */
export const runSession = ({
  resume,
  model,
  cwd,
}: {
  readonly resume: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly dangerouslySkipPermissions: boolean;
}) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
      return yield* new NotInteractive({
        message:
          "orx needs a terminal. For pipes and scripts, use `orx ask` (with --json for NDJSON).",
      });
    }
    const session = yield* prepareSession(cwd);
    const requested = Option.getOrUndefined(model);
    const initial = Option.isSome(resume)
      ? yield* decodeInput(ChatId)(resume.value).pipe(Effect.flatMap(loadChat))
      : newChat(yield* newChatId, yield* resolveModel(requested));
    const start =
      requested && Option.isSome(resume)
        ? { ...initial, model: yield* resolveModel(requested) }
        : initial;
    const { launchChat } = yield* importTui;
    yield* launchChat(start, session).pipe(Effect.provide(session.layer));
  });

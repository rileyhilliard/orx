import { Effect, Option, Stdio } from "effect";
import { Flag } from "effect/unstable/cli";
import { ChatId, type StoredChat } from "~/schemas";
import { loadChat, newChat } from "../core/chat";
import { decodeInput } from "../core/input";
import { resolveToolModel } from "../core/models";
import { prepareSession } from "../core/session";
import { BadInput, NotInteractive } from "../errors";
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
  dangerouslySkipPermissions,
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
    const session = yield* prepareSession(cwd, {
      mode: dangerouslySkipPermissions ? "yolo" : "default",
      headless: false,
    });
    const requested = Option.getOrUndefined(model);
    const initial = Option.isSome(resume)
      ? yield* decodeInput(ChatId)(resume.value).pipe(Effect.flatMap(loadChat))
      : newChat(yield* newChatId, yield* resolveToolModel(requested));
    // A chat's history names files in the workspace it ran in; continuing it elsewhere would
    // point the model at paths that aren't there, or are different files. Refused rather than
    // noted: the TUI takes over the screen at once, so a note would go unread. An explicit
    // --cwd is the user choosing the workspace, so it is honored.
    if (Option.isNone(cwd) && initial.cwd !== undefined && initial.cwd !== session.root) {
      return yield* new BadInput({
        message: `Chat ${initial.id} ran in ${initial.cwd}, not here (${session.root}). Run orx there, or pass --cwd to choose the workspace (--cwd . continues it here).`,
      });
    }
    const start: StoredChat = {
      ...initial,
      cwd: session.root,
      ...(requested && Option.isSome(resume) ? { model: yield* resolveToolModel(requested) } : {}),
    };
    const { launchChat } = yield* importTui;
    yield* launchChat(start, session).pipe(Effect.provide(session.layer));
  });

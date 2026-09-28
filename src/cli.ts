import { Command } from "effect/unstable/cli";
import { ask } from "./commands/ask";
import { chats } from "./commands/chats";
import { doctor } from "./commands/doctor";
import { exportChat } from "./commands/export";
import { extract } from "./commands/extract";
import { mcp } from "./commands/mcp";
import { models } from "./commands/models";
import { runSession, sessionFlags } from "./commands/session";
import { update } from "./commands/update";

/** The command tree. Handlers live in src/commands/, one file each. */
export const cli = Command.make("orx", sessionFlags, runSession).pipe(
  Command.withDescription(
    "A coding agent on OpenRouter models. Bare `orx` starts a session in the current directory",
  ),
  Command.withSubcommands([ask, models, extract, chats, exportChat, mcp, update, doctor]),
);

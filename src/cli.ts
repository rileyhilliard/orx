import { Command } from "effect/unstable/cli";
import { ask } from "./commands/ask";
import { chat } from "./commands/chat";
import { chats } from "./commands/chats";
import { doctor } from "./commands/doctor";
import { exportChat } from "./commands/export";
import { extract } from "./commands/extract";
import { mcp } from "./commands/mcp";
import { models } from "./commands/models";
import { update } from "./commands/update";

/** The command tree. Handlers live in src/commands/, one file each. */
export const cli = Command.make("orx").pipe(
  Command.withDescription("Chat with OpenRouter models from the terminal, scripts, and agents"),
  Command.withSubcommands([ask, chat, models, extract, chats, exportChat, mcp, update, doctor]),
);

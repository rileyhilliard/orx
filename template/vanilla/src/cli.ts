import { Command } from "effect/unstable/cli";
import { ask } from "./commands/ask";
import { doctor } from "./commands/doctor";
import { ui } from "./commands/ui";
import { update } from "./commands/update";

/** The command tree. Handlers live in src/commands/, one file each. */
export const cli = Command.make("orx").pipe(
  Command.withDescription("A command-line tool"),
  Command.withSubcommands([ask, ui, update, doctor]),
);

import { Effect, Stdio } from "effect";
import { Command } from "effect/unstable/cli";
import { NotInteractive } from "../errors";
import { importTui } from "./load-tui";

/** The terminal UI. The TUI is imported only here and in doctor, so nothing else loads OpenTUI. */
export const ui = Command.make("ui", {}, () =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
      return yield* new NotInteractive({
        message: "orx ui needs a terminal. For pipes and scripts, use `orx ask`.",
      });
    }
    const { launchUi } = yield* importTui;
    yield* launchUi;
  }),
).pipe(Command.withDescription("Open the terminal UI (Ctrl+C quits)"));

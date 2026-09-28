import { Console, Effect, type Exit, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { cli } from "./cli";
import { defectOf, exitCodeForOutcome, type Outcome, outcomeOf } from "./errors";
import { VERSION } from "./version";

export interface MainIO {
  readonly argv: ReadonlyArray<string>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const subcommands: ReadonlyArray<string> = cli.subcommands.flatMap((group) =>
  group.commands.map((command) => command.name),
);

/**
 * One run of orx, to an exit code: parse argv, run the handler, then render the outcome. The
 * platform is provided by the caller (src/bin.ts, or tests/helpers/cli.ts with a captured Stdio),
 * so tests run this exact code. It never fails: every failure is an exit code and a message on stderr.
 */
export const main = ({ argv, stdout, stderr }: MainIO) => {
  const json = argv.includes("--json");

  // For the `command` log line: the subcommand and flag names, never argument or flag values.
  // Only tokens before `--` that look like a flag count; a prompt word like "- a list" or "-5"
  // doesn't. The subcommand can follow global flags (`orx --log-level info ask`).
  const end = argv.indexOf("--");
  const options = end === -1 ? argv : argv.slice(0, end);
  const command = options.find((arg) => subcommands.includes(arg)) ?? "orx";
  const flags = options.flatMap((arg) => {
    const name = /^(--?[A-Za-z][\w-]*)(=.*)?$/.exec(arg)?.[1];
    return name === undefined ? [] : [name];
  });

  // The CLI prints help, --version, and completions through Effect's Console. Help after a
  // usage error belongs on stderr and a plain --help on stdout, which isn't known until the
  // run ends, so that output is held and flushed by the outcome. The wizard is interactive
  // and prints as it goes.
  const held: string[] = [];
  const hold = (...args: ReadonlyArray<unknown>) => {
    held.push(`${args.map(String).join(" ")}\n`);
  };
  const holdingConsole: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: hold,
    error: hold,
  });

  // A usage error prints the error and a pointer to --help rather than the whole help page.
  const render = (outcome: Outcome) => {
    if (outcome.kind === "ok" || outcome.kind === "help") for (const text of held) stdout(text);
    if (outcome.kind === "usage" || outcome.kind === "failed" || outcome.kind === "defect") {
      if (json) return stderr(`${JSON.stringify({ error: outcome.body })}\n`);
      stderr(`orx: ${outcome.body.message}\n`);
      if (outcome.kind === "usage")
        stderr(`Run \`orx ${command === "orx" ? "" : `${command} `}--help\` for usage.\n`);
    }
  };

  return Effect.gen(function* () {
    const startedAt = performance.now();
    // Logged in onExit so a run interrupted by a signal still logs its line (exit 130).
    const logRun = (exit: Exit.Exit<unknown, unknown>) =>
      Effect.gen(function* () {
        const outcome = outcomeOf(exit);
        // Also a defect beside the typed error that decided the exit code.
        const defect = defectOf(exit);
        if (Option.isSome(defect)) yield* Effect.logError("defect", defect.value);
        yield* Effect.logInfo("command").pipe(
          Effect.annotateLogs({
            command,
            flags,
            exitCode: exitCodeForOutcome(outcome),
            durationMs: Math.round(performance.now() - startedAt),
            ...(outcome.kind === "failed" || outcome.kind === "usage"
              ? { errorTag: outcome.body.tag }
              : {}),
            ...(outcome.kind === "failed" && outcome.error._tag === "UpstreamUnavailable"
              ? { errorDetail: outcome.error.detail ?? null }
              : {}),
          }),
        );
      });
    const run = Command.runWith(cli, { version: VERSION, renderErrors: false })(argv);
    const exit = yield* (
      argv.includes("--wizard")
        ? run
        : run.pipe(Effect.provideService(Console.Console, holdingConsole))
    ).pipe(Effect.onExit(logRun), Effect.exit);
    const outcome = outcomeOf(exit);
    render(outcome);
    return exitCodeForOutcome(outcome);
  }).pipe(Effect.annotateLogs({ runId: crypto.randomUUID() }));
};

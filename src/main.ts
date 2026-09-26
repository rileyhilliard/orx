import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { cli } from "./cli";
import { exitCodeForOutcome, type Outcome, outcomeOf } from "./errors";
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
 * platform is provided by the caller (src/bin.ts under Bun, tests under Node), so vitest runs
 * this exact code. It never fails: every failure is an exit code and a message on stderr.
 */
export const main = ({ argv, stdout, stderr }: MainIO) => {
  const json = argv.includes("--json");

  // For the `command` log line: the subcommand and flag names, never argument or flag values.
  const first = argv[0];
  const command = first !== undefined && subcommands.includes(first) ? first : "orx";
  const flags = argv.filter((arg) => arg.startsWith("-")).map((arg) => arg.split("=", 1)[0]);

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
    const run = Command.runWith(cli, { version: VERSION, renderErrors: false })(argv);
    const exit = yield* (
      argv.includes("--wizard")
        ? run
        : run.pipe(Effect.provideService(Console.Console, holdingConsole))
    ).pipe(Effect.exit);
    const outcome = outcomeOf(exit);
    if (outcome.kind === "defect") yield* Effect.logError("defect", outcome.cause);
    render(outcome);
    const exitCode = exitCodeForOutcome(outcome);
    yield* Effect.logInfo("command").pipe(
      Effect.annotateLogs({
        command,
        flags,
        exitCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...(outcome.kind === "failed" || outcome.kind === "usage"
          ? { errorTag: outcome.body.tag }
          : {}),
      }),
    );
    return exitCode;
  }).pipe(Effect.annotateLogs({ runId: crypto.randomUUID() }));
};

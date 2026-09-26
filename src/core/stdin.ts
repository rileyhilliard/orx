import { Effect, Stdio, Stream } from "effect";

/**
 * Stdin as text when something is piped in (`echo hi | orx ask`), or undefined at a terminal,
 * so a command never waits on a keyboard it didn't ask for.
 */
export const readPipedStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) return undefined;
  const text = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie);
  return text.trim() === "" ? undefined : text;
});

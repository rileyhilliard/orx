import { Context, Effect, Layer, type PlatformError, type Sink, Stdio, Stream } from "effect";
import { outputConfig } from "../config";

export interface OutputShape {
  /** Writes text to stdout as is. */
  readonly write: (text: string) => Effect.Effect<void>;
  /** Writes one line of text. */
  readonly line: (text: string) => Effect.Effect<void>;
  /** Writes one JSON value as one line (NDJSON for streams, one object for `--json` results). */
  readonly json: (value: unknown) => Effect.Effect<void>;
  /**
   * A line for the person at the terminal, on stderr: usage after a reply, a tool call, a hint.
   * Not a log line (no level or time) and not a result, so pipes and --json never see it.
   */
  readonly note: (text: string) => Effect.Effect<void>;
  /** Whether stdout is a terminal (then human output may be styled). */
  readonly isTerminal: boolean;
  /** Whether stderr lines may use ANSI styling (a terminal, and NO_COLOR unset). */
  readonly color: boolean;
}

/**
 * The only thing in orx that writes to stdout. Results go here; logs, progress, and errors go
 * to stderr (the logger, and bin.ts for the final error), so `orx ... | jq` and `orx mcp` get
 * a clean stream. A closed pipe (`orx models | head -1`) ends the run instead of failing it.
 */
const make = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const isTerminal = yield* stdio.stdoutIsTerminal;
  const { color } = yield* outputConfig.pipe(Effect.orElseSucceed(() => ({ color: false })));
  const to =
    (sink: Sink.Sink<void, string | Uint8Array, never, PlatformError.PlatformError>) =>
    (text: string) =>
      Stream.make(text).pipe(
        Stream.run(sink),
        Effect.catch((error) =>
          String(error).includes("EPIPE") ? Effect.interrupt : Effect.die(error),
        ),
      );
  const write = to(stdio.stdout({ endOnDone: false }));
  const writeErr = to(stdio.stderr({ endOnDone: false }));
  return {
    write,
    line: (text: string) => write(`${text}\n`),
    json: (value: unknown) => write(`${JSON.stringify(value)}\n`),
    note: (text: string) => writeErr(`${text}\n`),
    isTerminal,
    color,
  } satisfies OutputShape;
});

export class Output extends Context.Service<Output, OutputShape>()("orx/Output") {
  static readonly layer = Layer.effect(Output, make);
}

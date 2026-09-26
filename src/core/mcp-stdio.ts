import { Duration, Effect, Schedule, Sink, Stdio, Stream } from "effect";

/** The JSON-RPC ids of the request lines in `text`, and the partial line left over. */
const scanIds = (
  buffer: string,
  text: string,
  ids: (id: unknown, line: Record<string, unknown>) => void,
) => {
  const lines = (buffer + text).split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const message = JSON.parse(line) as unknown;
      if (typeof message === "object" && message !== null && "id" in message) {
        ids(message.id, message as Record<string, unknown>);
      }
    } catch {
      // Not JSON: the RPC server reports it; nothing to track here.
    }
  }
  return rest;
};

/**
 * Stdio for `orx mcp` that keeps stdin "open" after it closes until every request read from
 * it has a response on stdout. Effect's stdio transport stops as soon as stdin ends, which
 * drops in-flight requests: `echo '<request>' | orx mcp` would print nothing.
 */
export const drainingStdio = (stdio: Stdio.Stdio): Stdio.Stdio => {
  const pending = new Set<string>();
  const decoder = new TextDecoder();
  let inBuffer = "";
  let outBuffer = "";
  const key = (id: unknown) => JSON.stringify(id);
  const text = (chunk: string | Uint8Array) =>
    typeof chunk === "string" ? chunk : decoder.decode(chunk);

  const drained = Effect.void.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(20)),
      until: () => pending.size === 0,
    }),
    Effect.asVoid,
  );

  return Stdio.make({
    args: stdio.args,
    stdinIsTerminal: stdio.stdinIsTerminal,
    stdoutIsTerminal: stdio.stdoutIsTerminal,
    stderr: (options) => stdio.stderr(options),
    stdout: (options) =>
      stdio.stdout(options).pipe(
        Sink.mapInput((chunk: string | Uint8Array) => {
          outBuffer = scanIds(outBuffer, text(chunk), (id, message) => {
            if ("result" in message || "error" in message) pending.delete(key(id));
          });
          return chunk;
        }),
      ),
    stdin: stdio.stdin.pipe(
      Stream.tap((chunk) =>
        Effect.sync(() => {
          inBuffer = scanIds(inBuffer, decoder.decode(chunk, { stream: true }), (id, message) => {
            if ("method" in message) pending.add(key(id));
          });
        }),
      ),
      Stream.concat(Stream.fromEffect(drained).pipe(Stream.drain)),
    ),
  });
};

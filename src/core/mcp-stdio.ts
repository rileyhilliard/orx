import { Duration, Effect, Schedule, Sink, Stdio, Stream } from "effect";

/** Calls `each` with every JSON-RPC message line in `text`; returns the partial line left over. */
const scanMessages = (
  buffer: string,
  text: string,
  each: (message: Record<string, unknown>) => void,
) => {
  const lines = (buffer + text).split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const message = JSON.parse(line) as unknown;
      if (typeof message === "object" && message !== null) {
        each(message as Record<string, unknown>);
      }
    } catch {
      // Not JSON: the RPC server reports it; nothing to track here.
    }
  }
  return rest;
};

/** How long `orx mcp` waits, after stdin closes, for answers to requests it already read. */
const DRAIN_LIMIT = Duration.seconds(30);

/**
 * Stdio for `orx mcp` that keeps stdin "open" after it closes until every request read from
 * it has a response on stdout. Effect's stdio transport stops as soon as stdin ends, which
 * drops in-flight requests: `echo '<request>' | orx mcp` would print nothing. A request the
 * client cancels (`notifications/cancelled`) stops counting, and the wait is capped, so a
 * request that never gets an answer can't keep orx running.
 */
export const drainingStdio = (stdio: Stdio.Stdio): Stdio.Stdio => {
  const pending = new Set<string>();
  // One decoder per direction: each keeps its own partial multi-byte character.
  const inDecoder = new TextDecoder();
  const outDecoder = new TextDecoder();
  let inBuffer = "";
  let outBuffer = "";
  const key = (id: unknown) => JSON.stringify(id);
  const text = (chunk: string | Uint8Array) =>
    typeof chunk === "string" ? chunk : outDecoder.decode(chunk, { stream: true });

  const drained = Effect.void.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(20)),
      until: () => pending.size === 0,
    }),
    Effect.timeoutOrElse({
      duration: DRAIN_LIMIT,
      orElse: () =>
        Effect.logWarning("orx mcp: stdin closed with requests still unanswered", {
          pending: pending.size,
        }),
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
          outBuffer = scanMessages(outBuffer, text(chunk), (message) => {
            if ("id" in message && ("result" in message || "error" in message)) {
              pending.delete(key(message.id));
            }
          });
          return chunk;
        }),
      ),
    stdin: stdio.stdin.pipe(
      Stream.tap((chunk) =>
        Effect.sync(() => {
          inBuffer = scanMessages(
            inBuffer,
            inDecoder.decode(chunk, { stream: true }),
            (message) => {
              if (message.method === "notifications/cancelled") {
                const params = message.params as { requestId?: unknown } | undefined;
                pending.delete(key(params?.requestId));
              } else if ("method" in message && "id" in message) {
                pending.add(key(message.id));
              }
            },
          );
        }),
      ),
      Stream.concat(Stream.fromEffect(drained).pipe(Stream.drain)),
    ),
  });
};

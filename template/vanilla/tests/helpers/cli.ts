import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import {
  ConfigProvider,
  Effect,
  Fiber,
  Layer,
  Logger,
  References,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { type LogRecord, toEntry, toRecord } from "~/logging";
import { main } from "~/main";
import { AppLayer } from "~/runtime";
import { TuiLoader } from "~/commands/load-tui";
import { Host, type HostShape } from "~/services/Host";
import { UNREACHABLE } from "../isolation";

export const TEST_DEFAULT_MODEL = "openai/gpt-test";

export interface RunOptions {
  /** Env-style config, parsed by the real config. Merged over a test key and unreachable URLs. */
  readonly env?: Record<string, string>;
  /** Piped stdin. Omitted: stdin is a terminal with nothing on it. */
  readonly stdin?: string;
  /** Whether stdout is a terminal (default false, like a pipe). */
  readonly stdoutIsTerminal?: boolean;
  readonly host?: Partial<HostShape>;
  /**
   * The terminal UI: by default it can't load (TuiUnavailable), so a run never starts a
   * renderer inside the test process; "real" loads it, for `doctor --tui`'s probe.
   */
  readonly tui?: "unavailable" | "real";
  /** A directory for config, data, and HOME. Defaults to a fresh temp dir per run. */
  readonly root?: string;
  /** stdout's reader has gone away: every write fails with EPIPE, as after `| head -1`. */
  readonly stdoutClosed?: boolean;
  /** Interrupt the run after this long, as SIGINT does; the exit code is then 130. */
  readonly interruptAfterMs?: number;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every log record, debug and up. */
  readonly logs: ReadonlyArray<LogRecord>;
  /** The root used for config, data, and HOME (reuse it to see saved files). */
  readonly root: string;
}

export const tempRoot = () => mkdtempSync(join(tmpdir(), "orx-run-"));

/**
 * Runs orx exactly as src/bin.ts does (the same `main`, AppLayer, and BunServices), with stdin,
 * stdout, stderr, and logs captured. The model and releases are whatever OPENROUTER_BASE_URL
 * and ORX_RELEASES_URL point at: a stub, or (by default) nothing reachable.
 */
export const runCli = async (
  argv: ReadonlyArray<string>,
  options: RunOptions = {},
): Promise<RunResult> => {
  const root = options.root ?? tempRoot();
  const env = {
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: TEST_DEFAULT_MODEL,
    OPENROUTER_BASE_URL: `${UNREACHABLE}/api/v1`,
    ORX_RELEASES_URL: UNREACHABLE,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    ORX_DATA_DIR: join(root, "data"),
    NO_COLOR: "1",
    ...options.env,
  };
  let stdout = "";
  let stderr = "";
  const logs: LogRecord[] = [];
  const decoder = new TextDecoder();
  const text = (chunk: string | Uint8Array) =>
    typeof chunk === "string" ? chunk : decoder.decode(chunk);

  const collect = (append: (t: string) => void) =>
    // biome-ignore lint/suspicious/useIterableCallbackReturn: Effect's Sink.forEach takes an effect per element
    Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => append(text(chunk))));

  const stdio = Stdio.layerTest({
    args: Effect.succeed(argv),
    stdout: () =>
      options.stdoutClosed
        ? (Sink.fail(new Error("write EPIPE")) as unknown as ReturnType<typeof collect>)
        : collect((t) => {
            stdout += t;
          }),
    stderr: () =>
      collect((t) => {
        stderr += t;
      }),
    stdin:
      options.stdin === undefined
        ? Stream.empty
        : Stream.make(new TextEncoder().encode(options.stdin)),
    stdinIsTerminal: Effect.succeed(options.stdin === undefined),
    stdoutIsTerminal: Effect.succeed(options.stdoutIsTerminal ?? false),
  });
  const platform = Layer.mergeAll(
    Layer.merge(BunServices.layer, stdio),
    FetchHttpClient.layer,
    Host.layer({
      execPath: join(root, "bin", "orx"),
      compiled: false,
      platform: "linux",
      arch: "x64",
      ...options.host,
    }),
    options.tui === "real"
      ? TuiLoader.layer
      : TuiLoader.layerUnavailable("The terminal UI couldn't load: runCli runs without one."),
  );
  const logger = Layer.mergeAll(
    Logger.layer([
      Logger.make((entry) => {
        logs.push(toRecord(toEntry(entry)));
      }),
    ]),
    Layer.succeed(References.MinimumLogLevel, "Debug"),
  );

  const program = main({
    argv,
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  }).pipe(
    Effect.provide(AppLayer.pipe(Layer.provideMerge(platform))),
    Effect.provide(logger),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  const { interruptAfterMs } = options;
  // Interrupting stands in for SIGINT: runMain interrupts the main fiber, and bin.ts maps an
  // interrupted run to 130.
  const exitCode = await Effect.runPromise(
    interruptAfterMs === undefined
      ? program
      : Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(program);
          yield* Effect.sleep(interruptAfterMs);
          yield* Fiber.interrupt(fiber);
          return 130;
        }),
  );
  return { exitCode, stdout, stderr, logs, root };
};

/** stdout as NDJSON. */
export const ndjson = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

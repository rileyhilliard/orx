import { Duration, Effect, Option, Schema, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { BashInput, ToolFailure } from "~/schemas";
import { agentShellEnv } from "../config";
import { Workspace } from "../services/workspace";
import { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_OUTPUT_CHARS, BASH_MAX_TIMEOUT_MS } from "./limits";
import { permit } from "./permit";

export const Bash = Tool.make("bash", {
  description: [
    "Run a command with /bin/bash -c in the workspace root. Each call is a fresh shell: cd and",
    "exported variables don't carry over. Stdin is closed, so interactive commands fail. Returns",
    `stdout and stderr merged (the middle is cut past ${BASH_MAX_OUTPUT_CHARS} characters) and`,
    `the exit code. Killed after timeout_ms (default ${BASH_DEFAULT_TIMEOUT_MS / 1000} s, max`,
    `${BASH_MAX_TIMEOUT_MS / 1000} s). Use read, glob, and grep rather than cat, find, and grep.`,
  ].join(" "),
  parameters: BashInput,
  success: Schema.String,
  failure: ToolFailure,
  failureMode: "return",
});

/**
 * Collects output, keeping the first and last `max / 2` characters and counting what's cut,
 * so a command that prints megabytes doesn't hold them all.
 */
export const makeOutputBuffer = (max = BASH_MAX_OUTPUT_CHARS) => {
  const half = Math.floor(max / 2);
  let head = "";
  let tail = "";
  let cut = 0;
  return {
    add: (chunk: string) => {
      if (head.length < half) {
        const room = half - head.length;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      if (chunk === "") return;
      tail += chunk;
      if (tail.length > half) {
        cut += tail.length - half;
        tail = tail.slice(tail.length - half);
      }
    },
    text: () => (cut === 0 ? head + tail : `${head}\n[... ${cut} characters cut ...]\n${tail}`),
  };
};

/**
 * The `bash` tool: asks Permissions, then runs the command in the workspace root with the
 * scrubbed env and stdin closed. The exit code is part of the result, not a failure; a timeout
 * is a failure with the output so far. Interrupting the call (or the timeout) closes the scope,
 * which kills the command's process group.
 */
export const runBash = ({ command, timeout_ms, description }: BashInput) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const workspace = yield* Workspace;
    const summary = description === undefined ? command : `${command}  (${description})`;
    yield* permit({ tool: "bash", summary, command });

    const timeoutMs = Math.min(timeout_ms ?? BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS);
    const output = makeOutputBuffer();
    const run = Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("/bin/bash", ["-c", command], {
          cwd: workspace.root,
          env: agentShellEnv(),
          extendEnv: false,
          stdin: "ignore",
          forceKillAfter: "2 seconds",
        }),
      );
      yield* Stream.decodeText(handle.all).pipe(
        Stream.runForEach((chunk) => Effect.sync(() => output.add(chunk))),
      );
      return yield* handle.exitCode;
    }).pipe(Effect.scoped);

    const exit = yield* run.pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.mapError((error) => new ToolFailure({ message: `bash failed: ${error.message}` })),
    );
    const text = output.text().replace(/\n$/, "");
    const body = text === "" ? "(no output)" : text;
    if (Option.isNone(exit)) {
      return yield* new ToolFailure({
        message: `${body}\n(timed out after ${timeoutMs / 1000} s; the command was killed. Pass a larger timeout_ms (max ${BASH_MAX_TIMEOUT_MS}), or avoid starting servers or background processes that keep output open)`,
      });
    }
    return `${body}\n(exit code ${exit.value})`;
  });

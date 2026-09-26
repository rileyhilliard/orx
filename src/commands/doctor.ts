import { Effect, FileSystem, Option, Stdio } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { loadConfig, Paths } from "../config";
import type { TuiUnavailable } from "../errors";
import { Host } from "../services/Host";
import { Output } from "../services/Output";
import { VERSION } from "../version";
import { importTui } from "./load-tui";
import { jsonFlag } from "./shared";

const tui = Flag.Boolean("tui").pipe(
  Flag.withDescription("Also load OpenTUI's native library (and open a renderer at a terminal)"),
  Flag.withDefault(false),
);

/**
 * What an agent or a bug report needs to know about this install. Never fails on bad config
 * (it reports it), and never prints the key. With --tui, exits 3 if the TUI can't load.
 */
export const doctor = Command.make("doctor", { tui, json: jsonFlag }, ({ tui, json }) =>
  Effect.gen(function* () {
    const out = yield* Output;
    const host = yield* Host;
    const paths = yield* Paths;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* loadConfig.pipe(Effect.result);
    const configFileExists = yield* fs
      .exists(paths.configFile)
      .pipe(Effect.orElseSucceed(() => false));
    const report = {
      version: VERSION,
      platform: `${host.platform}-${host.arch}`,
      compiled: host.compiled,
      execPath: host.execPath,
      configFile: paths.configFile,
      configFileExists,
      configError: config._tag === "Failure" ? config.failure.message : null,
      apiKey:
        config._tag === "Success"
          ? Option.match(config.success.apiKey, { onNone: () => "unset", onSome: () => "set" })
          : "unknown",
      defaultModel: config._tag === "Success" ? config.success.defaultModel : null,
      dataDir: paths.dataDir,
      logFile: Option.getOrNull(paths.logFile),
      tui: null as null | { nativeLib: boolean; renderer: boolean | null; error: string | null },
    };
    let tuiFailure: TuiUnavailable | undefined;
    if (tui) {
      const stdio = yield* Stdio.Stdio;
      const interactive = (yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal);
      const probe = yield* importTui.pipe(
        Effect.flatMap(({ probeTui }) => probeTui(interactive)),
        Effect.result,
      );
      if (probe._tag === "Success") {
        report.tui = {
          nativeLib: probe.success.nativeLib,
          renderer: Option.getOrNull(probe.success.renderer),
          error: null,
        };
      } else {
        // Reported, then failed below, so a bug report has both the report and exit 3.
        report.tui = { nativeLib: false, renderer: null, error: probe.failure.message };
        tuiFailure = probe.failure;
      }
    }
    if (json) yield* out.json(report);
    else {
      for (const [key, value] of Object.entries(report)) {
        if (value === null) continue;
        yield* out.line(
          `${key.padEnd(17)} ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
        );
      }
    }
    if (tuiFailure) return yield* tuiFailure;
  }),
).pipe(
  Command.withDescription("Report this install's version, paths, and config (for bug reports)"),
);

import { Effect, Layer } from "effect";
import { AppConfig, logConfig, Paths } from "./config";
import { makeLoggerLayer } from "./logging";
import { ChatStore } from "./services/ChatStore";
import { Llm } from "./services/Llm";
import { OpenRouterModels } from "./services/OpenRouterModels";
import { Output } from "./services/Output";
import { Releases } from "./services/Releases";
import { ChatToolsLive } from "./tools";

/**
 * Every app service. Platform services (FileSystem, Path, Stdio, HttpClient, and the CLI's
 * Terminal and ChildProcessSpawner) come from outside: BunServices in src/bin.ts and in
 * tests/helpers/cli.ts (with a test Stdio). Nothing here reads config while being built;
 * AppConfig loads it on first use, so --help and --version work with a broken config file.
 */
export const AppLayer = Layer.mergeAll(
  Llm.layer,
  OpenRouterModels.layer,
  ChatStore.layer,
  Releases.layer,
  ChatToolsLive,
  Output.layer,
).pipe(Layer.provideMerge(AppConfig.layer), Layer.provideMerge(Paths.layer));

/** The stderr logger (and the file sink) from LOG_LEVEL, ORX_LOG_FORMAT, and ORX_LOG_FILE. */
export const LoggerLayer = Layer.unwrap(
  logConfig.pipe(
    Effect.map(makeLoggerLayer),
    Effect.orElseSucceed(() =>
      makeLoggerLayer({ format: "pretty", color: false, minimumLevel: "Warn" }),
    ),
  ),
);

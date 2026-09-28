/**
 * The app's services for standalone bun scripts (evals, the fixture recorder), so they call
 * the same programs and OpenRouter settings the CLI uses.
 *
 * Differences from what src/bin.ts provides:
 * - Scripts don't use the CLI's Host or stdio.
 * - Logging goes to stderr only: ORX_LOG_FILE is ignored, so a script never appends to it.
 * - The HTTP client can take a custom `fetch`, e.g. one that tees response bodies.
 * - Chats are fresh in-memory state: a script never writes to the data dir.
 *
 * Config comes from the environment and the config file as usual (bun loads `.env` from the
 * working directory).
 */
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { logConfig } from "~/config";
import { makeLoggerLayer } from "~/logging";
import { AppLayer } from "~/runtime";
import { ChatStore } from "~/services/ChatStore";

/** A fetch function. Bun's `typeof fetch` also has `preconnect`, which the HTTP client never calls. */
export type ScriptFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ScriptOptions {
  /** The HTTP client's fetch, for every OpenRouter call the script makes. */
  readonly fetch?: ScriptFetch;
}

/** The app's logger options with the file sink dropped: stderr only. */
const ScriptLoggerLayer = Layer.unwrap(
  logConfig.pipe(
    Effect.map(({ file: _file, ...options }) => makeLoggerLayer(options)),
    Effect.orElseSucceed(() =>
      makeLoggerLayer({ format: "pretty", color: false, minimumLevel: "Warn" }),
    ),
  ),
);

/** Every app service, with platform services, config, and the stderr-only logger provided. */
export const makeScriptLayer = (options: ScriptOptions = {}) => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    // FetchHttpClient reads this reference on every request.
    options.fetch
      ? Layer.succeed(FetchHttpClient.Fetch, options.fetch as typeof fetch)
      : Layer.empty,
  );
  // ChatStore.layerMemory comes last, so it replaces AppLayer's file store.
  return Layer.mergeAll(AppLayer, ChatStore.layerMemory).pipe(
    Layer.provideMerge(platform),
    Layer.provideMerge(ScriptLoggerLayer),
    // Read the environment per run: a script (or its test) may change it between runs.
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv())),
  );
};

export type ScriptServices = Layer.Success<ReturnType<typeof makeScriptLayer>>;

/**
 * Runs an app program with the script layer and resolves with its result. A failure or
 * defect rejects the promise (with the failure itself; a defect rejects with what was thrown).
 */
export const runScript = <A, E>(
  program: Effect.Effect<A, E, ScriptServices>,
  options: ScriptOptions = {},
): Promise<A> => Effect.runPromise(Effect.provide(program, makeScriptLayer(options)));

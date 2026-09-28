import { Context, Effect, Layer } from "effect";
import { TuiUnavailable } from "../errors";

const loadLaunch = Effect.tryPromise({
  try: () => import("../tui/launch"),
  catch: (error) =>
    new TuiUnavailable({
      message: `The terminal UI couldn't load: ${String(error)}. \`orx doctor --tui\` checks it; \`orx ask\` works without it.`,
    }),
});

/**
 * Loads the TUI module (and with it OpenTUI's native library). Dynamic, so nothing but
 * the session (bare `orx`) and `doctor --tui` loads OpenTUI; a failure is TuiUnavailable (exit 3),
 * not an orx bug. A service, provided from outside like Host (src/bin.ts, tests/helpers/cli.ts),
 * so a test can make the load fail instead of starting a renderer in the test process.
 */
export class TuiLoader extends Context.Service<TuiLoader, { readonly load: typeof loadLaunch }>()(
  "orx/TuiLoader",
) {
  static readonly layer = Layer.succeed(TuiLoader, { load: loadLaunch });
  /** Every load fails with TuiUnavailable(`message`): the TUI as it is where it can't run. */
  static readonly layerUnavailable = (message: string) =>
    Layer.succeed(TuiLoader, { load: Effect.fail(new TuiUnavailable({ message })) });
}

/** The TUI module, from TuiLoader. */
export const importTui = Effect.gen(function* () {
  return yield* (yield* TuiLoader).load;
});

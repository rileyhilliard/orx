import { Effect } from "effect";
import { TuiUnavailable } from "../errors";

/**
 * Loads the TUI module (and with it OpenTUI's native library). Dynamic, so nothing but `ui`
 * and `doctor --tui` loads OpenTUI; a failure is TuiUnavailable (exit 3), not an orx bug.
 */
export const importTui = Effect.tryPromise({
  try: () => import("../tui/launch"),
  catch: (error) =>
    new TuiUnavailable({
      message: `The terminal UI couldn't load: ${String(error)}. \`orx doctor --tui\` checks it; \`orx ask\` works without it.`,
    }),
});

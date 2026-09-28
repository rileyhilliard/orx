import { Flag } from "effect/unstable/cli";

/** `--json`: machine-readable output on stdout (and errors as JSON on stderr). */
export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text"),
  Flag.withDefault(false),
);

/** `--model`/`-m`: an OpenRouter model id. Default: OPENROUTER_MODEL. */
export const modelFlag = Flag.String("model").pipe(
  Flag.withAlias("m"),
  Flag.withDescription("OpenRouter model id (default: OPENROUTER_MODEL)"),
  Flag.optional,
);

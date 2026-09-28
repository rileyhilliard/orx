import { Effect, Schema } from "effect";
import { Flag } from "effect/unstable/cli";
import { ChatId } from "~/schemas";

/** `--json`: machine-readable output on stdout (and errors as JSON on stderr). */
export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON (NDJSON for streams) instead of text"),
  Flag.withDefault(false),
);

/** `--model`/`-m`: an OpenRouter model id. Default: OPENROUTER_MODEL. */
export const modelFlag = Flag.String("model").pipe(
  Flag.withAlias("m"),
  Flag.withDescription("OpenRouter model id (default: OPENROUTER_MODEL); `orx models` lists them"),
  Flag.optional,
);

export const newChatId = Effect.sync(() => Schema.decodeSync(ChatId)(crypto.randomUUID()));

/**
 * `--cwd <dir>`: the workspace root instead of the directory orx started in. Parsed on `orx`
 * and `orx ask`; the handlers don't use it yet.
 */
export const cwdFlag = Flag.String("cwd").pipe(
  Flag.withDescription("Work in this directory instead of the current one"),
  Flag.optional,
);

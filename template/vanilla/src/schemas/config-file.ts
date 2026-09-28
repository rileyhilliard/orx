import { Schema } from "effect";

/**
 * `$XDG_CONFIG_HOME/orx/config.json` (default `~/.config/orx/config.json`): defaults for the
 * settings env vars also set. Env wins over the file. Closed on purpose: an unknown key is an
 * error, so a typo doesn't pass silently, and so is `apiKey`: the key comes only from
 * OPENROUTER_API_KEY, never from a file.
 */
export const ConfigFile = Schema.Struct({
  model: Schema.optional(Schema.String),
  maxOutputTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
}).annotate({ identifier: "ConfigFile" });
export type ConfigFile = typeof ConfigFile.Type;

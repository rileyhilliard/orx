import { Schema } from "effect";

/** The prompt `orx ask` reads from its arguments or stdin. */
export const Prompt = Schema.Trim.check(
  Schema.isMinLength(1, { message: "The prompt is empty." }),
  Schema.isMaxLength(32_000, { message: "The prompt is longer than 32000 characters." }),
);

export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  /** USD, as reported by OpenRouter. Missing when the provider didn't report it. */
  cost: Schema.optional(Schema.Number),
});
export type Usage = typeof Usage.Type;

/**
 * `orx ask --json` prints one of these on stdout. A public contract for scripts and agents:
 * add fields, don't rename or remove them.
 */
export const AskResult = Schema.Struct({
  text: Schema.String,
  /** The model OpenRouter says served the request, when it said. */
  model: Schema.optional(Schema.String),
  usage: Usage,
});
export type AskResult = typeof AskResult.Type;

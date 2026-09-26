import { Schema } from "effect";

/**
 * What every failure looks like to a script: on stderr as `{"error": ErrorBody}` with --json,
 * and as the `error` event of `orx ask --json`. `tag` is the error's `_tag` (stable),
 * `retryable` says whether running the same command again can succeed.
 */
export const ErrorBody = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type ErrorBody = typeof ErrorBody.Type;

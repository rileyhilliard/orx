import { Schema } from "effect";

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const timeZoneDescription = "An IANA time zone name, for example Europe/Paris or America/New_York";

/**
 * An IANA time zone name. A custom filter has no JSON Schema of its own and its annotations
 * don't reach the JSON Schema, so the description and examples go on the string before the
 * check.
 */
export const TimeZone = Schema.String.annotate({
  description: timeZoneDescription,
  examples: ["Europe/Paris", "America/New_York", "UTC"],
}).check(Schema.makeFilter((value: string) => isTimeZone(value) || `Unknown time zone: ${value}`));

/** Input of the `currentTime` tool. */
export const CurrentTimeInput = Schema.Struct({ timeZone: TimeZone }).annotate({
  title: "CurrentTimeInput",
});
export type CurrentTimeInput = typeof CurrentTimeInput.Type;

/** Output of the `currentTime` tool. */
export const CurrentTimeOutput = Schema.Struct({
  timeZone: Schema.String,
  iso: Schema.String,
  local: Schema.String,
});
export type CurrentTimeOutput = typeof CurrentTimeOutput.Type;

/**
 * Why an agent tool call failed (a path outside the workspace, a missing file, a bad regex).
 * Returned to the model as the tool's result (`failureMode: "return"`), never an AppError: the
 * model reads the message and tries something else.
 */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()("ToolFailure", {
  message: Schema.String,
}) {}

/** A positive integer. The description goes on the number before the checks, so it reaches the JSON Schema. */
const positiveInt = (description: string) =>
  Schema.Number.annotate({ description }).check(Schema.isInt(), Schema.isGreaterThan(0));

/** Input of the `read` tool. */
export const ReadInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The file to read: absolute, or relative to the workspace root",
  }),
  offset: Schema.optional(positiveInt("The 1-based line to start at (default 1)")),
  limit: Schema.optional(positiveInt("How many lines to return (default 2000)")),
});
export type ReadInput = typeof ReadInput.Type;

/** Input of the `glob` tool. */
export const GlobInput = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "A glob matched against paths relative to the search directory, e.g. src/**/*.ts",
  }),
  path: Schema.optional(
    Schema.String.annotate({ description: "The directory to search (default: workspace root)" }),
  ),
});
export type GlobInput = typeof GlobInput.Type;

export const GrepOutputMode = Schema.Literals(["files_with_matches", "content", "count"]);
export type GrepOutputMode = typeof GrepOutputMode.Type;

/** Input of the `grep` tool. */
export const GrepInput = Schema.Struct({
  pattern: Schema.String.annotate({ description: "A regular expression (ripgrep syntax)" }),
  path: Schema.optional(
    Schema.String.annotate({
      description: "The file or directory to search (default: workspace root)",
    }),
  ),
  glob: Schema.optional(
    Schema.String.annotate({ description: "Only search files matching this glob, e.g. *.ts" }),
  ),
  output_mode: Schema.optional(
    GrepOutputMode.annotate({
      description:
        "files_with_matches (default): matching file paths; content: matching lines as path:line:text; count: matches per file",
    }),
  ),
  head_limit: Schema.optional(positiveInt("Return at most this many results (default 100)")),
});
export type GrepInput = typeof GrepInput.Type;

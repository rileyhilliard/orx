import { Option, Schema, SchemaTransformation } from "effect";

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

/**
 * An optional tool parameter that also accepts `null`, decoded as absent: models (Opus through
 * OpenRouter, for one) send `"path": null` for a parameter they mean to leave out.
 */
const optionalNullable = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(schema)).pipe(
    Schema.decodeTo(
      Schema.optionalKey(Schema.toType(schema)),
      SchemaTransformation.transformOptional<S["Type"], S["Type"] | null>({
        decode: (value) => Option.filter(value, (v): v is S["Type"] => v !== null),
        encode: (value) => value,
      }),
    ),
  );

/** A positive integer. The description goes on the number before the checks, so it reaches the JSON Schema. */
const positiveInt = (description: string) =>
  Schema.Number.annotate({ description }).check(Schema.isInt(), Schema.isGreaterThan(0));

/** Input of the `read` tool. */
export const ReadInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The file to read: absolute, or relative to the workspace root",
  }),
  offset: optionalNullable(positiveInt("The 1-based line to start at (default 1)")),
  limit: optionalNullable(positiveInt("How many lines to return (default 2000)")),
});
export type ReadInput = typeof ReadInput.Type;

/** Input of the `glob` tool. */
export const GlobInput = Schema.Struct({
  pattern: Schema.String.annotate({
    description: "A glob matched against paths relative to the search directory, e.g. src/**/*.ts",
  }),
  path: optionalNullable(
    Schema.String.annotate({ description: "The directory to search (default: workspace root)" }),
  ),
});
export type GlobInput = typeof GlobInput.Type;

export const GrepOutputMode = Schema.Literals(["files_with_matches", "content", "count"]);
export type GrepOutputMode = typeof GrepOutputMode.Type;

/** Input of the `grep` tool. */
export const GrepInput = Schema.Struct({
  pattern: Schema.String.annotate({ description: "A regular expression (ripgrep syntax)" }),
  path: optionalNullable(
    Schema.String.annotate({
      description: "The file or directory to search (default: workspace root)",
    }),
  ),
  glob: optionalNullable(
    Schema.String.annotate({ description: "Only search files matching this glob, e.g. *.ts" }),
  ),
  output_mode: optionalNullable(
    GrepOutputMode.annotate({
      description:
        "files_with_matches (default): matching file paths; content: matching lines as path:line:text; count: matches per file",
    }),
  ),
  head_limit: optionalNullable(positiveInt("Return at most this many results (default 100)")),
});
export type GrepInput = typeof GrepInput.Type;

/** Input of the `write` tool. */
export const WriteInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The file to create or overwrite: absolute, or relative to the workspace root",
  }),
  content: Schema.String.annotate({ description: "The whole new contents of the file" }),
});
export type WriteInput = typeof WriteInput.Type;

/** Input of the `edit` tool. */
export const EditInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The file to edit: absolute, or relative to the workspace root",
  }),
  old_string: Schema.String.annotate({
    description:
      "The exact text to replace, without the line-number prefix read shows. Include enough surrounding lines to make it unique",
  }),
  new_string: Schema.String.annotate({ description: "The text to put in its place" }),
  replace_all: optionalNullable(
    Schema.Boolean.annotate({
      description: "Replace every occurrence of old_string (default false: it must be unique)",
    }),
  ),
});
export type EditInput = typeof EditInput.Type;

/** Input of the `bash` tool. */
export const BashInput = Schema.Struct({
  command: Schema.String.annotate({ description: "The command, run with /bin/bash -c" }),
  timeout_ms: optionalNullable(
    positiveInt("Kill the command after this many milliseconds (default 120000, max 600000)"),
  ),
  description: optionalNullable(
    Schema.String.annotate({
      description: "What the command does, in a few words, for the user approving it",
    }),
  ),
});
export type BashInput = typeof BashInput.Type;

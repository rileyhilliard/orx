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

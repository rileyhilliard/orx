import { Clock, Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

// A tool for tests of the turn loop itself, apart from the workspace. The recorded fixtures'
// tool turn (tests/fixtures/openrouter/tool.*.sse) calls it, so its name and parameters match
// what scripts/record-openrouter.ts offers the model.

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** An IANA time zone name; anything else is bad input the model gets back as the result. */
const TimeZone = Schema.String.annotate({
  description: "An IANA time zone name, for example Europe/Paris or America/New_York",
}).check(Schema.makeFilter((value: string) => isTimeZone(value) || `Unknown time zone: ${value}`));

export const CurrentTime = Tool.make("currentTime", {
  description: "Get the current date and time in an IANA time zone.",
  parameters: Schema.Struct({ timeZone: TimeZone }),
  success: Schema.Struct({ timeZone: Schema.String, iso: Schema.String }),
  failureMode: "return",
});

export const TestTools = Toolkit.make(CurrentTime);

/** Handlers for TestTools, on Effect's clock (TestClock in `runTest`). */
export const TestToolsLive = TestTools.toLayer({
  currentTime: ({ timeZone }) =>
    Effect.map(Clock.currentTimeMillis, (now) => ({
      timeZone,
      iso: new Date(now).toISOString(),
    })),
});

/** TestTools with its handlers provided, for `runTurn({ toolkit })` and `makeBridge`. */
export const testToolkit = TestTools.pipe(Effect.provide(TestToolsLive));

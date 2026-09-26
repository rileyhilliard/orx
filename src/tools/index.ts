import { Clock, Effect } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { CurrentTimeInput, CurrentTimeOutput } from "~/schemas";

/**
 * The current time in a time zone. The clock is Effect's, so tests control it with TestClock.
 * `failureMode: "return"`: input that doesn't decode (a zone like "Paris") goes back to the
 * model as the tool's result, so it can correct itself, instead of failing the turn.
 */
export const CurrentTime = Tool.make("currentTime", {
  description: "Get the current date and time in an IANA time zone.",
  parameters: CurrentTimeInput,
  success: CurrentTimeOutput,
  failureMode: "return",
});

/** The tools the chat model can call (`orx ask`, `orx chat`). `orx mcp` serves the same ones. */
export const ChatTools = Toolkit.make(CurrentTime);

export const ChatToolsLive = ChatTools.toLayer({
  currentTime: ({ timeZone }) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const date = new Date(now);
      return {
        timeZone,
        iso: date.toISOString(),
        local: date.toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "long" }),
      };
    }),
});

import { describe, expect, it } from "bun:test";
import { Prompt } from "effect/unstable/ai";
import type { AssistantMessage } from "~/schemas";
import { callOffsets } from "~/tui/launch";

// A resumed reply puts each tool line where it came in the text, rebuilt from the saved steps.

type Part = { text: string } | { call: string };

/** One saved step: the model's parts as `Prompt.fromResponseParts` keeps them. */
const step = (...parts: Part[]) =>
  Prompt.fromMessages([
    Prompt.makeMessage("assistant", {
      content: parts.map((part) =>
        "text" in part
          ? Prompt.makePart("text", { text: part.text })
          : Prompt.makePart("tool-call", {
              id: part.call,
              name: "read",
              params: {},
              providerExecuted: false,
            }),
      ),
    }),
  ]);

const reply = (text: string, calls: number, steps?: Prompt.Prompt[]): AssistantMessage => ({
  role: "assistant",
  text,
  tools: Array.from({ length: calls }, () => ({
    name: "read",
    input: {},
    output: "ok",
    isFailure: false,
  })),
  ...(steps === undefined ? {} : { steps }),
});

describe("callOffsets", () => {
  it("puts calls after the text of their step, and later text after a break", () => {
    const steps = [step({ call: "a" }, { text: "Looking." }), step({ text: "Done." })];
    expect(callOffsets(reply("Looking.\n\nDone.", 1, steps))).toEqual([8]);
  });

  it("gives parallel calls in one step the same place", () => {
    const steps = [step({ text: "Both." }, { call: "a" }, { call: "b" }), step({ text: "Ok." })];
    expect(callOffsets(reply("Both.\n\nOk.", 2, steps))).toEqual([5, 5]);
  });

  it("places a call the reply was stopped in, whose step was saved as far as it got", () => {
    const steps = [step({ text: "Reading." }, { call: "a" })];
    expect(callOffsets(reply("Reading.", 1, steps))).toEqual([8]);
  });

  it("is empty for a reply without calls", () => {
    expect(callOffsets(reply("Just text.", 0, [step({ text: "Just text." })]))).toEqual([]);
  });

  it("gives up for a chat saved before steps existed", () => {
    expect(callOffsets(reply("Text.", 1))).toBeUndefined();
  });

  it("gives up when a step's text came after its call, whose break it can't place", () => {
    // Live, runTurn breaks before text that follows a call in the same step: "A.\n\nB.".
    const steps = [step({ text: "A." }, { call: "a" }, { text: "B." })];
    expect(callOffsets(reply("A.\n\nB.", 1, steps))).toBeUndefined();
  });
});

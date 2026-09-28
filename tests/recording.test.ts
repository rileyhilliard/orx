// The recorder's checks (scripts/lib/recording.ts) on plain data: the recorder itself calls
// the real API, so this is what keeps a bad recording from becoming fixtures.
import { describe, expect, it } from "bun:test";
import type { TurnEvent } from "~/core/chat";
import { type RecordedTurn, recordingProblems } from "../scripts/lib/recording";

const finish = (finishReason: string, text: string): TurnEvent => ({
  type: "finish",
  reply: { role: "assistant", text, tools: [], finishReason },
});
const text = (delta: string): TurnEvent => ({ type: "text", delta });
const call: TurnEvent = {
  type: "tool-call",
  id: "call_1",
  name: "currentTime",
  input: { timeZone: "UTC" },
};
const result: TurnEvent = {
  type: "tool-result",
  id: "call_1",
  name: "currentTime",
  output: {},
  isFailure: false,
};

const plain: RecordedTurn = {
  events: [text("The sea is wide."), finish("stop", "The sea is wide.")],
  bodies: ["a"],
};
const tool: RecordedTurn = {
  events: [call, result, text("It's noon."), finish("stop", "It's noon.")],
  bodies: ["a", "b"],
};

describe("recordingProblems", () => {
  it("accepts a plain reply and a tool turn that both end in an answer", () => {
    expect(recordingProblems(plain, tool)).toEqual([]);
  });

  it("rejects a plain turn that made more than one request", () => {
    expect(recordingProblems({ ...plain, bodies: ["a", "b"] }, tool)).toEqual([
      "the plain turn made 2 requests, not 1",
    ]);
  });

  it("rejects a turn cut off by the output cap", () => {
    expect(recordingProblems({ ...plain, events: [finish("length", "")] }, tool)).toEqual([
      'the plain turn ended with "length", not "stop"',
      "the plain turn's last step has no text",
    ]);
  });

  it("rejects a tool turn that never called the tool", () => {
    expect(recordingProblems(plain, { events: plain.events, bodies: ["a"] })).toEqual([
      expect.stringMatching(/^the tool turn made no tool call \(1 request\(s\)\)/),
    ]);
  });

  it("rejects a tool turn whose answer after the tool result is empty", () => {
    // Text before the tool call doesn't count: the step after the tool result must answer.
    const events = [text("Let me check."), call, result, text("  "), finish("stop", "")];
    expect(recordingProblems(plain, { ...tool, events })).toEqual([
      "the tool turn's last step has no text",
    ]);
  });

  it("rejects a turn with no finish event", () => {
    expect(recordingProblems({ events: [text("hi")], bodies: ["a"] }, tool)).toEqual([
      "the plain turn has no finish event",
    ]);
  });
});

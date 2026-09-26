import type { TurnEvent } from "~/core/chat";

/** One recorded chat turn: its events (from `runTurn`) and the raw body of each response. */
export interface RecordedTurn {
  readonly events: ReadonlyArray<TurnEvent>;
  readonly bodies: ReadonlyArray<string>;
}

/** The text of the turn's last model step: everything streamed after the last tool result. */
const lastStepText = (events: ReadonlyArray<TurnEvent>) => {
  const lastResult = events.findLastIndex((event) => event.type === "tool-result");
  return events
    .slice(lastResult + 1)
    .map((event) => (event.type === "text" ? event.delta : ""))
    .join("");
};

const endsWithAnswer = (name: string, turn: RecordedTurn): string[] => {
  const finish = turn.events.find((event) => event.type === "finish");
  if (finish === undefined) return [`the ${name} turn has no finish event`];
  const problems: string[] = [];
  const reason = finish.reply.finishReason ?? "unknown";
  if (reason !== "stop") problems.push(`the ${name} turn ended with "${reason}", not "stop"`);
  if (lastStepText(turn.events).trim() === "") {
    problems.push(`the ${name} turn's last step has no text`);
  }
  return problems;
};

/**
 * What's wrong with a recording, or an empty list when it's fit to become fixtures. A fixture
 * that recorded a truncated reply or a tool-less tool turn would let tests pass on the wrong
 * shape forever, so the recorder writes nothing unless this is empty.
 */
export const recordingProblems = (plain: RecordedTurn, tool: RecordedTurn): string[] => {
  const problems: string[] = [];
  if (plain.bodies.length !== 1) {
    problems.push(`the plain turn made ${plain.bodies.length} requests, not 1`);
  }
  problems.push(...endsWithAnswer("plain", plain));
  if (tool.events.every((event) => event.type !== "tool-call") || tool.bodies.length < 2) {
    problems.push(
      `the tool turn made no tool call (${tool.bodies.length} request(s)); ` +
        "models don't always call the tool: run it again, or pick a model that does",
    );
  }
  problems.push(...endsWithAnswer("tool", tool));
  return problems;
};

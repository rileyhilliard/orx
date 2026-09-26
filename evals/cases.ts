/**
 * What `bun run eval` asks each model. A chat case runs orx's own `runTurn` (system
 * prompt, tools, step and output limits); an extract case runs orx's `extractContact`.
 * A check returns undefined for a pass, or a short reason for a failure.
 */
import type { Contact } from "~/schemas";

/** What a model did on one case, in the shape the checks read. */
export interface Outcome {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
  /** Extract cases only: the decoded contact. */
  readonly contact?: Contact;
}

export type Check = (outcome: Outcome) => string | undefined;

export interface EvalCase {
  readonly id: string;
  readonly kind: "chat" | "extract";
  readonly input: string;
  readonly check: Check;
}

const calledCurrentTime = (outcome: Outcome, timeZone: string) =>
  outcome.toolCalls.some(
    (call) =>
      call.name === "currentTime" &&
      (call.input as { timeZone?: unknown } | null)?.timeZone === timeZone,
  );

/** Compares extracted fields to the expected ones; strings match case-insensitively. */
const contactMatches =
  (expected: Contact): Check =>
  ({ contact }) => {
    if (contact === undefined) return "no contact returned";
    const wrong = (Object.keys(expected) as Array<keyof Contact>).filter(
      (field) => contact[field]?.toLowerCase() !== expected[field]?.toLowerCase(),
    );
    return wrong.length === 0
      ? undefined
      : `wrong ${wrong.map((field) => `${field} (${JSON.stringify(contact[field])})`).join(", ")}`;
  };

export const cases: ReadonlyArray<EvalCase> = [
  {
    id: "tokyo-time",
    kind: "chat",
    input: "What time is it in Tokyo?",
    check: (outcome) =>
      calledCurrentTime(outcome, "Asia/Tokyo")
        ? undefined
        : "didn't call currentTime with Asia/Tokyo",
  },
  {
    id: "no-tool-for-trivia",
    kind: "chat",
    input: "What is the capital of France? One word.",
    check: (outcome) => {
      if (outcome.toolCalls.length > 0) return "called a tool it didn't need";
      return /paris/i.test(outcome.text) ? undefined : "answer doesn't mention Paris";
    },
  },
  {
    id: "reply-ok",
    kind: "chat",
    input: "Reply with just: ok",
    check: ({ text }) =>
      /^ok[.!]?$/i.test(text.trim()) ? undefined : `expected "ok", got ${JSON.stringify(text)}`,
  },
  {
    id: "extract-full",
    kind: "extract",
    input:
      "Please loop in Ada Lovelace from Analytical Engines Ltd, ada@analytical.example, +44 20 7946 0958.",
    check: contactMatches({
      name: "Ada Lovelace",
      email: "ada@analytical.example",
      phone: "+44 20 7946 0958",
      company: "Analytical Engines Ltd",
    }),
  },
  {
    id: "extract-missing-fields",
    kind: "extract",
    input: "Grace Hopper stopped by the booth; she said to follow up next week.",
    check: contactMatches({ name: "Grace Hopper", email: null, phone: null, company: null }),
  },
];

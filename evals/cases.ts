/**
 * What `bun run eval` asks each model. A chat case runs orx's own `runTurn` (system
 * prompt, tools, step and output limits); an extract case runs orx's `extractContact`; a
 * coding case runs `orx ask --agent --permission-mode acceptEdits` in a temporary workspace.
 * A check returns undefined for a pass, or a short reason for a failure.
 */
import type { Contact } from "~/schemas";

/** A coding case's workspace after the turn, and what its test script made of it. */
export interface WorkspaceOutcome {
  /** Every file, by root-relative path with `/` separators. */
  readonly files: Readonly<Record<string, string>>;
  readonly test: { readonly exitCode: number; readonly output: string };
}

/** What a model did on one case, in the shape the checks read. */
export interface Outcome {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
  /** Extract cases only: the decoded contact. */
  readonly contact?: Contact;
  /** Coding cases only. */
  readonly workspace?: WorkspaceOutcome;
}

export type Check = (outcome: Outcome) => string | undefined;

interface BaseCase {
  readonly id: string;
  readonly input: string;
  readonly check: Check;
}

export interface ChatCase extends BaseCase {
  readonly kind: "chat" | "extract";
}

export interface CodingCase extends BaseCase {
  readonly kind: "coding";
  /** The workspace the turn starts in, by root-relative path. */
  readonly files: Readonly<Record<string, string>>;
  /** TypeScript that bun runs in the workspace after the turn; exit 0 means it works. */
  readonly test: string;
}

export type EvalCase = ChatCase | CodingCase;

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

const RENAME_FILES = {
  "package.json": `${JSON.stringify({ name: "shop", private: true, type: "module" }, null, 2)}\n`,
  "README.md":
    "# shop\n\nPrices are integer cents. Show one with `fmtPrice` from `src/money.ts`.\n",
  "src/money.ts": [
    "/** An amount in cents as dollars, like $12.50. */",
    "export function fmtPrice(cents: number): string {",
    '  return "$" + (cents / 100).toFixed(2);',
    "}",
    "",
  ].join("\n"),
  "src/cart.ts": [
    'import { fmtPrice } from "./money";',
    "",
    "export interface Line {",
    "  name: string;",
    "  cents: number;",
    "  qty: number;",
    "}",
    "",
    "export function cartTotal(lines: Line[]): string {",
    "  return fmtPrice(lines.reduce((sum, line) => sum + line.cents * line.qty, 0));",
    "}",
    "",
  ].join("\n"),
  "src/receipt.ts": [
    'import type { Line } from "./cart";',
    'import { fmtPrice } from "./money";',
    "",
    "export function receipt(lines: Line[]): string {",
    '  return lines.map((line) => line.qty + " x " + line.name + " @ " + fmtPrice(line.cents)).join("\\n");',
    "}",
    "",
  ].join("\n"),
};

/**
 * The rename landed everywhere and nothing else moved: no file still names the old function,
 * every file that did names the new one, no file was added or removed, and the test passes.
 */
export const renamedAcrossFiles =
  (from: string, to: string, before: Readonly<Record<string, string>>): Check =>
  ({ workspace }) => {
    if (workspace === undefined) return "no workspace recorded";
    const paths = Object.keys(workspace.files);
    const added = paths.filter((path) => !(path in before));
    const removed = Object.keys(before).filter((path) => !(path in workspace.files));
    if (added.length > 0 || removed.length > 0) {
      const changes = [...added.map((p) => `added ${p}`), ...removed.map((p) => `removed ${p}`)];
      return changes.join(", ");
    }
    const stale = paths.filter((path) => workspace.files[path]?.includes(from));
    if (stale.length > 0) return `${from} still in ${stale.join(", ")}`;
    const missed = Object.entries(before)
      .filter(([path, text]) => text.includes(from) && !workspace.files[path]?.includes(to))
      .map(([path]) => path);
    if (missed.length > 0) return `${to} missing from ${missed.join(", ")}`;
    if (workspace.test.exitCode !== 0) {
      const first = workspace.test.output.trim().split("\n")[0] ?? "";
      return `the test exited ${workspace.test.exitCode}${first === "" ? "" : `: ${first}`}`;
    }
    return undefined;
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
  {
    id: "rename-across-files",
    kind: "coding",
    input:
      "Rename the function fmtPrice to formatPrice everywhere in this project: its definition, imports, call sites, and docs. Change nothing else.",
    files: RENAME_FILES,
    test: [
      'import { formatPrice } from "./src/money";',
      'import { cartTotal } from "./src/cart";',
      'import { receipt } from "./src/receipt";',
      'const lines = [{ name: "tea", cents: 250, qty: 2 }];',
      "const got = [formatPrice(1250), cartTotal(lines), receipt(lines)];",
      'const want = ["$12.50", "$5.00", "2 x tea @ $2.50"];',
      "if (JSON.stringify(got) !== JSON.stringify(want)) {",
      '  console.error("got " + JSON.stringify(got));',
      "  process.exit(1);",
      "}",
    ].join("\n"),
    check: renamedAcrossFiles("fmtPrice", "formatPrice", RENAME_FILES),
  },
];

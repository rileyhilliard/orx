/** One line per finished tool call (`read src/x.ts · 120 lines`), and diffs cut to size. */

/** Diffs and approval previews show this many lines, then how many more there are. */
export const DIFF_MAX_LINES = 20;

/** At most `max` lines of `text`, plus a count of the rest. */
export const collapseLines = (text: string, max = DIFF_MAX_LINES) => {
  const lines = text.replace(/\n$/, "").split("\n");
  return {
    lines: lines.slice(0, max),
    hidden: Math.max(0, lines.length - max),
  };
};

const field = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

const failureMessage = (output: unknown) =>
  typeof output === "string" ? output : (field(output, "message") ?? "failed");

const countLines = (text: string, pattern: RegExp) =>
  text.split("\n").filter((line) => pattern.test(line)).length;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The summary line for a finished call of one of the agent's tools, and the diff an edit
 * applied; undefined for other tools, which keep their `name(input)` line.
 */
export const summarizeTool = (
  name: string,
  input: unknown,
  output: unknown,
  isFailure: boolean,
): { readonly summary: string; readonly diff?: string } | undefined => {
  const target =
    name === "bash"
      ? field(input, "command")
      : name === "glob" || name === "grep"
        ? field(input, "pattern")
        : field(input, "path");
  if (target === undefined) return undefined;
  const firstLine = target.split("\n")[0] ?? "";
  const shown =
    firstLine.length > 80 || firstLine !== target ? `${firstLine.slice(0, 80)}…` : target;
  const head = `${name} ${shown}`;
  if (isFailure) return { summary: `${head} · ${failureMessage(output)}` };
  const text = typeof output === "string" ? output : "";
  switch (name) {
    case "read":
      return { summary: `${head} · ${plural(countLines(text, /^\s*\d+\t/), "line")}` };
    case "glob":
      return {
        summary: `${head} · ${text.startsWith("No files") ? "no files" : plural(countLines(text, /\S/), "file")}`,
      };
    case "grep":
      return { summary: `${head} · ${plural(countLines(text, /\S/), "line")}` };
    case "bash": {
      const exit = /\(exit code (-?\d+)\)\s*$/.exec(text)?.[1];
      return { summary: exit === undefined ? head : `${head} · exit ${exit}` };
    }
    case "write":
      return { summary: text.split("\n")[0] ?? head };
    case "edit":
      return { summary: head, diff: text };
    default:
      return undefined;
  }
};

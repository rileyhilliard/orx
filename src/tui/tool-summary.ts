/** One line per finished tool call (`read src/x.ts · 120 lines`), and diffs cut to size. */

/** A finished tool line's diff shows this many lines, then how many more there are. */
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

const firstLine = (text: string) => text.split("\n")[0] ?? "";

const DENIED = ": denied. ";

/**
 * Why a failed call was denied (the user's no, plan mode, a headless session), `""` when the
 * message doesn't say, or undefined when it failed for another reason. A denial is a
 * ToolFailure marked `denied` whose message `permit` (src/tools/permit.ts) builds as
 * `<summary>: denied. <reason>`.
 */
export const denialReason = (output: unknown): string | undefined => {
  if (typeof output !== "object" || output === null) return undefined;
  if ((output as { readonly denied?: unknown }).denied !== true) return undefined;
  const message = failureMessage(output);
  const at = message.indexOf(DENIED);
  return at === -1 ? "" : message.slice(at + DENIED.length);
};

/** A finished call's status: denied is the user's (or the mode's) choice, not an error. */
export const toolStatus = (output: unknown, isFailure: boolean): "ok" | "error" | "denied" =>
  !isFailure ? "ok" : denialReason(output) === undefined ? "error" : "denied";

/** A new file's contents as the diff that created it (every line added). */
const createdDiff = (content: string) =>
  content === ""
    ? undefined
    : content
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `+${line}`)
        .join("\n");

const countLines = (text: string, pattern: RegExp) =>
  text.split("\n").filter((line) => pattern.test(line)).length;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The summary line for a finished call of one of the agent's tools, and the diff an edit
 * applied (for a write that created a file, its content); undefined for other tools, which keep their `name(input)` line. A failure
 * shows its message's first line; a denial says so, with the reason's first line.
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
  const first = firstLine(target);
  const shown = first.length > 80 || first !== target ? `${first.slice(0, 80)}…` : target;
  const head = `${name} ${shown}`;
  if (isFailure) {
    const reason = denialReason(output);
    return reason === undefined
      ? { summary: `${head} · ${firstLine(failureMessage(output))}` }
      : { summary: `${head} · denied${reason === "" ? "" : ` · ${firstLine(reason)}`}` };
  }
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
    case "write": {
      // A new file's diff is its content; an overwrite's result is a summary line, then its diff.
      const [summary = head, ...rest] = text.split("\n");
      const diff = summary.startsWith("Created")
        ? createdDiff(field(input, "content") ?? "")
        : rest.length > 0
          ? rest.join("\n")
          : undefined;
      return diff === undefined ? { summary } : { summary, diff };
    }
    case "edit":
      return { summary: head, diff: text };
    default:
      return undefined;
  }
};

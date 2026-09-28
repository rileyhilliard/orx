/**
 * One line per tool call (`read src/x.ts · 120 lines`), diffs cut to size, and the line that
 * closes a reply that used tools (`Done · changed src/x.ts`).
 */
import type { UiToolStatus } from "./types";

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

const AGENT_TOOLS = new Set(["read", "glob", "grep", "write", "edit", "bash"]);

/** `edit src/x.ts`, `bash bun test`: an agent tool call by what it touches. */
const headOf = (name: string, input: unknown): string | undefined => {
  if (!AGENT_TOOLS.has(name)) return undefined;
  const target =
    name === "bash"
      ? field(input, "command")
      : name === "glob" || name === "grep"
        ? field(input, "pattern")
        : field(input, "path");
  if (target === undefined) return undefined;
  const first = firstLine(target);
  const shown = first.length > 80 || first !== target ? `${first.slice(0, 80)}…` : target;
  return `${name} ${shown}`;
};

/** `path` as the workspace sees it: `./a.ts` and `<root>/a.ts` are both `a.ts`. */
const relativePath = (path: string, root: string | undefined) => {
  const inRoot =
    root !== undefined && path.startsWith(`${root.replace(/\/$/, "")}/`)
      ? path.slice(root.replace(/\/$/, "").length + 1)
      : path;
  return inRoot.replace(/^(\.\/)+/, "");
};

/**
 * A call as it starts: its line while it runs (`edit src/x.ts`, in place of the raw input), and
 * the file it would change relative to `root`, for the reply's closing summary. Empty for other
 * tools.
 */
export const describeCall = (
  name: string,
  input: unknown,
  root?: string,
): { readonly target?: string; readonly file?: string } => {
  const target = headOf(name, input);
  if (target === undefined) return {};
  const path = name === "edit" || name === "write" ? field(input, "path") : undefined;
  return path === undefined ? { target } : { target, file: relativePath(path, root) };
};

/** How many changed files the closing summary names before it counts the rest. */
const SUMMARY_FILES = 5;

/**
 * The line under a finished reply that used tools, so the user sees it's over and what it
 * did without relying on the model to say: the files it changed (successful edits and
 * writes, once each) and the commands it ran (denied ones didn't run). Undefined for a reply
 * without tool calls.
 */
export const turnSummary = (
  tools: ReadonlyArray<{
    readonly name: string;
    readonly status?: UiToolStatus;
    readonly file?: string;
  }>,
): string | undefined => {
  if (tools.length === 0) return undefined;
  const files = [
    ...new Set(tools.flatMap((t) => (t.file !== undefined && t.status === "ok" ? [t.file] : []))),
  ];
  const commands = tools.filter(
    (t) => t.name === "bash" && (t.status === "ok" || t.status === "error"),
  ).length;
  const shown = files.slice(0, SUMMARY_FILES).join(", ");
  const more = files.length > SUMMARY_FILES ? ` and ${files.length - SUMMARY_FILES} more` : "";
  const ran = commands === 0 ? [] : [`ran ${plural(commands, "command")}`];
  // A command may have changed files too, so "no files changed" only when none ran.
  const changed =
    files.length > 0 ? [`changed ${shown}${more}`] : ran.length > 0 ? [] : ["no files changed"];
  return ["Done", ...changed, ...ran].join(" · ");
};

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
  const head = headOf(name, input);
  if (head === undefined) return undefined;
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
      return {
        summary: `${head} · ${text.startsWith("No matches") ? "no matches" : plural(countLines(text, /\S/), "line")}`,
      };
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

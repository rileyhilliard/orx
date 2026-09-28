import { printable } from "./printable";
import { theme } from "./theme";
import { collapseLines } from "./tool-summary";
import type { UiApproval } from "./types";

const diffColor = (line: string) => (line.startsWith("+") ? theme.text : theme.muted);

/** A finished call's diff, cut at DIFF_MAX_LINES: added lines bright, the rest muted. */
export const DiffLines = ({ diff }: { readonly diff: string }) => {
  const { lines, hidden } = collapseLines(printable(diff));
  return (
    <>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static lines, never reordered
        <text key={i} fg={diffColor(line)} wrapMode="none">
          {line === "" ? " " : line}
        </text>
      ))}
      {hidden > 0 ? <text fg={theme.faint}>{`… ${hidden} more lines`}</text> : null}
    </>
  );
};

export interface PanelRow {
  readonly text: string;
  readonly fg: string;
}

/**
 * `line` in rows of at most `width` terminal columns, so nothing a user approves is clipped:
 * tabs become spaces to the next multiple of 4, and wide characters (CJK, emoji) count as two.
 */
export const wrap = (line: string, width: number): ReadonlyArray<string> => {
  const rows: Array<string> = [];
  let row = "";
  let used = 0;
  for (const char of line) {
    const cells = char === "\t" ? 4 - (used % 4) : Bun.stringWidth(char);
    if (used + cells > width && row !== "") {
      rows.push(row);
      row = "";
      used = 0;
    }
    // A tab at the start of a new row fills a whole stop.
    const shown = char === "\t" ? " ".repeat(4 - (used % 4)) : char;
    row += shown;
    used += char === "\t" ? shown.length : cells;
  }
  rows.push(row === "" ? " " : row);
  return rows;
};

/**
 * An approval as screen rows `width` wide: `head` (what it is: the command's first line, or
 * "Edit src/x.ts") stays in view, and `body` (the rest of a multi-line command, then the whole
 * diff) scrolls. Control characters are stripped: the model wrote this text.
 */
export const approvalRows = (approval: UiApproval, width: number) => {
  const w = Math.max(10, width);
  const [first = "", ...rest] = printable(approval.summary).replace(/\n+$/, "").split("\n");
  const bash = approval.tool === "bash";
  const head = wrap(bash ? `Run  ${first}` : first, w).map((text) => ({ text, fg: theme.tool }));
  const command = rest.flatMap((line) =>
    wrap(bash ? `     ${line}` : line, w).map((text) => ({ text, fg: theme.tool })),
  );
  const diff = approval.diff
    ? printable(approval.diff)
        .replace(/\n$/, "")
        .split("\n")
        .flatMap((line) => wrap(line, w).map((text) => ({ text, fg: diffColor(line) })))
    : [];
  return { head, body: [...command, ...diff] };
};

/**
 * A tool call waiting for the user, above the composer: what it does, then the rest of the
 * command or the whole diff, `rows` at a time from `offset` (app.tsx scrolls it with Up/Down
 * and PgUp/PgDn, and the footer says so). The keys are in the footer while it's open.
 */
export const ApprovalPanel = ({
  head,
  body,
  offset,
  rows,
}: {
  readonly head: ReadonlyArray<PanelRow>;
  readonly body: ReadonlyArray<PanelRow>;
  readonly offset: number;
  readonly rows: number;
}) => (
  <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
    {[...head, ...body.slice(offset, offset + rows)].map((row, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: rows of a fixed window, redrawn whole
      <text key={i} fg={row.fg} wrapMode="none">
        {row.text}
      </text>
    ))}
    {body.length > rows ? (
      <text fg={theme.faint}>
        {`lines ${offset + 1}–${Math.min(offset + rows, body.length)} of ${body.length}`}
      </text>
    ) : null}
  </box>
);

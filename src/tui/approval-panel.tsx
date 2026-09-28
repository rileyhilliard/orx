import { theme } from "./theme";
import { collapseLines } from "./tool-summary";
import type { UiApproval } from "./types";

/** A diff, cut at DIFF_MAX_LINES: added lines bright, the rest muted. */
export const DiffLines = ({ diff }: { readonly diff: string }) => {
  const { lines, hidden } = collapseLines(diff);
  return (
    <>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static lines, never reordered
        <text key={i} fg={line.startsWith("+") ? theme.text : theme.muted} wrapMode="none">
          {line === "" ? " " : line}
        </text>
      ))}
      {hidden > 0 ? <text fg={theme.faint}>{`… ${hidden} more lines`}</text> : null}
    </>
  );
};

/**
 * A tool call waiting for the user, above the composer: the command, or what the change does
 * and its diff. The keys are in the footer while it's open.
 */
export const ApprovalPanel = ({ approval }: { readonly approval: UiApproval }) => (
  <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
    <text fg={theme.tool}>
      {approval.tool === "bash" ? `Run  ${approval.summary}` : approval.summary}
    </text>
    {approval.diff ? <DiffLines diff={approval.diff} /> : null}
  </box>
);

import { DiffLines } from "./approval-panel";
import { clip } from "./picker";
import { printable } from "./printable";
import { theme } from "./theme";
import { turnSummary } from "./tool-summary";
import type { UiMessage, UiMode, UiToolCall, UiToolStatus } from "./types";

/** A failed call is an error; a denied one was the user's (or the mode's) choice. */
const toolColor = (status: UiToolStatus | undefined) =>
  status === "error" ? theme.error : status === "denied" ? theme.muted : theme.tool;

const ClosingSummary = ({ tools }: { readonly tools: UiMessage["tools"] }) => {
  const summary = turnSummary(tools);
  return summary ? <text fg={theme.muted}>{printable(summary)}</text> : null;
};

const ToolLine = ({ tool, live }: { readonly tool: UiToolCall; readonly live: boolean }) => {
  // A call still running when its turn ended was stopped with the reply.
  const status = tool.status === "running" && !live ? "stopped" : tool.status;
  return (
    <>
      <text fg={toolColor(tool.status)}>
        {printable(
          tool.summary
            ? `→ ${tool.summary}`
            : // The input can be a whole file's contents: 60 columns of it are enough.
              `→ ${tool.target ?? `${tool.name}(${clip(tool.input, 60)})`}${status ? ` · ${status}` : ""}`,
        )}
      </text>
      {tool.diff ? <DiffLines diff={tool.diff} /> : null}
    </>
  );
};

type ReplyPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly tool: UiToolCall };

/**
 * A reply in the order it happened: the text the model wrote before each tool call, the call,
 * and so on. A call without a position (a chat saved before replies kept one) comes first.
 */
const replyParts = (message: UiMessage): ReadonlyArray<ReplyPart> => {
  const parts: ReplyPart[] = [];
  let from = 0;
  const addText = (to: number) => {
    // Blank lines at the edges only: a first line's indentation (code, a nested list) stays.
    const text = message.text.slice(from, to).replace(/^\n+|\s+$/g, "");
    if (text !== "") parts.push({ type: "text", text });
    from = Math.max(from, to);
  };
  for (const tool of message.tools) {
    addText(tool.at ?? 0);
    parts.push({ type: "tool", tool });
  }
  addText(message.text.length);
  return parts;
};

/** A reply: its text and tool lines in order, a blank row wherever one gives way to the other. */
const Reply = ({ message, live }: { readonly message: UiMessage; readonly live: boolean }) => {
  const parts = replyParts(message);
  return (
    <>
      {parts.map((part, i) => {
        const gap = i > 0 && parts[i - 1]?.type !== part.type ? 1 : 0;
        return part.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts only grow at the end
          <text key={i} fg={theme.text} marginTop={gap}>
            {printable(part.text)}
          </text>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts only grow at the end
          <box key={i} flexDirection="column" marginTop={gap}>
            <ToolLine tool={part.tool} live={live} />
          </box>
        );
      })}
      {message.error ? (
        <text fg={theme.error}>
          {printable(
            message.error.retryable
              ? `${message.error.message} (send again to retry)`
              : message.error.message,
          )}
        </text>
      ) : null}
      {message.note ? <text fg={theme.muted}>{printable(message.note)}</text> : null}
      {/* A finished reply that used tools says what it changed, whatever the model said. */}
      {message.usage && !message.error && !message.note && !message.interrupted ? (
        <ClosingSummary tools={message.tools} />
      ) : null}
      {message.usage ? <text fg={theme.faint}>{message.usage}</text> : null}
    </>
  );
};

/** An empty chat says what to ask for and what the permission mode lets the agent do. */
const EMPTY: Record<UiMode, string> = {
  default: "Ask for a change here. Edits and commands ask first.",
  acceptEdits: "Ask for a change here. Edits apply as they're made; commands ask first.",
  plan: "Ask for a plan. Plan mode reads the code and changes nothing.",
  yolo: "Ask for a change here. Nothing asks first: edits and commands just run.",
};

/**
 * The conversation, newest at the bottom; sticks to the bottom while a reply streams. Text the
 * model or a tool produced goes through `printable`, so it can't drive the terminal.
 */
export const MessageList = ({
  messages,
  streaming,
  mode,
}: {
  readonly messages: ReadonlyArray<UiMessage>;
  readonly streaming: boolean;
  readonly mode: UiMode;
}) => (
  <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
    {messages.length === 0 ? <text fg={theme.muted}>{EMPTY[mode]}</text> : null}
    {messages.map((message, index) => (
      // Messages are append-only, so the index is a stable key.
      // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
      <box key={index} flexDirection="column" marginBottom={1}>
        {message.role === "user" ? (
          <text fg={theme.user}>{`> ${printable(message.text)}`}</text>
        ) : (
          <Reply message={message} live={streaming && index === messages.length - 1} />
        )}
      </box>
    ))}
  </scrollbox>
);

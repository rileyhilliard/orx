import { DiffLines } from "./approval-panel";
import { clip } from "./picker";
import { printable } from "./printable";
import { theme } from "./theme";
import type { UiMessage, UiToolStatus } from "./types";

/** A failed call is an error; a denied one was the user's (or the mode's) choice. */
const toolColor = (status: UiToolStatus | undefined) =>
  status === "error" ? theme.error : status === "denied" ? theme.muted : theme.tool;

/**
 * The conversation, newest at the bottom; sticks to the bottom while a reply streams. Text the
 * model or a tool produced goes through `printable`, so it can't drive the terminal.
 */
export const MessageList = ({
  messages,
  streaming,
}: {
  readonly messages: ReadonlyArray<UiMessage>;
  readonly streaming: boolean;
}) => (
  <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
    {messages.length === 0 ? (
      <text fg={theme.muted}>Type a message and press Enter. Ctrl+P picks a model.</text>
    ) : null}
    {messages.map((message, index) => (
      // Messages are append-only, so the index is a stable key.
      // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
      <box key={index} flexDirection="column" marginBottom={1}>
        {message.role === "user" ? (
          <text fg={theme.user}>{`> ${printable(message.text)}`}</text>
        ) : (
          <>
            {message.tools.map((tool, i) => {
              // A call still running when its turn ended was stopped with the reply.
              const live = streaming && index === messages.length - 1;
              const status = tool.status === "running" && !live ? "stopped" : tool.status;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
                <box key={i} flexDirection="column">
                  <text fg={toolColor(tool.status)}>
                    {printable(
                      tool.summary
                        ? `→ ${tool.summary}`
                        : // The input can be a whole file's contents: 60 columns of it are enough.
                          `→ ${tool.name}(${clip(tool.input, 60)})${status ? ` · ${status}` : ""}`,
                    )}
                  </text>
                  {tool.diff ? <DiffLines diff={tool.diff} /> : null}
                </box>
              );
            })}
            <text fg={theme.text}>
              {printable(message.text) || (streaming && index === messages.length - 1 ? "…" : "")}
            </text>
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
            {message.usage ? <text fg={theme.faint}>{message.usage}</text> : null}
          </>
        )}
      </box>
    ))}
  </scrollbox>
);

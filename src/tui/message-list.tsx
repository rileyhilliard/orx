import { theme } from "./theme";
import type { UiMessage } from "./types";

/** The conversation, newest at the bottom; sticks to the bottom while a reply streams. */
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
          <text fg={theme.user}>{`> ${message.text}`}</text>
        ) : (
          <>
            {message.tools.map((tool, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
              <text key={i} fg={theme.tool}>{`→ ${tool.name}(${tool.input})`}</text>
            ))}
            <text fg={theme.text}>
              {message.text || (streaming && index === messages.length - 1 ? "…" : "")}
            </text>
            {message.error ? (
              <text fg={theme.error}>
                {message.error.retryable
                  ? `${message.error.message} (send again to retry)`
                  : message.error.message}
              </text>
            ) : null}
            {message.usage ? <text fg={theme.faint}>{message.usage}</text> : null}
          </>
        )}
      </box>
    ))}
  </scrollbox>
);

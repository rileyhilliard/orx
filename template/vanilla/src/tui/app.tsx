import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import { theme } from "./theme";
import type { UiBridge, UiReply } from "./types";

/**
 * The placeholder screen: a prompt, the model's last reply, and a key hint. Keys: Enter sends,
 * Ctrl+C quits. Replace it with the product's screens; keep the bridge as the only way in.
 */
export const App = ({ bridge }: { readonly bridge: UiBridge }) => {
  const [prompt, setPrompt] = useState<string | undefined>(undefined);
  const [reply, setReply] = useState<UiReply | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);
  // Bumped on send: remounting the input is what clears it.
  const [turn, setTurn] = useState(0);

  const send = useCallback(
    (text: string) => {
      if (text.trim() === "" || waiting) return;
      setTurn((n) => n + 1);
      setPrompt(text);
      setReply(undefined);
      setWaiting(true);
      bridge
        .ask(text)
        .then(setReply, () =>
          setReply({
            type: "error",
            error: { message: "The request stopped unexpectedly.", retryable: true },
          }),
        )
        .finally(() => setWaiting(false));
    },
    [bridge, waiting],
  );

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") bridge.quit();
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme.accent}>orx</text>
        <text fg={theme.muted}>{`  ${bridge.model}`}</text>
      </box>
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
        {prompt === undefined ? (
          <text fg={theme.muted}>Type a prompt and press Enter.</text>
        ) : (
          <text fg={theme.user}>{`> ${prompt}`}</text>
        )}
        {reply?.type === "reply" ? (
          <box flexDirection="column" paddingTop={1}>
            <text fg={theme.text}>{reply.text}</text>
            <text fg={theme.faint}>{reply.usage}</text>
          </box>
        ) : null}
        {reply?.type === "error" ? (
          <box paddingTop={1}>
            <text fg={theme.error}>
              {reply.error.retryable
                ? `${reply.error.message} Send again to retry.`
                : reply.error.message}
            </text>
          </box>
        ) : null}
      </box>
      <box border flexShrink={0} borderColor={waiting ? theme.faint : theme.border} paddingLeft={1}>
        <input
          key={turn}
          focused
          placeholder={waiting ? "Waiting for the model…" : "Prompt"}
          onSubmit={(value) => {
            if (typeof value === "string") send(value);
          }}
        />
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={1}>
        <text fg={theme.faint}>Enter send · Ctrl+C quit</text>
      </box>
    </box>
  );
};

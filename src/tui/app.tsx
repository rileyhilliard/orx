import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { MessageList } from "./message-list";
import { ModelPicker } from "./model-picker";
import { theme } from "./theme";
import type { ChatBridge, UiEvent, UiMessage } from "./types";

const applyEvent = (reply: UiMessage, event: UiEvent): UiMessage => {
  switch (event.type) {
    case "text":
      return { ...reply, text: reply.text + event.delta };
    case "tool":
      return { ...reply, tools: [...reply.tools, event.call] };
    case "tool-result":
      return {
        ...reply,
        tools: reply.tools.map((call) =>
          call.id === event.id ? { ...call, status: event.isFailure ? "error" : "ok" } : call,
        ),
      };
    case "note":
      return { ...reply, note: event.message };
    case "done":
      return { ...reply, usage: event.usage };
    case "error":
      return { ...reply, error: event.error };
  }
};

/**
 * The chat screen. Keys: Enter sends, Esc stops a reply (or closes the picker), Ctrl+P picks
 * a model, Ctrl+E exports the chat as Markdown, Ctrl+C quits (stopping a reply first, so it
 * is saved as interrupted).
 */
export const App = ({ bridge }: { readonly bridge: ChatBridge }) => {
  const [messages, setMessages] = useState<ReadonlyArray<UiMessage>>(bridge.history);
  const [model, setModel] = useState(bridge.initialModel);
  const [streaming, setStreaming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);
  // Bumped on send: remounting the input is what clears it.
  const [turn, setTurn] = useState(0);
  const current = useRef<AsyncIterator<UiEvent> | undefined>(undefined);

  const stop = useCallback(async () => {
    const it = current.current;
    current.current = undefined;
    await it?.return?.();
  }, []);

  const send = useCallback(
    async (text: string) => {
      if (text.trim() === "" || streaming) return;
      setTurn((n) => n + 1);
      setStatus(undefined);
      setStreaming(true);
      setMessages((ms) => [
        ...ms,
        { role: "user", text, tools: [] },
        { role: "assistant", text: "", tools: [] },
      ]);
      const it = bridge.send(text, model)[Symbol.asyncIterator]();
      current.current = it;
      try {
        for (let next = await it.next(); !next.done; next = await it.next()) {
          const event = next.value;
          setMessages((ms) => {
            const last = ms.at(-1);
            return last ? [...ms.slice(0, -1), applyEvent(last, event)] : ms;
          });
        }
      } catch {
        // The bridge maps failures to error events, so this is a broken iterator: say so.
        const error = { message: "The reply stopped unexpectedly.", retryable: true };
        setMessages((ms) => {
          const last = ms.at(-1);
          return last ? [...ms.slice(0, -1), { ...last, error }] : ms;
        });
      } finally {
        current.current = undefined;
        setStreaming(false);
      }
    },
    [bridge, model, streaming],
  );

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      stop().then(bridge.quit, bridge.quit);
    } else if (key.name === "escape") {
      if (picking) setPicking(false);
      else stop().catch(() => setStatus("Couldn't stop the reply."));
    } else if (key.ctrl && key.name === "p" && !streaming) {
      setPicking(true);
    } else if (key.ctrl && key.name === "e" && !streaming) {
      bridge.exportMarkdown().then(setStatus, () => setStatus("Export failed."));
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
        <text fg={theme.accent}>orx</text>
        <text fg={theme.muted}>{`  ${model}`}</text>
        <box flexGrow={1} />
        <text fg={theme.faint}>{`chat ${bridge.chatId.slice(0, 8)}`}</text>
      </box>
      <MessageList messages={messages} streaming={streaming} />
      <box
        border
        flexShrink={0}
        borderColor={streaming ? theme.faint : theme.border}
        paddingLeft={1}
      >
        <input
          key={turn}
          focused={!picking}
          placeholder={streaming ? "Replying… Esc stops" : "Message"}
          onSubmit={(value) => {
            if (typeof value === "string") void send(value);
          }}
        />
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={1}>
        <text fg={theme.faint}>
          {status ?? "Enter send · Esc stop · Ctrl+P model · Ctrl+E export · Ctrl+C quit"}
        </text>
      </box>
      {picking ? (
        <ModelPicker
          load={bridge.listModels}
          current={model}
          onPick={(id) => {
            if (id) setModel(id);
            setPicking(false);
          }}
        />
      ) : null}
    </box>
  );
};

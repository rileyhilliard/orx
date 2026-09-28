import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { BUILTINS, isBuiltin, isMode, KEYS, MODES, type Mode, parseSlash } from "./commands";
import { MessageList } from "./message-list";
import { ModelPicker } from "./model-picker";
import { Picker, type PickerItem, type PickerList } from "./picker";
import { theme } from "./theme";
import type { ChatBridge, UiEvent, UiMessage } from "./types";

const applyEvent = (reply: UiMessage, event: UiEvent): UiMessage => {
  switch (event.type) {
    case "text":
      return { ...reply, text: reply.text + event.delta };
    case "tool":
      return { ...reply, tools: [...reply.tools, event.call] };
    case "done":
      return { ...reply, usage: event.usage };
    case "error":
      return { ...reply, error: event.error };
  }
};

/**
 * The chat screen. Keys: Enter sends, `/` opens the command list, Esc stops a reply (or closes
 * a list), Ctrl+P picks a model, Ctrl+E exports the chat as Markdown, Ctrl+C quits (stopping a
 * reply first, so it is saved as interrupted). `/name args` runs a built-in (commands.ts), a
 * custom command, or a skill; an unknown name shows an error and sends nothing.
 */
export const App = ({ bridge }: { readonly bridge: ChatBridge }) => {
  const [messages, setMessages] = useState<ReadonlyArray<UiMessage>>(bridge.history);
  const [model, setModel] = useState(bridge.initialModel);
  const [streaming, setStreaming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);
  // The composer is set imperatively: a controlled `value` loses a keystroke typed just before
  // Enter (the typed state and the cleared state batch to the same value, so React skips it).
  const input = useRef<InputRenderable>(null);
  const setDraft = useCallback((text: string) => {
    if (input.current) input.current.value = text;
  }, []);
  const [commandList, setCommandList] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; lines: ReadonlyArray<string> }>();
  const [mode, setMode] = useState<Mode>("default");
  const [chatId, setChatId] = useState(bridge.chatId);
  const current = useRef<AsyncIterator<UiEvent> | undefined>(undefined);

  const stop = useCallback(async () => {
    const it = current.current;
    current.current = undefined;
    await it?.return?.();
  }, []);

  const send = useCallback(
    async (text: string, turnModel: string = model) => {
      if (text.trim() === "" || streaming) return;
      setDraft("");
      setStatus(undefined);
      setNotice(undefined);
      setStreaming(true);
      setMessages((ms) => [
        ...ms,
        { role: "user", text, tools: [] },
        { role: "assistant", text: "", tools: [] },
      ]);
      const it = bridge.send(text, turnModel)[Symbol.asyncIterator]();
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
    [bridge, model, streaming, setDraft],
  );

  const runBuiltin = (name: string, args: string) => {
    switch (name) {
      case "help":
        return setNotice({
          error: false,
          lines: [
            ...BUILTINS.map((b) => `/${b.name}  ${b.description}`),
            "",
            KEYS.map(([key, does]) => `${key} ${does}`).join(" · "),
          ],
        });
      case "clear":
        return bridge.newChat().then(
          (id) => {
            setChatId(id);
            setMessages([]);
            setStatus(undefined);
          },
          () => setStatus("Couldn't start a new chat."),
        );
      case "model":
        return setPicking(true);
      case "mode":
        if (args === "")
          return setNotice({ error: false, lines: [`Mode: ${mode}. /mode ${MODES.join("|")}`] });
        if (!isMode(args)) {
          return setNotice({
            error: true,
            lines: [`Unknown mode "${args}". Modes: ${MODES.join(", ")}.`],
          });
        }
        return setMode(args);
      case "export":
        return bridge.exportMarkdown().then(setStatus, () => setStatus("Export failed."));
      case "quit":
        return stop().then(bridge.quit, bridge.quit);
    }
  };

  /** Enter in the composer: a slash command, or a message. */
  const submit = (text: string) => {
    if (text.trim() === "/") return setCommandList(true);
    const slash = parseSlash(text);
    if (slash === undefined) return void send(text);
    if (streaming) return;
    setNotice(undefined);
    if (isBuiltin(slash.name)) {
      setDraft("");
      return void runBuiltin(slash.name, slash.args);
    }
    bridge.expandCommand(slash.name, slash.args).then(
      (expansion) => {
        if (expansion) return void send(expansion.text, expansion.model ?? model);
        setNotice({ error: true, lines: [`Unknown command /${slash.name}. Type / for the list.`] });
      },
      () => setNotice({ error: true, lines: [`Couldn't load /${slash.name}.`] }),
    );
  };

  const identity = useCallback((list: PickerList) => list, []);

  /** Closes a list and gives the composer focus back (the `focused` prop alone doesn't). */
  const closeLists = () => {
    setPicking(false);
    setCommandList(false);
    input.current?.focus();
  };

  const loadCommandItems = useCallback(async () => {
    const [commands, skills] = await Promise.all([bridge.listCommands(), bridge.listSkills()]);
    // Built-ins win over custom commands, and commands over skills.
    const items: Array<PickerItem> = [];
    for (const entry of [...BUILTINS, ...commands, ...skills]) {
      if (items.some((i) => i.value === entry.name)) continue;
      items.push({ value: entry.name, label: `/${entry.name}`, description: entry.description });
    }
    return { items, available: true };
  }, [bridge]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      stop().then(bridge.quit, bridge.quit);
    } else if (key.name === "escape") {
      if (picking || commandList) closeLists();
      else if (notice) setNotice(undefined);
      else stop().catch(() => setStatus("Couldn't stop the reply."));
    } else if (key.ctrl && key.name === "p" && !streaming) {
      setPicking(true);
    } else if (key.ctrl && key.name === "e" && !streaming) {
      bridge.exportMarkdown().then(setStatus, () => setStatus("Export failed."));
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1}>
        <text fg={theme.accent}>orx</text>
        <text fg={theme.muted}>{`  ${model}`}</text>
        <box flexGrow={1} />
        <text fg={theme.faint}>{`chat ${chatId.slice(0, 8)}`}</text>
      </box>
      <MessageList messages={messages} streaming={streaming} />
      {notice ? (
        <box flexDirection="column" flexShrink={0} paddingLeft={1}>
          {notice.lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines, never reordered
            <text key={i} fg={notice.error ? theme.error : theme.muted}>
              {line}
            </text>
          ))}
        </box>
      ) : null}
      <box
        border
        flexShrink={0}
        borderColor={streaming ? theme.faint : theme.border}
        paddingLeft={1}
      >
        <input
          focused={!picking && !commandList}
          ref={input}
          placeholder={streaming ? "Replying… Esc stops" : "Message"}
          onInput={(value) => {
            if (value === "/") setCommandList(true);
          }}
          onSubmit={(value) => {
            if (typeof value === "string") submit(value);
          }}
        />
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={1}>
        <text fg={theme.faint} wrapMode="none" flexShrink={1}>
          {status ??
            "Enter send · / commands · Esc stop · Ctrl+P model · Ctrl+E export · Ctrl+C quit"}
        </text>
        <box flexGrow={1} />
        {mode === "default" ? null : (
          <text fg={theme.muted} flexShrink={0} paddingLeft={1}>
            {mode}
          </text>
        )}
      </box>
      {picking ? (
        <ModelPicker
          load={bridge.listModels}
          current={model}
          onPick={(id) => {
            if (id) setModel(id);
            closeLists();
          }}
        />
      ) : null}
      {commandList ? (
        <Picker
          title=" Commands "
          placeholder="Search commands and skills"
          loadingText="Loading commands…"
          unavailableText="Couldn't load commands and skills. Esc to close."
          showDescription
          load={loadCommandItems}
          toList={identity}
          onPick={(name) => {
            if (name) setDraft(`/${name} `);
            closeLists();
          }}
        />
      ) : null}
    </box>
  );
};

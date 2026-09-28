import type { InputRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalPanel } from "./approval-panel";
import { BUILTINS, isBuiltin, isMode, KEYS, MODES, parseSlash } from "./commands";
import { insertMention, opensMentionPicker, rankPaths } from "./mentions";
import { MessageList } from "./message-list";
import { ModelPicker } from "./model-picker";
import { clip, Picker, type PickerItem, type PickerList } from "./picker";
import { printable } from "./printable";
import { theme } from "./theme";
import type { ChatBridge, UiDecision, UiEvent, UiMessage, UiMode } from "./types";
import { useApproval } from "./use-approval";
import { Working } from "./working";

/** The working row's label: the running tool's line, or `Thinking` while the model works. */
const workingLabel = (reply: UiMessage | undefined) => {
  const running = reply?.tools.findLast((t) => t.status === "running");
  return running ? (running.target ?? running.name) : "Thinking";
};

/** How long streamed text can pause before the working row comes back. */
export const WORKING_IDLE_MS = 1000;

const applyEvent = (reply: UiMessage, event: UiEvent): UiMessage => {
  switch (event.type) {
    case "text":
      return { ...reply, text: reply.text + event.delta };
    case "tool":
      return { ...reply, tools: [...reply.tools, { ...event.call, at: reply.text.length }] };
    case "tool-result":
      return {
        ...reply,
        tools: reply.tools.map((call) =>
          call.id === event.id
            ? {
                ...call,
                status: event.status,
                ...(event.summary === undefined ? {} : { summary: event.summary }),
                ...(event.diff === undefined ? {} : { diff: event.diff }),
              }
            : call,
        ),
      };
    // The approval panel's, not the reply's (useApproval handles them).
    case "approval":
    case "approval-cancelled":
      return reply;
    case "note":
      return { ...reply, note: event.message };
    case "done":
      return { ...reply, usage: event.usage };
    case "error":
      return { ...reply, error: event.error };
  }
};

/** The file picker's ranking: fuzzy subsequence, basename hits first (mentions.ts). */
const rankFiles = (items: ReadonlyArray<PickerItem>, query: string) => {
  const byPath = new Map(items.map((item) => [item.value, item]));
  return rankPaths([...byPath.keys()], query).flatMap((p) => byPath.get(p) ?? []);
};

/** `  in ~/project`, cut from the left to fit `room` columns, or nothing when too little fits. */
const headerPath = (path: string, room: number) =>
  room < 12 ? "" : `  in ${clip(path, room - "  in ".length, "start")}`;

/** /help: the built-ins, then every key in two columns (one when the terminal is narrow). */
const helpLines = (width: number) => {
  const commands = BUILTINS.map((b) => clip(`${`/${b.name}`.padEnd(9)}${b.description}`, width));
  const columns = width >= 72 ? 2 : 1;
  const column = Math.floor(width / columns);
  const keys = KEYS.map(([key, does]) => clip(`${key.padEnd(10)} ${does}`, column - 1));
  const rows: Array<string> = [];
  for (let i = 0; i < keys.length; i += columns) {
    rows.push(
      keys
        .slice(i, i + columns)
        .map((cell) => cell.padEnd(column))
        .join("")
        .trimEnd(),
    );
  }
  return [...commands, "", ...rows];
};

/** The footer's hints, most useful first; /help lists every key. */
const FOOTER_HINTS = ["@ files", "/ commands", "Shift+Tab mode", "Ctrl+P model", "Ctrl+C quit"];

/** As many hints as fit in `room` columns, whole: a narrow terminal drops the last ones. */
const fitHints = (hints: ReadonlyArray<string>, room: number) => {
  let line = "";
  for (const hint of hints) {
    const next = line === "" ? hint : `${line} · ${hint}`;
    if (next.length > room) break;
    line = next;
  }
  return line;
};

type Overlay = "model" | "commands" | "files";

/**
 * The chat screen. Keys: Enter sends, `/` opens the command list and `@` the file list (Up/Down
 * move, Enter or Tab picks; in the command list Enter runs the command and Tab inserts it to
 * add arguments; Backspace in an empty filter backs out), Esc closes a list, leaves a
 * deny note, dismisses /help, or stops a reply, in that order. With an approval open, Left/Right
 * move between Allow, Always, and Deny, and Enter picks (Allow is picked when it opens); y / a / n
 * answer at once. Its keys count once it has been visible APPROVAL_ARM_MS. Up/Down
 * and PgUp/PgDn scroll its diff.
 * Shift+Tab cycles the permission mode, Ctrl+P picks a model, Ctrl+E exports the chat as
 * Markdown, Ctrl+C quits (stopping a reply first, so it is saved as interrupted). `/name args`
 * runs a built-in (commands.ts), a custom command, or a skill; an unknown name shows an error
 * and sends nothing.
 */
export const App = ({ bridge }: { readonly bridge: ChatBridge }) => {
  const [messages, setMessages] = useState<ReadonlyArray<UiMessage>>(bridge.history);
  const [model, setModel] = useState(bridge.initialModel);
  const [streaming, setStreaming] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState(0);
  // True while text is arriving: the reply itself shows progress, so the working row hides
  // until the text goes quiet for WORKING_IDLE_MS.
  const [textFlowing, setTextFlowing] = useState(false);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onTurnEvent = useCallback((event: UiEvent | undefined) => {
    clearTimeout(quietTimer.current);
    const text = event?.type === "text";
    setTextFlowing(text);
    if (text) quietTimer.current = setTimeout(() => setTextFlowing(false), WORKING_IDLE_MS);
  }, []);
  useEffect(() => () => clearTimeout(quietTimer.current), []);
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  // The composer is set imperatively: a controlled `value` loses a keystroke typed just before
  // Enter (the typed state and the cleared state batch to the same value, so React skips it).
  const input = useRef<InputRenderable>(null);
  const setDraft = useCallback((text: string) => {
    if (input.current) input.current.value = text;
  }, []);
  // /help's lines are laid out at render, so they follow a resize.
  const [notice, setNotice] = useState<
    { error: boolean; lines: ReadonlyArray<string> } | "help" | undefined
  >();
  // Custom commands and skills that didn't load cleanly: said once, unless something else is
  // already showing there.
  useEffect(() => {
    bridge.loadWarnings().then(
      (lines) => {
        if (lines.length > 0) setNotice((shown) => shown ?? { error: false, lines });
      },
      () => setStatus("Couldn't load the custom commands and skills."),
    );
  }, [bridge]);
  const [mode, setMode] = useState<UiMode>("default");
  useEffect(() => bridge.watchMode(setMode), [bridge]);
  const answer = useCallback(
    (id: string, decision: UiDecision) => {
      bridge.answer(id, decision).catch(() => setStatus("Couldn't answer the request."));
    },
    [bridge],
  );
  const approvals = useApproval({ input, setDraft, answer });
  const { approval, noting } = approvals;
  const { open: openApproval, cancel: cancelApproval, close: closeApproval } = approvals;
  const [chatId, setChatId] = useState(bridge.chatId);
  const current = useRef<AsyncIterator<UiEvent> | undefined>(undefined);
  const { width, height } = useTerminalDimensions();

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
      setTurnStartedAt(Date.now());
      onTurnEvent(undefined);
      setMessages((ms) => [
        ...ms,
        { role: "user", text, tools: [] },
        { role: "assistant", text: "", tools: [] },
      ]);
      try {
        // The typed text: the bridge attaches the `@path` files for the model.
        const it = bridge.send(text, turnModel)[Symbol.asyncIterator]();
        current.current = it;
        for (let next = await it.next(); !next.done; next = await it.next()) {
          const event = next.value;
          onTurnEvent(event);
          if (event.type === "approval") {
            // A list open for the draft closes, so its filter can't answer the panel.
            setOverlay(undefined);
            openApproval(event.request);
          } else if (event.type === "approval-cancelled") {
            cancelApproval(event.id);
          }
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
        closeApproval();
        // The turn can end after the screen is gone (quit mid-reply); a destroyed input throws.
        if (input.current && !input.current.isDestroyed) input.current.focus();
      }
    },
    [bridge, model, streaming, setDraft, openApproval, cancelApproval, closeApproval, onTurnEvent],
  );

  const runBuiltin = (name: string, args: string) => {
    switch (name) {
      case "help":
        return setNotice("help");
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
        return setOverlay("model");
      case "mode":
        if (args === "")
          return setNotice({ error: false, lines: [`Mode: ${mode}. /mode ${MODES.join("|")}`] });
        if (!isMode(args)) {
          return setNotice({
            error: true,
            lines: [`Unknown mode "${args}". Modes: ${MODES.join(", ")}.`],
          });
        }
        setMode(args);
        return bridge.setMode(args).catch(() => setStatus("Couldn't change the mode."));
      case "export":
        return bridge.exportMarkdown().then(setStatus, () => setStatus("Export failed."));
      case "quit":
        return stop().then(bridge.quit, bridge.quit);
    }
  };

  /** Enter in the composer: a slash command, or a message. */
  const submit = (text: string) => {
    if (approvals.submitNote(text)) return;
    if (text.trim() === "/") return setOverlay("commands");
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
        if (expansion === undefined) {
          setNotice({
            error: true,
            lines: [`Unknown command /${slash.name}. Type / for the list.`],
          });
        } else if ("error" in expansion) {
          setNotice({ error: true, lines: [expansion.error] });
        } else {
          void send(expansion.text, expansion.model ?? model);
        }
      },
      () => setNotice({ error: true, lines: [`Couldn't load /${slash.name}.`] }),
    );
  };

  const identity = useCallback((list: PickerList) => list, []);

  /** Closes a list and gives the composer focus back (the `focused` prop alone doesn't). */
  const closeOverlay = () => {
    setOverlay(undefined);
    input.current?.focus();
  };

  /** Backspace in a list's empty filter: close it and take back the `/` or `@` that opened it. */
  const backOut = (trigger: string) => () => {
    const draft = input.current?.value ?? "";
    if (draft.endsWith(trigger)) setDraft(draft.slice(0, -trigger.length));
    closeOverlay();
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

  const loadFileItems = useCallback(async () => {
    const paths = await bridge.listFiles();
    return { items: paths.map((p) => ({ value: p, label: p })), available: true };
  }, [bridge]);

  const { panel } = approvals;

  // On a short terminal the notice is cut to what fits beside two rows of the conversation,
  // its last row saying how much is left out. Its text can quote a command's file and model.
  const noticeLines = (lines: ReadonlyArray<string>) => {
    const room = Math.max(1, height - 7);
    if (lines.length <= room) return lines.map(printable);
    const kept = lines.slice(0, room - 1).map(printable);
    return [...kept, `… ${lines.length - kept.length} more lines; make the terminal taller`];
  };
  const shownNotice =
    notice === "help"
      ? { error: false, lines: noticeLines(helpLines(width - 2)) }
      : notice
        ? { error: notice.error, lines: noticeLines(notice.lines) }
        : undefined;

  useKeyboard((key) => {
    if (!overlay && approvals.handleKey(key)) return;
    if (key.name === "tab" && key.shift && !overlay) {
      // yolo isn't in the cycle (only --dangerously-skip-permissions sets it), so Shift+Tab from
      // yolo goes to default and can't come back.
      const next = MODES[(MODES.indexOf(mode as (typeof MODES)[number]) + 1) % MODES.length];
      if (next === undefined) return;
      setMode(next);
      bridge.setMode(next).catch(() => setStatus("Couldn't change the mode."));
    } else if (key.ctrl && key.name === "c") {
      stop().then(bridge.quit, bridge.quit);
    } else if (key.name === "escape") {
      if (overlay) closeOverlay();
      else if (approval && noting) approvals.leaveNote();
      else if (notice) setNotice(undefined);
      else stop().catch(() => setStatus("Couldn't stop the reply."));
    } else if (key.ctrl && key.name === "p" && !streaming && !overlay) {
      setOverlay("model");
    } else if (key.ctrl && key.name === "e" && !streaming && !overlay) {
      bridge.exportMarkdown().then(setStatus, () => setStatus("Export failed."));
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexShrink={0} paddingLeft={1}>
        <text fg={theme.accent}>orx</text>
        <text fg={theme.muted} wrapMode="none" flexShrink={1}>{`  ${model}`}</text>
        {/* The path gives way first, from the left, so its last directories stay. */}
        <text fg={theme.faint} wrapMode="none" flexShrink={0}>
          {headerPath(
            bridge.workspace,
            // What's left beside the other parts: padding, the wordmark, the model, and the chat id
            // with a gap before it.
            width - 1 - "orx".length - `  ${model}`.length - `  chat ${chatId.slice(0, 8)}`.length,
          )}
        </text>
        <box flexGrow={1} />
        <text fg={theme.faint} flexShrink={0} paddingLeft={1}>
          {`chat ${chatId.slice(0, 8)}`}
        </text>
      </box>
      <MessageList messages={messages} streaming={streaming} mode={mode} />
      {shownNotice ? (
        <box flexDirection="column" flexShrink={0} paddingLeft={1}>
          {shownNotice.lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines, never reordered
            <text key={i} fg={shownNotice.error ? theme.error : theme.muted}>
              {line === "" ? " " : line}
            </text>
          ))}
        </box>
      ) : null}
      {panel ? (
        <ApprovalPanel
          head={panel.head}
          body={panel.body}
          offset={panel.offset}
          rows={panel.rows}
          choices={panel.choices}
          choice={approvals.choice}
        />
      ) : null}
      {streaming && !approval ? (
        textFlowing ? (
          // The row keeps its place while text streams, so the conversation doesn't jump.
          <box height={1} flexShrink={0} />
        ) : (
          <Working label={workingLabel(messages.at(-1))} startedAt={turnStartedAt} />
        )
      ) : null}
      <box
        border
        flexShrink={0}
        borderColor={streaming ? theme.faint : theme.border}
        paddingLeft={1}
      >
        <input
          focused={!overlay && (!approval || noting)}
          ref={input}
          placeholder={
            noting
              ? "Why not? Enter sends (a note is optional)"
              : approval
                ? "Waiting for your answer above"
                : streaming
                  ? "Replying… Esc stops"
                  : "Message"
          }
          onInput={(value) => {
            // A note for the model isn't a message: no commands, no attachments.
            if (noting || approval) return;
            if (value === "/") setOverlay("commands");
            else if (opensMentionPicker(value)) setOverlay("files");
          }}
          onSubmit={(value) => {
            if (typeof value === "string") submit(value);
          }}
        />
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={1}>
        <text fg={theme.faint} wrapMode="none" flexShrink={1}>
          {approval
            ? noting
              ? "Enter deny with this note · Esc back"
              : `Enter pick · ←→ choose · y / ${approval.canAlways ? "a / " : ""}n · ${panel && panel.maxOffset > 0 ? "↑↓ scroll · " : ""}Esc stop`
            : (status ??
              fitHints(FOOTER_HINTS, width - 1 - (mode === "default" ? 0 : mode.length + 1)))}
        </text>
        <box flexGrow={1} />
        {mode === "default" ? null : (
          <text fg={theme.muted} flexShrink={0} paddingLeft={1}>
            {mode}
          </text>
        )}
      </box>
      {overlay === "model" ? (
        <ModelPicker
          load={bridge.listModels}
          current={model}
          onPick={(id) => {
            setModel(id);
            closeOverlay();
          }}
          onBack={closeOverlay}
        />
      ) : null}
      {overlay === "commands" ? (
        <Picker
          title=" Commands "
          placeholder="Search commands and skills"
          loadingText="Loading commands…"
          unavailableText="Couldn't load commands and skills. Esc to close."
          showDescription
          load={loadCommandItems}
          toList={identity}
          onPick={(name, typed) => {
            // `mode plan` in the filter picks /mode; the words after the name are its arguments.
            const [first = "", ...rest] = typed.trim().split(/\s+/);
            closeOverlay();
            setDraft("");
            submit(`/${name}${first === name && rest.length > 0 ? ` ${rest.join(" ")}` : ""}`);
          }}
          onComplete={(name) => {
            setDraft(`/${name} `);
            closeOverlay();
          }}
          onNoMatch={(typed) => {
            closeOverlay();
            setDraft("");
            // Reported as an unknown command, like typing it in full.
            if (typed.trim() !== "") submit(`/${typed.trim()}`);
          }}
          onBack={backOut("/")}
        />
      ) : null}
      {overlay === "files" ? (
        <Picker
          title=" Files "
          placeholder="Search files"
          loadingText="Listing files…"
          unavailableText="Couldn't list the workspace's files. Esc to close."
          cut="start"
          load={loadFileItems}
          toList={identity}
          rankItems={rankFiles}
          onPick={(path) => {
            setDraft(insertMention(input.current?.value ?? "", path));
            closeOverlay();
          }}
          onBack={backOut("@")}
        />
      ) : null}
    </box>
  );
};

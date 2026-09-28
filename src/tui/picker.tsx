import type { InputRenderable, KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { printable } from "./printable";
import { theme } from "./theme";

export interface PickerItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface PickerList {
  readonly items: ReadonlyArray<PickerItem>;
  readonly available: boolean;
}

/** Items containing every word of the query, those whose label starts with the query first. */
export const rank = (items: ReadonlyArray<PickerItem>, query: string) => {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter((w) => w !== "");
  const matches = items.filter((item) => {
    const hay = `${item.label} ${item.description ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (q === "") return matches;
  // A command's label is `/name`; typing `name` should still rank it first.
  const prefixed = (item: PickerItem) =>
    item.label.toLowerCase().replace(/^\//, "").startsWith(q.replace(/^\//, ""));
  return [...matches.filter(prefixed), ...matches.filter((item) => !prefixed(item))];
};

/** The most rows the list shows; more scroll. */
export const PICKER_MAX_ROWS = 10;

/** Rows the rest of the screen keeps: the header, the overlay's frame and input, the composer and footer. */
const RESERVED_ROWS = 9;

/** `text` in at most `width` columns, cut at the end (or the start, for paths) with `…`. */
export const clip = (text: string, width: number, cut: "start" | "end" = "end") => {
  if (text.length <= width) return text;
  if (width <= 1) return "…".slice(0, Math.max(0, width));
  return cut === "end" ? `${text.slice(0, width - 1)}…` : `…${text.slice(text.length - width + 1)}`;
};

const isPickKey = (key: KeyEvent) =>
  (key.name === "tab" && !key.shift) ||
  key.name === "return" ||
  key.name === "linefeed" ||
  key.name === "kpenter";

/**
 * An overlay list just above the composer, sized to its content: type to filter, Up/Down to
 * move, Enter or Tab to pick the highlighted item (Tab calls `onComplete` when given), Enter
 * with no match calls `onNoMatch` when given, Backspace in an empty filter backs out
 * (`onBack`), Esc closes (app.tsx owns Esc). `load` runs once per open.
 */
export const Picker = <T,>({
  title,
  placeholder,
  loadingText,
  unavailableText,
  showDescription = false,
  cut = "end",
  load,
  toList,
  onPick,
  onComplete,
  onNoMatch,
  onBack,
  rankItems = rank,
}: {
  readonly title: string;
  readonly placeholder: string;
  readonly loadingText: string;
  readonly unavailableText: string;
  readonly showDescription?: boolean;
  /** Where a label too long for the row is cut: "start" keeps a path's file name. */
  readonly cut?: "start" | "end";
  readonly load: () => Promise<T>;
  /** Maps what `load` resolves to (kept out of `load` so the list shows in the same tick). */
  readonly toList: (loaded: T) => PickerList;
  /** The highlighted item's value, and the filter as typed (a command's arguments follow it). */
  readonly onPick: (value: string, typed: string) => void;
  /** Tab on an item, when it should do something other than pick (insert a command to edit). */
  readonly onComplete?: (value: string) => void;
  /** Enter with nothing matching the filter. Without it, Enter does nothing. */
  readonly onNoMatch?: (typed: string) => void;
  /** Backspace with nothing typed: close, and take back what opened the list. */
  readonly onBack: () => void;
  /** How the query filters and orders the items (default: `rank`). */
  readonly rankItems?: (
    items: ReadonlyArray<PickerItem>,
    query: string,
  ) => ReadonlyArray<PickerItem>;
}) => {
  const [items, setItems] = useState<ReadonlyArray<PickerItem> | undefined>(undefined);
  const [available, setAvailable] = useState(true);
  const [query, setQuery] = useState("");
  const input = useRef<InputRenderable>(null);
  // Mirrored in a ref: a key handled before React re-renders must see the latest highlight.
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const { width, height } = useTerminalDimensions();
  // The list's window: as many rows as fit, its first row moved only when the highlight would
  // leave it.
  const rows = Math.max(1, Math.min(PICKER_MAX_ROWS, height - RESERVED_ROWS));
  const [start, setStart] = useState(0);
  const select = (index: number) => {
    selectedRef.current = index;
    setSelected(index);
    setStart((first) => (index < first ? index : index >= first + rows ? index - rows + 1 : first));
  };

  useEffect(() => {
    load().then(
      (loaded) => {
        const list = toList(loaded);
        setItems(list.items);
        setAvailable(list.available);
      },
      () => setAvailable(false),
    );
  }, [load, toList]);

  const matches = useMemo(() => rankItems(items ?? [], query), [items, query, rankItems]);

  const filter = (value: string) => {
    setQuery(value);
    select(0);
  };

  // useKeyboard unsubscribes in a passive effect, which can run after the next key: a closed
  // list must not pick on the Enter meant for the composer. Layout cleanup runs at unmount.
  const open = useRef(true);
  useLayoutEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  useKeyboard((key) => {
    if (!open.current) return;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      const next = selectedRef.current + (key.name === "up" ? -1 : 1);
      select(Math.max(0, Math.min(matches.length - 1, next)));
    } else if (isPickKey(key)) {
      key.preventDefault();
      // The filter may hold a key React hasn't rendered yet: rank what's typed now.
      const typed = input.current?.value ?? query;
      const picked =
        typed === query ? matches[selectedRef.current] : rankItems(items ?? [], typed)[0];
      if (picked === undefined) {
        if (key.name !== "tab" && items !== undefined) onNoMatch?.(typed);
      } else if (key.name === "tab" && onComplete) onComplete(picked.value);
      else onPick(picked.value, typed);
    } else if (key.name === "backspace" && (input.current?.value ?? "") === "") {
      key.preventDefault();
      onBack();
    }
  });

  // A resize can leave the stored window short of the highlight; keep it in view.
  const first = Math.max(
    0,
    Math.min(selected >= start + rows ? selected - rows + 1 : start, matches.length - rows),
  );
  const shown = matches.slice(first, first + rows);

  // Two columns: the frame, then a marker before each row.
  const room = Math.max(8, width - 6);
  const labelWidth = showDescription
    ? Math.min(
        matches.reduce((widest, m) => Math.max(widest, m.label.length), 0),
        Math.floor(room / 2),
      )
    : room;

  const status = !available ? (
    <text fg={theme.error}>{clip(unavailableText, room + 2)}</text>
  ) : items === undefined ? (
    <text fg={theme.muted}>{loadingText}</text>
  ) : matches.length === 0 ? (
    <text fg={theme.muted}>{query.trim() === "" ? "Nothing to list" : "No matches"}</text>
  ) : null;

  return (
    <box
      position="absolute"
      bottom={4}
      left={1}
      right={1}
      border
      borderColor={theme.accent}
      title={title}
      bottomTitle={matches.length > rows ? ` ${selected + 1} of ${matches.length} ` : undefined}
      bottomTitleAlignment="right"
      flexDirection="column"
      backgroundColor={theme.selectedBg}
    >
      <input focused ref={input} placeholder={placeholder} onInput={filter} onChange={filter} />
      {status ??
        shown.map((item, i) => {
          const isSelected = first + i === selected;
          // Paths, frontmatter, and model names come from outside orx.
          const label = clip(printable(item.label), labelWidth, cut);
          const description = showDescription ? printable(item.description ?? "") : "";
          return (
            <box
              key={item.value}
              flexDirection="row"
              backgroundColor={isSelected ? theme.border : theme.selectedBg}
            >
              <text fg={theme.text} wrapMode="none">
                {`${isSelected ? "▶" : " "} ${label.padEnd(labelWidth)}`}
              </text>
              {description === "" ? null : (
                <text fg={theme.muted} wrapMode="none">
                  {`  ${clip(description, room - labelWidth - 2)}`}
                </text>
              )}
            </box>
          );
        })}
    </box>
  );
};

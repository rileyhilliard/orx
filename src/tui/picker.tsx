import { useEffect, useMemo, useState } from "react";
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

/**
 * An overlay list: type to filter, arrows to move, Enter to pick, Esc to close (app.tsx owns
 * Esc). `load` runs once per open; `onPick(undefined)` means nothing matched.
 */
export const Picker = <T,>({
  title,
  placeholder,
  loadingText,
  unavailableText,
  showDescription = false,
  load,
  toList,
  onPick,
}: {
  readonly title: string;
  readonly placeholder: string;
  readonly loadingText: string;
  readonly unavailableText: string;
  readonly showDescription?: boolean;
  readonly load: () => Promise<T>;
  /** Maps what `load` resolves to (kept out of `load` so the list shows in the same tick). */
  readonly toList: (loaded: T) => PickerList;
  readonly onPick: (value: string | undefined) => void;
}) => {
  const [items, setItems] = useState<ReadonlyArray<PickerItem> | undefined>(undefined);
  const [available, setAvailable] = useState(true);
  const [query, setQuery] = useState("");

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

  const matches = useMemo(() => rank(items ?? [], query).slice(0, 200), [items, query]);

  return (
    <box
      position="absolute"
      top={2}
      left={4}
      right={4}
      bottom={4}
      border
      borderColor={theme.accent}
      title={title}
      flexDirection="column"
      backgroundColor={theme.selectedBg}
    >
      <input
        focused
        placeholder={placeholder}
        onInput={setQuery}
        onChange={setQuery}
        onSubmit={(value) => {
          const typed = typeof value === "string" ? value : query;
          onPick(rank(items ?? [], typed)[0]?.value);
        }}
      />
      {items === undefined && available ? (
        <text fg={theme.muted}>{loadingText}</text>
      ) : !available ? (
        <text fg={theme.error}>{unavailableText}</text>
      ) : (
        <select
          flexGrow={1}
          options={matches.map((m) => ({
            name: m.label,
            description: m.description ?? "",
            value: m.value,
          }))}
          showDescription={showDescription}
          selectedBackgroundColor={theme.border}
          textColor={theme.text}
          descriptionColor={theme.muted}
          onSelect={(_, option) => onPick(option?.value as string | undefined)}
        />
      )}
    </box>
  );
};

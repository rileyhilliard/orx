import { useEffect, useMemo, useState } from "react";
import { theme } from "./theme";
import type { UiModel } from "./types";

const rank = (models: ReadonlyArray<UiModel>, query: string) => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
  return models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
};

/** Type to filter, arrows to move, Enter to pick, Esc to close. */
export const ModelPicker = ({
  load,
  current,
  onPick,
}: {
  readonly load: () => Promise<{
    readonly models: ReadonlyArray<UiModel>;
    readonly available: boolean;
  }>;
  readonly current: string;
  readonly onPick: (id: string | undefined) => void;
}) => {
  const [models, setModels] = useState<ReadonlyArray<UiModel> | undefined>(undefined);
  const [available, setAvailable] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    load().then(
      (list) => {
        setModels(list.models);
        setAvailable(list.available);
      },
      () => setAvailable(false),
    );
  }, [load]);

  const matches = useMemo(() => rank(models ?? [], query).slice(0, 200), [models, query]);

  return (
    <box
      position="absolute"
      top={2}
      left={4}
      right={4}
      bottom={4}
      border
      borderColor={theme.accent}
      title=" Model "
      flexDirection="column"
      backgroundColor={theme.selectedBg}
    >
      <input
        focused
        placeholder={`Search models (current: ${current})`}
        onInput={setQuery}
        onChange={setQuery}
        onSubmit={(value) => {
          const typed = typeof value === "string" ? value : query;
          onPick(rank(models ?? [], typed)[0]?.id);
        }}
      />
      {models === undefined ? (
        <text fg={theme.muted}>Loading models…</text>
      ) : !available ? (
        <text fg={theme.error}>Couldn't fetch the models list. Esc to close.</text>
      ) : (
        <select
          flexGrow={1}
          options={matches.map((m) => ({ name: m.id, description: m.name, value: m.id }))}
          showDescription={false}
          selectedBackgroundColor={theme.border}
          textColor={theme.text}
          onSelect={(_, option) => onPick(option?.value as string | undefined)}
        />
      )}
    </box>
  );
};

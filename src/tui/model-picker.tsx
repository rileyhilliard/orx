import { Picker } from "./picker";
import type { UiModel } from "./types";

const toList = (list: {
  readonly models: ReadonlyArray<UiModel>;
  readonly available: boolean;
}) => ({
  available: list.available,
  items: list.models.map((m) => ({ value: m.id, label: m.id, description: m.name })),
});

/** The model list in the shared picker. Type to filter, Up/Down to move, Enter to pick, Esc to close. */
export const ModelPicker = ({
  load,
  current,
  onPick,
  onBack,
}: {
  readonly load: () => Promise<{
    readonly models: ReadonlyArray<UiModel>;
    readonly available: boolean;
  }>;
  readonly current: string;
  readonly onPick: (id: string) => void;
  readonly onBack: () => void;
}) => {
  return (
    <Picker
      title=" Model "
      placeholder={`Search models (current: ${current})`}
      loadingText="Loading models…"
      unavailableText="Couldn't fetch the models list. Esc to close."
      load={load}
      toList={toList}
      onPick={onPick}
      onBack={onBack}
    />
  );
};

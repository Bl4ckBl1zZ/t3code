import type { RuntimeMode } from "@t3tools/contracts";
import { HERMES_RUNTIME_MODE_CHOICES, hermesRuntimeModeChoice } from "@t3tools/shared/runtimeModes";

export interface RuntimeModeMenuOption {
  readonly mode: RuntimeMode;
  readonly title: string;
}

/** Mobile labels the first mode "Approve actions" rather than web's "Supervised". */
const DEFAULT_RUNTIME_MODE_MENU_OPTIONS: ReadonlyArray<RuntimeModeMenuOption> = [
  { mode: "approval-required", title: "Approve actions" },
  { mode: "auto-accept-edits", title: "Auto-accept edits" },
  { mode: "auto", title: "Auto" },
  { mode: "full-access", title: "Full access" },
];

const HERMES_RUNTIME_MODE_MENU_OPTIONS: ReadonlyArray<RuntimeModeMenuOption> =
  HERMES_RUNTIME_MODE_CHOICES.map((choice) => ({ mode: choice.mode, title: choice.label }));

/**
 * The Runtime menu entry for a thread. T3 Work (Hermes) threads get the two
 * options Hermes actually distinguishes; everything else gets the four generic
 * modes. A mode outside the offered set still has to read as something, since a
 * thread can carry one in from wherever it was created.
 */
export function runtimeModeMenu(input: {
  readonly isHermes: boolean;
  readonly runtimeMode: RuntimeMode;
}): {
  readonly options: ReadonlyArray<RuntimeModeMenuOption>;
  readonly selected: RuntimeModeMenuOption;
} {
  if (input.isHermes) {
    const mode = hermesRuntimeModeChoice(input.runtimeMode).mode;
    return {
      options: HERMES_RUNTIME_MODE_MENU_OPTIONS,
      selected: HERMES_RUNTIME_MODE_MENU_OPTIONS.find((option) => option.mode === mode)!,
    };
  }
  return {
    options: DEFAULT_RUNTIME_MODE_MENU_OPTIONS,
    selected:
      DEFAULT_RUNTIME_MODE_MENU_OPTIONS.find((option) => option.mode === input.runtimeMode) ??
      DEFAULT_RUNTIME_MODE_MENU_OPTIONS[0]!,
  };
}

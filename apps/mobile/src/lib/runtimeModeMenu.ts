import type { RuntimeMode } from "@t3tools/contracts";

export interface RuntimeModeMenuOption {
  readonly mode: RuntimeMode;
  readonly title: string;
  /** One word for the composer's compact settings summary pill. */
  readonly shortLabel: string;
}

/** Mobile labels the first mode "Approve actions" rather than web's "Supervised". */
const DEFAULT_RUNTIME_MODE_MENU_OPTIONS: ReadonlyArray<RuntimeModeMenuOption> = [
  { mode: "approval-required", title: "Approve actions", shortLabel: "Approve" },
  { mode: "auto-accept-edits", title: "Auto-accept edits", shortLabel: "Edits" },
  { mode: "auto", title: "Auto", shortLabel: "Auto" },
  { mode: "full-access", title: "Full access", shortLabel: "Full" },
];

/**
 * The Runtime menu entry for a thread: the modes the provider supports (all
 * four when it lists none). A mode outside the offered set still has to read
 * as something, since a thread can carry one in from wherever it was created;
 * it reads as the first offered mode, which is the mode the server runs it in.
 */
export function runtimeModeMenu(input: {
  readonly runtimeMode: RuntimeMode;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
}): {
  readonly options: ReadonlyArray<RuntimeModeMenuOption>;
  readonly selected: RuntimeModeMenuOption;
} {
  const supported = input.supportedRuntimeModes;
  const supportedOptions =
    supported === undefined || supported.length === 0
      ? []
      : DEFAULT_RUNTIME_MODE_MENU_OPTIONS.filter((option) => supported.includes(option.mode));
  const options =
    supportedOptions.length > 0 ? supportedOptions : DEFAULT_RUNTIME_MODE_MENU_OPTIONS;
  return {
    options,
    selected: options.find((option) => option.mode === input.runtimeMode) ?? options[0]!,
  };
}

import type { ProviderDriverKind, RuntimeMode } from "@t3tools/contracts";
import { HERMES_RUNTIME_MODE_CHOICES, hermesRuntimeModeChoice } from "@t3tools/shared/runtimeModes";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

import { HERMES_DRIVER_KIND } from "../../t3WorkProject";

const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

export interface RuntimeModeOption {
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

const defaultRuntimeModeOptions: ReadonlyArray<RuntimeModeOption> = runtimeModeOptions.map(
  (mode) => ({ mode, ...runtimeModeConfig[mode] }),
);

const hermesRuntimeModeOptions: ReadonlyArray<RuntimeModeOption> = HERMES_RUNTIME_MODE_CHOICES.map(
  (choice) => ({ ...choice, icon: runtimeModeConfig[choice.mode].icon }),
);

/**
 * The access picker a thread gets. Hermes is given the modes it actually
 * distinguishes, with copy that names what its own gate does; a mode it does
 * not offer still has to render, since a thread can carry one in from wherever
 * it was created.
 */
export function resolveRuntimeModePicker(
  driverKind: ProviderDriverKind,
  runtimeMode: RuntimeMode,
): { options: ReadonlyArray<RuntimeModeOption>; selected: RuntimeModeOption } {
  if (driverKind === HERMES_DRIVER_KIND) {
    const selectedMode = hermesRuntimeModeChoice(runtimeMode).mode;
    return {
      options: hermesRuntimeModeOptions,
      selected: hermesRuntimeModeOptions.find((option) => option.mode === selectedMode)!,
    };
  }
  return {
    options: defaultRuntimeModeOptions,
    selected: { mode: runtimeMode, ...runtimeModeConfig[runtimeMode] },
  };
}

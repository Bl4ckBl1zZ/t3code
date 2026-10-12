import type { RuntimeMode } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
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

/**
 * The access picker a thread gets. Providers offer the modes their snapshot
 * lists as supported (all of them when it lists none); a carried-in mode
 * outside that set shows as the first supported one, which is the mode the
 * server runs it in.
 */
export function resolveRuntimeModePicker(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes?: ReadonlyArray<RuntimeMode>,
): { options: ReadonlyArray<RuntimeModeOption>; selected: RuntimeModeOption } {
  if (supportedRuntimeModes !== undefined && supportedRuntimeModes.length > 0) {
    const options = defaultRuntimeModeOptions.filter((option) =>
      supportedRuntimeModes.includes(option.mode),
    );
    const selected = options.find((option) => option.mode === runtimeMode) ?? options[0];
    if (selected !== undefined) return { options, selected };
  }
  return {
    options: defaultRuntimeModeOptions,
    selected: { mode: runtimeMode, ...runtimeModeConfig[runtimeMode] },
  };
}

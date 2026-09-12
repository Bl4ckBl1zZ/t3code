import { type ProviderDriverKind } from "@t3tools/contracts";
import {
  ACPRegistryIcon,
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  AntigravityIcon,
  HermesIcon,
  type Icon,
  OpenAI,
  OpenClawIcon,
  OpenCodeIcon,
} from "../Icons";

import {
  PROVIDER_SETTINGS_DEFINITIONS,
  type ProviderSettingsDefinition,
} from "./providerSettingsDefinitions";
export type { ProviderEnvironmentFieldDefinition } from "./providerSettingsDefinitions";

export interface ProviderClientDefinition extends ProviderSettingsDefinition {
  readonly icon: Icon;
}
const icons: Record<string, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
  grok: GrokIcon,
  antigravity: AntigravityIcon,
  hermes: HermesIcon,
  openclaw: OpenClawIcon,
  hermesAcp: HermesIcon,
  acpRegistry: ACPRegistryIcon,
  opencode: OpenCodeIcon,
};
export const PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] =
  PROVIDER_SETTINGS_DEFINITIONS.map((definition) => ({
    ...definition,
    icon: icons[definition.value]!,
  }));

export const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export const DRIVER_OPTIONS = PROVIDER_CLIENT_DEFINITIONS;
export const DRIVER_OPTION_BY_VALUE = PROVIDER_CLIENT_DEFINITION_BY_VALUE;
export type DriverOption = ProviderClientDefinition;

/**
 * Look up the driver metadata for an instance's `driver` field. Accepts
 * Returns `undefined` for fork / unknown drivers so callers can decide how
 * to render them — typically by falling back to a generic card.
 */
export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}

import {
  AntigravitySettings,
  AcpRegistrySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  HermesAcpSettings,
  HermesSettings,
  OpenClawSettings,
  OpenCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema with
 * field annotations plus provider-level presentation metadata, then renders
 * settings generically.
 */
export interface ProviderSettingsDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly settingsSchema: ProviderSettingsSchema;
  readonly environmentFields?: readonly ProviderEnvironmentFieldDefinition[];
  /** Whether this driver has a built-in default instance backed by legacy settings. */
  readonly hasDefaultInstance?: boolean;
  /**
   * Optional browser-safe default instance for built-in drivers that do not
   * have a legacy `settings.providers.<kind>` mirror. The settings page shows
   * this disabled template until the user edits it, at which point it is
   * promoted into `providerInstances`.
   */
  readonly defaultInstance?: ProviderInstanceConfig;
  /**
   * Optional short label rendered as a `variant="warning"` badge next to
   * the instance title. Used to flag drivers that still ship under an
   * early-access or preview gate — the flag is a property of the driver
   * kind (not a specific instance), so every instance of that driver —
   * built-in default or custom — advertises the same marker.
   */
  readonly badgeLabel?: string;
}

export interface ProviderEnvironmentFieldDefinition {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly sensitive?: boolean;
}

export const PROVIDER_SETTINGS_DEFINITIONS: readonly ProviderSettingsDefinition[] = [
  {
    value: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    settingsSchema: CursorSettings,
    environmentFields: [
      {
        name: "CURSOR_API_KEY",
        label: "Cursor API key",
        description: "Required by the Cursor Agent SDK.",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ],
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    settingsSchema: GrokSettings,
  },
  {
    value: ProviderDriverKind.make("hermes"),
    label: "Hermes",
    badgeLabel: "Preview",
    settingsSchema: HermesSettings,
    defaultInstance: {
      driver: ProviderDriverKind.make("hermes"),
      enabled: false,
      config: {
        endpoint: "",
        remoteAccessEnabled: false,
        profileKey: "default",
        managedServerEnabled: true,
        customModels: [],
        importEnabled: false,
        mcpEnabled: true,
        attachmentsEnabled: true,
        proactiveEnabled: true,
        voiceEnabled: false,
      },
    },
    environmentFields: [
      {
        name: "HERMES_GATEWAY_TOKEN",
        label: "Hermes gateway token",
        description:
          "Shared only with the attached gateway or a Hermes Serve process launched by T3.",
        placeholder: "Paste gateway token",
        sensitive: true,
      },
    ],
  },
  {
    value: ProviderDriverKind.make("openclaw"),
    label: "OpenClaw",
    badgeLabel: "ACP",
    settingsSchema: OpenClawSettings,
    defaultInstance: {
      driver: ProviderDriverKind.make("openclaw"),
      enabled: false,
      config: {
        binaryPath: "openclaw",
        url: "",
        tokenFile: "",
        passwordFile: "",
        session: "",
        resetSession: false,
        customModels: [],
      },
    },
  },
  {
    value: ProviderDriverKind.make("hermesAcp"),
    label: "Hermes in Code",
    badgeLabel: "ACP",
    settingsSchema: HermesAcpSettings,
    hasDefaultInstance: false,
  },
  {
    value: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    badgeLabel: "V2 Preview",
    settingsSchema: AcpRegistrySettings,
    hasDefaultInstance: false,
  },
  {
    value: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    settingsSchema: OpenCodeSettings,
  },
];

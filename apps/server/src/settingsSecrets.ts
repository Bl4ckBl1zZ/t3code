/**
 * Schema-declared settings credentials: which settings values are secrets, the secret store
 * entry each one lives under, and how each is represented on disk and to clients.
 *
 * @module settingsSecrets
 */
import {
  AcpRegistrySettings,
  AntigravitySettings,
  BitbucketSettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GitHubSettings,
  GrokSettings,
  MuseSettings,
  OpenClawSettings,
  OpenCodeSettings,
  PiSettings,
  type ServerSettings,
  UsageLimitSourceConfig,
  secretSettingsFields,
} from "@t3tools/contracts";

/**
 * On disk a saved credential is replaced by this marker and the real value lives in the secret
 * store. A client that sends the marker back means "keep what you have".
 */
export const SECRET_REDACTED = "••••••";

const providerSecretFields = new Map<string, ReadonlyArray<string>>([
  ["codex", secretSettingsFields(CodexSettings)],
  ["claudeAgent", secretSettingsFields(ClaudeSettings)],
  ["cursor", secretSettingsFields(CursorSettings)],
  ["grok", secretSettingsFields(GrokSettings)],
  ["acpRegistry", secretSettingsFields(AcpRegistrySettings)],
  ["openclaw", secretSettingsFields(OpenClawSettings)],
  ["antigravity", secretSettingsFields(AntigravitySettings)],
  ["muse", secretSettingsFields(MuseSettings)],
  ["pi", secretSettingsFields(PiSettings)],
  ["opencode", secretSettingsFields(OpenCodeSettings)],
]);
const usageLimitSecretFields = secretSettingsFields(UsageLimitSourceConfig);
const bitbucketSecretFields = secretSettingsFields(BitbucketSettings);
const gitHubSecretFields = secretSettingsFields(GitHubSettings);

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** Server hosts are case-insensitive; a patch can arrive before decoding lowercased its keys. */
const normalizeServerHost = (host: string) => host.trim().toLowerCase();

/** Secret store names predate this module; they must stay stable across releases. */
const BITBUCKET_SECRET_NAMES: Readonly<Record<string, string>> = {
  accessToken: "bitbucket-access-token",
  apiToken: "bitbucket-api-token",
};

export interface SettingsSecret {
  readonly secretName: string;
  readonly kind: "field" | "environment";
  readonly value: string;
  readonly redacted: boolean;
  readonly sensitive: boolean;
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
}

type SecretValue = Pick<SettingsSecret, "value" | "redacted">;

/** The string values a secret field holds, keyed by server host, or `null` for a plain string. */
function readSecretFieldValues(
  value: unknown,
): ReadonlyArray<readonly [serverHost: string | null, value: string]> {
  if (typeof value === "string") return [[null, value]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([serverHost, entry]) =>
    typeof entry === "string" ? [[normalizeServerHost(serverHost), entry] as const] : [],
  );
}

/** A secret field's value rebuilt from per-slot values, in the shape it was read from. */
function writeSecretFieldValues(
  original: unknown,
  values: ReadonlyArray<readonly [serverHost: string | null, value: string]>,
): unknown {
  if (typeof original === "string") return values[0]?.[1] ?? "";
  return Object.fromEntries(values.map(([serverHost, value]) => [serverHost ?? "", value]));
}

/**
 * Visits credential fields declared by schemas and dynamically sensitive environment variables.
 * Store keys and client representations stay here; callers supply only the secret operation.
 */
export function mapSettingsSecrets(
  settings: ServerSettings,
  map: (secret: SettingsSecret) => SecretValue,
): ServerSettings {
  const mapFields = <T extends object>(
    fields: T,
    secretFields: ReadonlyArray<string>,
    name: (field: string, serverHost: string | null) => string,
  ): T => {
    const next: Record<string, unknown> = { ...(fields as Record<string, unknown>) };
    for (const field of secretFields) {
      if (!(field in next)) continue;
      next[field] = writeSecretFieldValues(
        next[field],
        readSecretFieldValues(next[field]).map(([serverHost, value]) => {
          const result = map({
            secretName: name(field, serverHost),
            kind: "field",
            value,
            redacted: value === SECRET_REDACTED,
            sensitive: true,
          });
          return [serverHost, result.redacted ? SECRET_REDACTED : result.value] as const;
        }),
      );
    }
    return next as T;
  };

  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const config = instance.config;
      return [
        instanceId,
        {
          ...instance,
          ...(config !== null && typeof config === "object" && !Array.isArray(config)
            ? {
                config: mapFields(
                  config as Record<string, unknown>,
                  providerSecretFields.get(instance.driver) ?? [],
                  (field, serverHost) =>
                    `provider-config-${encode(instanceId)}-${encode(instance.driver)}-${encode(field)}` +
                    (serverHost === null ? "" : `-${encode(serverHost)}`),
                ),
              }
            : {}),
          ...(instance.environment
            ? {
                environment: instance.environment.map((variable) => {
                  const result = map({
                    secretName: `provider-env-${encode(instanceId)}-${encode(variable.name)}`,
                    kind: "environment",
                    value: variable.value,
                    redacted: variable.valueRedacted === true,
                    sensitive: variable.sensitive,
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                  });
                  const { valueRedacted: _omit, ...rest } = variable;
                  return {
                    ...rest,
                    value: result.value,
                    ...(result.redacted ? { valueRedacted: true } : {}),
                  };
                }),
              }
            : {}),
        },
      ];
    }),
  ) as ServerSettings["providerInstances"];

  const usageLimitSources = Object.fromEntries(
    Object.entries(settings.usageLimitSources).map(([id, source]) => [
      id,
      mapFields(
        source,
        usageLimitSecretFields,
        (field, serverHost) =>
          `usage-limit-source-${encode(id)}` +
          (field === "managementKey" && serverHost === null
            ? ""
            : `-${encode(field)}${serverHost === null ? "" : `-${encode(serverHost)}`}`),
      ),
    ]),
  ) as ServerSettings["usageLimitSources"];

  const bitbucket = mapFields(
    settings.bitbucket,
    bitbucketSecretFields,
    (field) => BITBUCKET_SECRET_NAMES[field] ?? `bitbucket-${encode(field)}`,
  );

  const github =
    settings.github === undefined
      ? undefined
      : mapFields(settings.github, gitHubSecretFields, (field, serverHost) =>
          field === "tokens" && serverHost !== null
            ? `github-token-${encode(serverHost)}`
            : `github-${encode(field)}${serverHost === null ? "" : `-${encode(serverHost)}`}`,
        );

  return {
    ...settings,
    providerInstances,
    usageLimitSources,
    bitbucket,
    ...(github === undefined ? {} : { github }),
  };
}

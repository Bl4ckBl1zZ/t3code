import {
  HermesSettings,
  HermesSkillsError,
  type HermesGatewayCompatibility,
  type HermesGatewaySkillsInspectResult,
  type HermesGatewaySkillsListResult,
  type HermesGatewaySkillsReloadResult,
  type HermesGatewaySkillsSearchResult,
  type HermesSkillEntry,
  type HermesSkillsCapabilities,
  type HermesSkillsInspectInput,
  type HermesSkillsInspectResult as HermesSkillsInspectResponse,
  type HermesSkillsListResult,
  type HermesSkillsProviderProjection,
  type HermesSkillsReloadInput,
  type HermesSkillsReloadResponse,
  type HermesSkillsSearchInput,
  type HermesSkillsSearchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  HermesGatewayClient,
  HermesGatewayMutationIndeterminateError,
  HermesGatewayMutationsBlockedError,
  type HermesGatewayMutationOptions,
  type HermesGatewayReadOptions,
} from "./HermesGatewayClient.ts";

interface HermesSkillsGatewayClient {
  readonly compatibility: HermesGatewayCompatibility | undefined;
  connect(): Promise<HermesGatewayCompatibility>;
  hasCapability(capability: string): boolean;
  listSkills(
    options?: Omit<HermesGatewayReadOptions, "requiredCapability">,
  ): Promise<HermesGatewaySkillsListResult>;
  searchSkills(
    query: string,
    options?: Omit<HermesGatewayReadOptions, "requiredCapability">,
  ): Promise<HermesGatewaySkillsSearchResult>;
  inspectSkill(
    name: string,
    options?: Omit<HermesGatewayReadOptions, "requiredCapability">,
  ): Promise<HermesGatewaySkillsInspectResult>;
  reloadSkills(
    options: Omit<HermesGatewayMutationOptions, "requiredCapability">,
  ): Promise<HermesGatewaySkillsReloadResult>;
  close(): void;
}

interface HermesSkillsProviderConfig {
  readonly providerInstanceId: string;
  readonly displayName: string;
  readonly profileKey: string;
  readonly endpoint: string;
  readonly token: string;
}

export interface HermesSkillsOptions {
  readonly clientFactory?: (input: {
    readonly endpoint: string;
    readonly authToken: string;
  }) => HermesSkillsGatewayClient;
}

export interface HermesSkillsShape {
  readonly list: () => Effect.Effect<HermesSkillsListResult, HermesSkillsError>;
  readonly search: (
    input: HermesSkillsSearchInput,
  ) => Effect.Effect<HermesSkillsSearchResult, HermesSkillsError>;
  readonly inspect: (
    input: HermesSkillsInspectInput,
  ) => Effect.Effect<HermesSkillsInspectResponse, HermesSkillsError>;
  readonly reload: (
    input: HermesSkillsReloadInput,
  ) => Effect.Effect<HermesSkillsReloadResponse, HermesSkillsError>;
}

export class HermesSkills extends Context.Service<HermesSkills, HermesSkillsShape>()(
  "t3/hermes/HermesSkills",
) {}

const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);
const decodedHermesSettings = (config: unknown): HermesSettings | null => {
  try {
    return decodeHermesSettings(config);
  } catch {
    return null;
  }
};
const isHermesSkillsError = Schema.is(HermesSkillsError);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function skillsActionInventory(compatibility: HermesGatewayCompatibility): ReadonlySet<string> {
  const actions = new Set<string>();
  const inventory = record(compatibility.inventory);
  const manage = record(inventory?.["skills.manage"]);
  const candidates = [manage?.actions, manage?.operations];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const action of candidate) {
      if (typeof action === "string") actions.add(action.toLowerCase());
    }
  }
  return actions;
}

/**
 * Skills readiness comes only from the negotiated capability inventory. A
 * legacy gateway without negotiation never receives synthetic skills
 * capabilities and stays blocked.
 */
export function projectHermesSkillsCapabilities(
  compatibility: HermesGatewayCompatibility,
): HermesSkillsCapabilities {
  if (compatibility.status !== "supported") {
    return { inventory: false, search: false, inspect: false, reload: false };
  }
  const capabilities = new Set(compatibility.capabilities);
  const actions = skillsActionInventory(compatibility);
  const manage = capabilities.has("skills.manage");
  const supports = (action: string) => manage && (actions.size === 0 || actions.has(action));
  return {
    inventory: supports("list"),
    search: supports("search"),
    inspect: supports("inspect"),
    reload: capabilities.has("skills.reload"),
  };
}

export function projectHermesSkillEntry(value: unknown): HermesSkillEntry | null {
  if (typeof value === "string") {
    return value.length > 0 ? { name: value, description: null } : null;
  }
  const row = record(value);
  if (!row) return null;
  const name = string(row.name) ?? string(row.id) ?? string(row.skill);
  if (!name) return null;
  return { name, description: string(row.description) ?? null };
}

const blockedCapabilities: HermesSkillsCapabilities = {
  inventory: false,
  search: false,
  inspect: false,
  reload: false,
};

const unavailableProjection = (
  providerInstanceId: string,
  displayName: string,
  profileKey: string,
  diagnostic: string,
  status: "unavailable" | "error" = "unavailable",
  protocolClassification: HermesGatewayCompatibility["status"] | null = null,
): HermesSkillsProviderProjection => ({
  providerInstanceId,
  displayName,
  profileKey,
  status,
  protocolClassification,
  capabilities: blockedCapabilities,
  skills: [],
  diagnostics: [diagnostic],
});

const tokenFromEnvironment = (
  environment: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly sensitive: boolean;
  }>,
) =>
  environment.find(
    (variable) =>
      variable.name === "HERMES_GATEWAY_TOKEN" &&
      variable.sensitive &&
      variable.value.trim().length > 0,
  )?.value;

export const makeHermesSkills = Effect.fn("HermesSkills.make")(function* (
  options: HermesSkillsOptions = {},
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const clientFactory =
    options.clientFactory ??
    ((input: { readonly endpoint: string; readonly authToken: string }) =>
      new HermesGatewayClient(input));

  const configuredProviders = Effect.fn("HermesSkills.configuredProviders")(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new HermesSkillsError({
            code: "gateway_error",
            message: "Could not read Hermes provider settings.",
          }),
      ),
    );
    const instances = deriveProviderInstanceConfigMap(settings);
    const ready: HermesSkillsProviderConfig[] = [];
    const unavailable: HermesSkillsProviderProjection[] = [];
    for (const [providerInstanceId, instance] of Object.entries(instances)) {
      if (instance.driver !== "hermes") continue;
      const config = decodedHermesSettings(instance.config ?? {});
      if (config === null) {
        unavailable.push(
          unavailableProjection(
            providerInstanceId,
            instance.displayName ?? providerInstanceId,
            "unknown",
            "Hermes provider settings are invalid.",
          ),
        );
        continue;
      }
      const displayName = instance.displayName ?? providerInstanceId;
      const token = tokenFromEnvironment(instance.environment ?? []);
      if (instance.enabled !== true || !settings.enableHermes) {
        unavailable.push(
          unavailableProjection(
            providerInstanceId,
            displayName,
            config.profileKey,
            "Hermes is disabled.",
          ),
        );
      } else if (!config.endpoint || !token) {
        unavailable.push(
          unavailableProjection(
            providerInstanceId,
            displayName,
            config.profileKey,
            "Hermes gateway endpoint or sensitive token is not configured.",
          ),
        );
      } else {
        ready.push({
          providerInstanceId,
          displayName,
          profileKey: config.profileKey,
          endpoint: config.endpoint,
          token,
        });
      }
    }
    return { ready, unavailable };
  });

  const blockedProjection = (
    config: HermesSkillsProviderConfig,
    compatibility: HermesGatewayCompatibility,
  ): HermesSkillsProviderProjection | null => {
    if (compatibility.status === "legacy") {
      return unavailableProjection(
        config.providerInstanceId,
        config.displayName,
        config.profileKey,
        "Gateway capabilities are not negotiated; skills access stays blocked without a negotiated skills.manage capability.",
        "unavailable",
        compatibility.status,
      );
    }
    const capabilities = projectHermesSkillsCapabilities(compatibility);
    if (!capabilities.inventory) {
      return unavailableProjection(
        config.providerInstanceId,
        config.displayName,
        config.profileKey,
        "Gateway does not advertise skills.manage.",
        "unavailable",
        compatibility.status,
      );
    }
    return null;
  };

  const loadProvider = Effect.fn("HermesSkills.loadProvider")(function* (
    config: HermesSkillsProviderConfig,
  ) {
    const client = clientFactory({ endpoint: config.endpoint, authToken: config.token });
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          const compatibility = await client.connect();
          const blocked = blockedProjection(config, compatibility);
          if (blocked) return blocked;
          const result = await client.listSkills();
          const skills: HermesSkillEntry[] = [];
          for (const value of result.skills) {
            const entry = projectHermesSkillEntry(value);
            if (entry) skills.push(entry);
          }
          const diagnostics: string[] = [];
          const dropped = result.skills.length - skills.length;
          if (dropped > 0) {
            diagnostics.push(`${dropped} skill entr(ies) have no usable name and were omitted.`);
          }
          return {
            providerInstanceId: config.providerInstanceId,
            displayName: config.displayName,
            profileKey: config.profileKey,
            status: "ready",
            protocolClassification: compatibility.status,
            capabilities: projectHermesSkillsCapabilities(compatibility),
            skills,
            diagnostics,
          } satisfies HermesSkillsProviderProjection;
        } finally {
          client.close();
        }
      },
      catch: () =>
        new HermesSkillsError({
          code: "gateway_error",
          providerInstanceId: config.providerInstanceId,
          message: "Could not read native Hermes skills inventory.",
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          unavailableProjection(
            config.providerInstanceId,
            config.displayName,
            config.profileKey,
            error.message,
            "error",
          ),
        ),
      ),
    );
  });

  const resolveConfig = Effect.fn("HermesSkills.resolveConfig")(function* (
    providerInstanceId: string,
    operation: "search" | "inspect" | "reload",
  ) {
    const configured = yield* configuredProviders();
    const config = configured.ready.find(
      (candidate) => candidate.providerInstanceId === providerInstanceId,
    );
    if (!config) {
      const known = configured.unavailable.some(
        (candidate) => candidate.providerInstanceId === providerInstanceId,
      );
      return yield* new HermesSkillsError({
        code: known ? "provider_unavailable" : "provider_not_found",
        providerInstanceId,
        operation,
        message: known ? "Hermes provider is unavailable." : "Hermes provider was not found.",
      });
    }
    return config;
  });

  const withReadyClient = <Result>(
    config: HermesSkillsProviderConfig,
    operation: "search" | "inspect" | "reload",
    capability: (capabilities: HermesSkillsCapabilities) => boolean,
    run: (client: HermesSkillsGatewayClient) => Promise<Result>,
  ): Effect.Effect<Result, HermesSkillsError> => {
    const client = clientFactory({ endpoint: config.endpoint, authToken: config.token });
    return Effect.tryPromise({
      try: async () => {
        try {
          const compatibility = await client.connect();
          const capabilities = projectHermesSkillsCapabilities(compatibility);
          if (compatibility.status !== "supported" || !capability(capabilities)) {
            throw new HermesSkillsError({
              code: "unsupported_operation",
              providerInstanceId: config.providerInstanceId,
              operation,
              message: `Hermes gateway does not support skills ${operation}.`,
            });
          }
          return await run(client);
        } finally {
          client.close();
        }
      },
      catch: (cause) => {
        if (isHermesSkillsError(cause)) return cause;
        if (
          cause instanceof HermesGatewayMutationIndeterminateError ||
          cause instanceof HermesGatewayMutationsBlockedError
        ) {
          return new HermesSkillsError({
            code: "indeterminate",
            providerInstanceId: config.providerInstanceId,
            operation,
            message: "Hermes skills reload outcome is indeterminate; automatic replay is disabled.",
          });
        }
        return new HermesSkillsError({
          code: "gateway_error",
          providerInstanceId: config.providerInstanceId,
          operation,
          message: "Hermes skills gateway operation failed.",
        });
      },
    });
  };

  const list: HermesSkillsShape["list"] = Effect.fn("HermesSkills.list")(function* () {
    const configured = yield* configuredProviders();
    const available = yield* Effect.forEach(configured.ready, loadProvider, { concurrency: 4 });
    return { providers: [...available, ...configured.unavailable] };
  });

  const search: HermesSkillsShape["search"] = Effect.fn("HermesSkills.search")(function* (input) {
    if (!input.query.trim()) {
      return yield* new HermesSkillsError({
        code: "invalid_input",
        providerInstanceId: input.providerInstanceId,
        operation: "search",
        message: "Skills search requires a non-empty query.",
      });
    }
    const config = yield* resolveConfig(input.providerInstanceId, "search");
    return yield* withReadyClient(
      config,
      "search",
      (capabilities) => capabilities.search,
      async (client) => {
        const result = await client.searchSkills(input.query.trim());
        return {
          results: result.results.map((entry) => ({
            name: entry.name,
            description: entry.description ?? null,
          })),
        };
      },
    );
  });

  const inspect: HermesSkillsShape["inspect"] = Effect.fn("HermesSkills.inspect")(
    function* (input) {
      if (!input.name.trim()) {
        return yield* new HermesSkillsError({
          code: "invalid_input",
          providerInstanceId: input.providerInstanceId,
          operation: "inspect",
          message: "Skills inspect requires a skill name.",
        });
      }
      const config = yield* resolveConfig(input.providerInstanceId, "inspect");
      return yield* withReadyClient(
        config,
        "inspect",
        (capabilities) => capabilities.inspect,
        async (client) => {
          const result = await client.inspectSkill(input.name.trim());
          return { info: result.info };
        },
      );
    },
  );

  const reload: HermesSkillsShape["reload"] = Effect.fn("HermesSkills.reload")(function* (input) {
    if (!input.operationId.trim()) {
      return yield* new HermesSkillsError({
        code: "invalid_input",
        providerInstanceId: input.providerInstanceId,
        operation: "reload",
        message: "Skills reload requires an operation id.",
      });
    }
    const config = yield* resolveConfig(input.providerInstanceId, "reload");
    return yield* withReadyClient(
      config,
      "reload",
      (capabilities) => capabilities.reload,
      async (client) => {
        const result = await client.reloadSkills({ operationId: input.operationId });
        const names = (values: ReadonlyArray<unknown> | undefined) => {
          const collected: string[] = [];
          for (const value of values ?? []) {
            const entry = projectHermesSkillEntry(value);
            if (entry) collected.push(entry.name);
          }
          return collected;
        };
        return {
          added: names(result.result?.added),
          removed: names(result.result?.removed),
          total: result.result?.total ?? null,
          output: result.output ?? null,
        };
      },
    );
  });

  return HermesSkills.of({ list, search, inspect, reload });
});

export const layer = Layer.effect(HermesSkills, makeHermesSkills());

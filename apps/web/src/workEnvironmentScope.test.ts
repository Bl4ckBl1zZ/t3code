import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasValidHermesSetup, resolveWorkEnvironmentScope } from "./workEnvironmentScope";

const local = EnvironmentId.make("environment:local");
const remote = EnvironmentId.make("environment:remote");
const bare = EnvironmentId.make("environment:bare");

function hermesProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("hermes"),
    driver: ProviderDriverKind.make("hermes"),
    enabled: true,
    installed: true,
    status: "ready",
    models: [],
    ...overrides,
  } as ServerProvider;
}

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    t3WorkDirectory: "/private/t3-work",
    providers: [hermesProvider()],
    ...overrides,
  } as ServerConfig;
}

const environments = [{ environmentId: local }, { environmentId: remote }, { environmentId: bare }];

function scope(input: {
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly threadEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly storedEnvironmentId?: EnvironmentId | null;
  readonly primaryEnvironmentId?: EnvironmentId | null;
}) {
  return resolveWorkEnvironmentScope({
    environments,
    serverConfigs: input.serverConfigs,
    threadEnvironmentIds: input.threadEnvironmentIds ?? new Set(),
    storedEnvironmentId: input.storedEnvironmentId ?? null,
    primaryEnvironmentId: input.primaryEnvironmentId ?? local,
  });
}

describe("valid Hermes setup", () => {
  it("needs a ready, enabled, available Hermes and a work directory", () => {
    expect(hasValidHermesSetup(config())).toBe(true);
    expect(hasValidHermesSetup(undefined)).toBe(false);
    expect(hasValidHermesSetup({ providers: [hermesProvider()] } as unknown as ServerConfig)).toBe(
      false,
    );
    expect(hasValidHermesSetup(config({ providers: [hermesProvider({ enabled: false })] }))).toBe(
      false,
    );
    expect(
      hasValidHermesSetup(config({ providers: [hermesProvider({ status: "warning" })] })),
    ).toBe(false);
    expect(
      hasValidHermesSetup(config({ providers: [hermesProvider({ availability: "unavailable" })] })),
    ).toBe(false);
    expect(
      hasValidHermesSetup(
        config({ providers: [hermesProvider({ driver: ProviderDriverKind.make("codex") })] }),
      ),
    ).toBe(false);
  });
});

describe("work environment scope", () => {
  it("offers only environments that can host T3 Work", () => {
    const resolved = scope({ serverConfigs: new Map([[remote, config()]]) });
    expect(resolved.options.map((option) => option.environmentId)).toEqual([remote]);
    expect(resolved.scopeId).toBe(remote);
  });

  it("prefers the last picked environment over the primary one", () => {
    const resolved = scope({
      serverConfigs: new Map([
        [local, config()],
        [remote, config()],
      ]),
      storedEnvironmentId: remote,
    });
    expect(resolved.scopeId).toBe(remote);
  });

  it("falls back to the primary environment, then the first Hermes-ready one", () => {
    const serverConfigs = new Map([
      [local, config()],
      [remote, config()],
    ]);
    expect(scope({ serverConfigs }).scopeId).toBe(local);
    expect(scope({ serverConfigs, primaryEnvironmentId: bare }).scopeId).toBe(local);
  });

  it("ignores a stored environment that can no longer host T3 Work", () => {
    const resolved = scope({
      serverConfigs: new Map([[local, config()]]),
      storedEnvironmentId: remote,
    });
    expect(resolved.options.map((option) => option.environmentId)).toEqual([local]);
    expect(resolved.scopeId).toBe(local);
  });

  it("keeps offering an environment that still owns work threads", () => {
    // A machine that goes offline loses its Hermes readiness; its
    // conversations must stay reachable rather than silently disappearing.
    const resolved = scope({
      serverConfigs: new Map([[local, config()]]),
      threadEnvironmentIds: new Set([remote]),
      storedEnvironmentId: remote,
    });
    expect(resolved.options.map((option) => option.environmentId)).toEqual([local, remote]);
    expect(resolved.scopeId).toBe(remote);
  });

  it("resolves to nothing while no environment has reported in", () => {
    const resolved = scope({ serverConfigs: new Map() });
    expect(resolved.options).toEqual([]);
    expect(resolved.scopeId).toBeNull();
  });
});

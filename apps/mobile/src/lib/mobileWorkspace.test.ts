import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderDriverMap,
  isMobileWorkspaceThread,
  mobileProviderInstanceKey,
  resolveDraftWorkspaceMode,
  resolveHermesConversationTarget,
} from "./mobileWorkspace";

const environmentId = EnvironmentId.make("environment:local");
const hermesInstanceId = ProviderInstanceId.make("hermes-primary");
const rootThreadId = ThreadId.make("thread:root");

function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    t3WorkDirectory: "/private/t3-work",
    providers: [
      {
        instanceId: hermesInstanceId,
        driver: ProviderDriverKind.make("hermes"),
        enabled: true,
        installed: true,
        status: "ready",
        models: [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            capabilities: null,
          },
        ],
      },
    ],
    ...overrides,
  } as unknown as ServerConfig;
}

describe("mobile workspace routing", () => {
  it("recognizes custom Hermes instance ids from provider metadata", () => {
    const configs = new Map([[environmentId, serverConfig()]]);
    const drivers = buildProviderDriverMap(configs);
    const thread: Parameters<typeof isMobileWorkspaceThread>[0] = {
      environmentId,
      archivedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId,
      },
      providerInstanceId: hermesInstanceId,
      modelSelection: { instanceId: hermesInstanceId, model: "default" },
      runtime: null,
    };

    expect(drivers.get(mobileProviderInstanceKey(environmentId, hermesInstanceId))).toBe("hermes");
    expect(isMobileWorkspaceThread(thread, "work", drivers)).toBe(true);
    expect(isMobileWorkspaceThread(thread, "code", drivers)).toBe(false);
  });

  it("splits Hermes and non-Hermes threads between Work and Code", () => {
    const codexInstanceId = ProviderInstanceId.make("codex");
    const config = serverConfig();
    const configs = new Map([
      [
        environmentId,
        {
          ...config,
          providers: [
            ...config.providers,
            { ...config.providers[0], instanceId: codexInstanceId, driver: "codex" },
          ],
        } as ServerConfig,
      ],
    ]);
    const drivers = buildProviderDriverMap(configs);
    const codeThread: Parameters<typeof isMobileWorkspaceThread>[0] = {
      environmentId,
      archivedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId,
      },
      providerInstanceId: codexInstanceId,
      modelSelection: { instanceId: codexInstanceId, model: "default" },
      runtime: null,
    };

    expect(isMobileWorkspaceThread(codeThread, "code", drivers)).toBe(true);
    expect(isMobileWorkspaceThread(codeThread, "work", drivers)).toBe(false);
  });

  it("excludes archived and subagent threads from both workspaces", () => {
    const drivers = buildProviderDriverMap(new Map([[environmentId, serverConfig()]]));
    const base: Parameters<typeof isMobileWorkspaceThread>[0] = {
      environmentId,
      archivedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId,
      },
      providerInstanceId: hermesInstanceId,
      modelSelection: { instanceId: hermesInstanceId, model: "default" },
      runtime: null,
    };

    expect(
      isMobileWorkspaceThread({ ...base, archivedAt: "2026-07-26T00:00:00.000Z" }, "code", drivers),
    ).toBe(false);
    expect(
      isMobileWorkspaceThread(
        {
          ...base,
          lineage: {
            ...base.lineage,
            parentThreadId: rootThreadId,
            relationshipToParent: "subagent",
          },
        },
        "work",
        drivers,
      ),
    ).toBe(false);
  });

  it("opens Work on the selected environment without requiring a backing project or model", () => {
    const otherEnvironmentId = EnvironmentId.make("environment:other");
    const config = serverConfig();
    const serverConfigs = new Map([
      [otherEnvironmentId, config],
      [
        environmentId,
        { ...config, providers: config.providers.map((provider) => ({ ...provider, models: [] })) },
      ],
    ]);
    expect(
      resolveHermesConversationTarget({ serverConfigs, requiredEnvironmentId: environmentId }),
    ).toEqual({ environmentId, providerInstanceId: hermesInstanceId });
  });

  it("keeps fresh conversations on the source thread’s provider", () => {
    const config = serverConfig();
    const otherProvider = ProviderInstanceId.make("hermes-other");
    const serverConfigs = new Map([
      [
        environmentId,
        {
          ...config,
          providers: [...config.providers, { ...config.providers[0]!, instanceId: otherProvider }],
        },
      ],
    ]);
    expect(
      resolveHermesConversationTarget({
        serverConfigs,
        requiredEnvironmentId: environmentId,
        requiredProviderInstanceId: otherProvider,
      }),
    ).toEqual({ environmentId, providerInstanceId: otherProvider });
    expect(
      resolveHermesConversationTarget({
        serverConfigs,
        requiredEnvironmentId: environmentId,
        requiredProviderInstanceId: "missing",
      }),
    ).toBeNull();
  });

  it("does not launch into a different environment when the selected one is unavailable", () => {
    expect(
      resolveHermesConversationTarget({
        serverConfigs: new Map([[environmentId, serverConfig()]]),
        requiredEnvironmentId: EnvironmentId.make("missing"),
      }),
    ).toBeNull();
    const config = serverConfig();
    expect(
      resolveHermesConversationTarget({
        serverConfigs: new Map([
          [
            environmentId,
            {
              ...config,
              providers: config.providers.map((provider) => ({ ...provider, enabled: false })),
            },
          ],
        ]),
        requiredEnvironmentId: environmentId,
      }),
    ).toBeNull();
  });
});

describe("draft workspace mode", () => {
  it("keeps Work conversations on the current checkout even when the server defaults to worktree", () => {
    // The Work composer hides the Workspace pill, so a worktree mode could
    // never get a base branch and would leave the send button disabled.
    expect(resolveDraftWorkspaceMode({ isWorkConversation: true, requestedMode: "worktree" })).toBe(
      "local",
    );
    expect(resolveDraftWorkspaceMode({ isWorkConversation: true, requestedMode: "local" })).toBe(
      "local",
    );
  });

  it("honours the requested mode for project tasks", () => {
    expect(
      resolveDraftWorkspaceMode({ isWorkConversation: false, requestedMode: "worktree" }),
    ).toBe("worktree");
    expect(resolveDraftWorkspaceMode({ isWorkConversation: false, requestedMode: "local" })).toBe(
      "local",
    );
  });
});

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildProviderInstanceUpdatePatch,
  collectArchivedWorktreeCleanupTargets,
  collectUnlinkedWorktreeCleanupTargets,
  formatDiagnosticsDescription,
} from "./SettingsPanels.logic";

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("collectArchivedWorktreeCleanupTargets", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const archivedThread = (input: {
    readonly id: string;
    readonly projectCwd?: string;
    readonly worktreePath: string | null;
  }) => ({
    environmentId,
    id: ThreadId.make(input.id),
    projectCwd: input.projectCwd ?? "/repo/project",
    worktreePath: input.worktreePath,
  });

  it("collects each orphaned deleted archived worktree once", () => {
    const firstThread = archivedThread({
      id: "thread-1",
      worktreePath: " /repo/.t3/worktrees/feature-a ",
    });
    const secondThread = archivedThread({
      id: "thread-2",
      worktreePath: "/repo/.t3/worktrees/feature-a",
    });

    expect(
      collectArchivedWorktreeCleanupTargets({
        archivedThreads: [firstThread, secondThread],
        deletedArchivedThreads: [firstThread, secondThread],
        retainedThreads: [],
      }),
    ).toEqual([
      {
        environmentId,
        projectCwd: "/repo/project",
        worktreePath: "/repo/.t3/worktrees/feature-a",
      },
    ]);
  });

  it("keeps worktrees used by active or failed archived threads", () => {
    const deletedThread = archivedThread({
      id: "thread-deleted",
      worktreePath: "/repo/.t3/worktrees/shared-archived",
    });
    const failedThread = archivedThread({
      id: "thread-failed",
      worktreePath: "/repo/.t3/worktrees/shared-archived",
    });
    const activeSharedThread = {
      environmentId,
      id: ThreadId.make("thread-active"),
      worktreePath: "/repo/.t3/worktrees/shared-active",
    };
    const activeSharedArchivedThread = archivedThread({
      id: "thread-active-shared-archived",
      worktreePath: "/repo/.t3/worktrees/shared-active",
    });

    expect(
      collectArchivedWorktreeCleanupTargets({
        archivedThreads: [deletedThread, failedThread, activeSharedArchivedThread],
        deletedArchivedThreads: [deletedThread, activeSharedArchivedThread],
        retainedThreads: [activeSharedThread],
      }),
    ).toEqual([]);
  });
});

describe("collectUnlinkedWorktreeCleanupTargets", () => {
  const environmentId = EnvironmentId.make("environment-local");

  it("excludes main and active-thread-linked worktrees", () => {
    expect(
      collectUnlinkedWorktreeCleanupTargets({
        worktrees: [
          {
            environmentId,
            projectCwd: "/repo/project",
            path: "/repo/project",
            refName: "main",
            isMain: true,
          },
          {
            environmentId,
            projectCwd: "/repo/project",
            path: "/repo/.t3/worktrees/active",
            refName: "feature/active",
            isMain: false,
          },
          {
            environmentId,
            projectCwd: "/repo/project",
            path: " /repo/.t3/worktrees/orphan ",
            refName: "feature/orphan",
            isMain: false,
          },
          {
            environmentId,
            projectCwd: "/repo/project",
            path: "/repo/.t3/worktrees/orphan",
            refName: "feature/orphan-copy",
            isMain: false,
          },
        ],
        activeThreads: [
          {
            environmentId,
            id: ThreadId.make("thread-active"),
            worktreePath: "/repo/.t3/worktrees/active",
          },
        ],
      }),
    ).toEqual([
      {
        environmentId,
        projectCwd: "/repo/project",
        path: "/repo/.t3/worktrees/orphan",
        refName: "feature/orphan",
      },
    ]);
  });
});

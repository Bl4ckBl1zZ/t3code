import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
  UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

function collapseOtelSignalsUrl(input: {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
}): string | null {
  const tracesSuffix = "/traces";
  const metricsSuffix = "/metrics";
  if (!input.tracesUrl.endsWith(tracesSuffix) || !input.metricsUrl.endsWith(metricsSuffix)) {
    return null;
  }

  const tracesBase = input.tracesUrl.slice(0, -tracesSuffix.length);
  const metricsBase = input.metricsUrl.slice(0, -metricsSuffix.length);
  if (tracesBase !== metricsBase) {
    return null;
  }

  return `${tracesBase}/{traces,metrics}`;
}

export function formatDiagnosticsDescription(input: {
  readonly localTracingEnabled: boolean;
  readonly otlpTracesEnabled: boolean;
  readonly otlpTracesUrl?: string | undefined;
  readonly otlpMetricsEnabled: boolean;
  readonly otlpMetricsUrl?: string | undefined;
}): string {
  const mode = input.localTracingEnabled ? "Local trace file" : "Terminal logs only";
  const tracesUrl = input.otlpTracesEnabled ? input.otlpTracesUrl : undefined;
  const metricsUrl = input.otlpMetricsEnabled ? input.otlpMetricsUrl : undefined;

  if (tracesUrl && metricsUrl) {
    const collapsedUrl = collapseOtelSignalsUrl({ tracesUrl, metricsUrl });
    return collapsedUrl
      ? `${mode}. Exporting OTEL to ${collapsedUrl}.`
      : `${mode}. Exporting OTEL traces to ${tracesUrl} and metrics to ${metricsUrl}.`;
  }

  if (tracesUrl) {
    return `${mode}. Exporting OTEL traces to ${tracesUrl}.`;
  }

  if (metricsUrl) {
    return `${mode}. Exporting OTEL metrics to ${metricsUrl}.`;
  }

  return `${mode}.`;
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

export type ArchivedWorktreeCleanupThread = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectCwd: string;
  readonly worktreePath: string | null;
};

export type RetainedWorktreeThread = {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly worktreePath: string | null;
};

export type ArchivedWorktreeCleanupTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string;
  readonly worktreePath: string;
};

export type ListedWorktreeCleanupCandidate = {
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string;
  readonly path: string;
  readonly refName: string | null;
  readonly isMain: boolean;
};

export type UnlinkedWorktreeCleanupTarget = {
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string;
  readonly path: string;
  readonly refName: string | null;
};

function normalizeWorktreePath(worktreePath: string | null): string | null {
  const trimmed = worktreePath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function worktreeUsageKey(environmentId: EnvironmentId, worktreePath: string): string {
  return `${environmentId}\u001f${worktreePath}`;
}

function threadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}\u001f${threadId}`;
}

export function collectArchivedWorktreeCleanupTargets(input: {
  readonly archivedThreads: ReadonlyArray<ArchivedWorktreeCleanupThread>;
  readonly deletedArchivedThreads: ReadonlyArray<ArchivedWorktreeCleanupThread>;
  readonly retainedThreads: ReadonlyArray<RetainedWorktreeThread>;
}): ReadonlyArray<ArchivedWorktreeCleanupTarget> {
  const deletedThreadKeys = new Set(
    input.deletedArchivedThreads.map((thread) => threadKey(thread.environmentId, thread.id)),
  );
  const retainedWorktreeKeys = new Set<string>();

  for (const thread of input.retainedThreads) {
    const worktreePath = normalizeWorktreePath(thread.worktreePath);
    if (worktreePath) {
      retainedWorktreeKeys.add(worktreeUsageKey(thread.environmentId, worktreePath));
    }
  }

  for (const thread of input.archivedThreads) {
    if (deletedThreadKeys.has(threadKey(thread.environmentId, thread.id))) {
      continue;
    }
    const worktreePath = normalizeWorktreePath(thread.worktreePath);
    if (worktreePath) {
      retainedWorktreeKeys.add(worktreeUsageKey(thread.environmentId, worktreePath));
    }
  }

  const cleanupTargets = new Map<string, ArchivedWorktreeCleanupTarget>();
  for (const thread of input.deletedArchivedThreads) {
    const worktreePath = normalizeWorktreePath(thread.worktreePath);
    if (!worktreePath) {
      continue;
    }
    const key = worktreeUsageKey(thread.environmentId, worktreePath);
    if (retainedWorktreeKeys.has(key) || cleanupTargets.has(key)) {
      continue;
    }
    cleanupTargets.set(key, {
      environmentId: thread.environmentId,
      projectCwd: thread.projectCwd,
      worktreePath,
    });
  }

  return Array.from(cleanupTargets.values());
}

export function collectUnlinkedWorktreeCleanupTargets(input: {
  readonly worktrees: ReadonlyArray<ListedWorktreeCleanupCandidate>;
  readonly activeThreads: ReadonlyArray<RetainedWorktreeThread>;
}): ReadonlyArray<UnlinkedWorktreeCleanupTarget> {
  const activeWorktreeKeys = new Set<string>();
  for (const thread of input.activeThreads) {
    const worktreePath = normalizeWorktreePath(thread.worktreePath);
    if (worktreePath) {
      activeWorktreeKeys.add(worktreeUsageKey(thread.environmentId, worktreePath));
    }
  }

  const cleanupTargets = new Map<string, UnlinkedWorktreeCleanupTarget>();
  for (const worktree of input.worktrees) {
    const worktreePath = normalizeWorktreePath(worktree.path);
    if (!worktreePath || worktree.isMain) {
      continue;
    }
    const key = worktreeUsageKey(worktree.environmentId, worktreePath);
    if (activeWorktreeKeys.has(key) || cleanupTargets.has(key)) {
      continue;
    }
    cleanupTargets.set(key, {
      environmentId: worktree.environmentId,
      projectCwd: worktree.projectCwd,
      path: worktreePath,
      refName: worktree.refName,
    });
  }

  return Array.from(cleanupTargets.values());
}

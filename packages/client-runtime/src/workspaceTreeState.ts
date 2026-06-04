import type {
  EnvironmentId,
  WorkspaceEntry,
  WorkspaceCreateDirectoryInput,
  WorkspaceCreateFileInput,
  WorkspaceDeleteInput,
  WorkspaceFileChangeEvent,
  WorkspaceListDirectoryInput,
  WorkspaceListDirectoryResult,
  WorkspaceMutationResult,
  WorkspaceRenameInput,
  WorkspaceRenameResult,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export interface WorkspaceTreeTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export interface WorkspaceTreeDirectoryState {
  readonly data: WorkspaceListDirectoryResult | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly lastLoadedAt: number | null;
}

export interface WorkspaceTreeClient {
  readonly listDirectory: (
    input: WorkspaceListDirectoryInput,
  ) => Promise<WorkspaceListDirectoryResult>;
  readonly createFile?: (input: WorkspaceCreateFileInput) => Promise<WorkspaceMutationResult>;
  readonly createDirectory?: (
    input: WorkspaceCreateDirectoryInput,
  ) => Promise<WorkspaceMutationResult>;
  readonly rename?: (input: WorkspaceRenameInput) => Promise<WorkspaceRenameResult>;
  readonly delete?: (input: WorkspaceDeleteInput) => Promise<WorkspaceMutationResult>;
  readonly subscribeChanges?: (
    input: { readonly cwd: string },
    callback: (event: WorkspaceFileChangeEvent) => void,
    options?: { readonly onResubscribe?: () => void },
  ) => () => void;
}

interface WatchedEntry {
  refCount: number;
  teardown: () => void;
}

export const EMPTY_WORKSPACE_TREE_DIRECTORY_STATE = Object.freeze<WorkspaceTreeDirectoryState>({
  data: null,
  error: null,
  isPending: false,
  lastLoadedAt: null,
});

const INITIAL_WORKSPACE_TREE_DIRECTORY_STATE = Object.freeze<WorkspaceTreeDirectoryState>({
  data: null,
  error: null,
  isPending: true,
  lastLoadedAt: null,
});

const knownWorkspaceTreeKeys = new Set<string>();

export const workspaceTreeDirectoryStateAtom = Atom.family((targetKey: string) => {
  knownWorkspaceTreeKeys.add(targetKey);
  return Atom.make(INITIAL_WORKSPACE_TREE_DIRECTORY_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`workspace-tree:${targetKey}`),
  );
});

export const EMPTY_WORKSPACE_TREE_DIRECTORY_ATOM = Atom.make(
  EMPTY_WORKSPACE_TREE_DIRECTORY_STATE,
).pipe(Atom.keepAlive, Atom.withLabel("workspace-tree:null"));

const NOOP: () => void = () => undefined;
const DEFAULT_STALE_TIME_MS = 15_000;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

function normalizeTreeRelativePath(relativePath: string): string {
  return relativePath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
}

function parentRelativePath(relativePath: string): string {
  const normalized = normalizeTreeRelativePath(relativePath);
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? "" : normalized.slice(0, separatorIndex);
}

function sortWorkspaceEntries(entries: ReadonlyArray<WorkspaceEntry>): WorkspaceEntry[] {
  return [...entries].sort((left, right) => {
    const leftDirectory = left.kind === "directory";
    const rightDirectory = right.kind === "directory";
    if (leftDirectory !== rightDirectory) {
      return leftDirectory ? -1 : 1;
    }
    return left.name.toLocaleLowerCase().localeCompare(right.name.toLocaleLowerCase());
  });
}

function cwdWatcherKey(environmentId: EnvironmentId, cwd: string): string {
  return JSON.stringify([environmentId, cwd]);
}

export function getWorkspaceTreeTargetKey(target: WorkspaceTreeTarget | null): string | null {
  if (!target || !target.environmentId || !target.cwd) {
    return null;
  }
  return JSON.stringify([
    target.environmentId,
    target.cwd,
    normalizeTreeRelativePath(target.relativePath),
  ]);
}

export function parentWorkspaceTreeTarget(target: WorkspaceTreeTarget): WorkspaceTreeTarget {
  const relativePath = normalizeTreeRelativePath(target.relativePath);
  const separatorIndex = relativePath.lastIndexOf("/");
  return {
    ...target,
    relativePath: separatorIndex === -1 ? "" : relativePath.slice(0, separatorIndex),
  };
}

export interface WorkspaceTreeManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: EnvironmentId) => WorkspaceTreeClient | null;
  readonly subscribeClientChanges?: (listener: () => void) => () => void;
  readonly staleTimeMs?: number;
}

export function createWorkspaceTreeManager(config: WorkspaceTreeManagerConfig) {
  const refreshInFlight = new Map<string, Promise<WorkspaceListDirectoryResult | null>>();
  const refreshTargets = new Map<string, WorkspaceTreeTarget>();
  const watched = new Map<string, WatchedEntry>();
  const cwdWatchers = new Map<string, WatchedEntry>();
  const staleTimeMs = config.staleTimeMs ?? DEFAULT_STALE_TIME_MS;

  function setState(targetKey: string, nextState: WorkspaceTreeDirectoryState): void {
    config.getRegistry().set(workspaceTreeDirectoryStateAtom(targetKey), nextState);
  }

  function markPending(targetKey: string): void {
    const current = config.getRegistry().get(workspaceTreeDirectoryStateAtom(targetKey));
    setState(targetKey, {
      data: current.data,
      error: null,
      isPending: true,
      lastLoadedAt: current.lastLoadedAt,
    });
  }

  function setData(targetKey: string, data: WorkspaceListDirectoryResult): void {
    setState(targetKey, {
      data,
      error: null,
      isPending: false,
      lastLoadedAt: nowMs(),
    });
  }

  function setError(targetKey: string, error: unknown): void {
    const current = config.getRegistry().get(workspaceTreeDirectoryStateAtom(targetKey));
    setState(targetKey, {
      data: current.data,
      error: error instanceof Error ? error.message : "Failed to load directory.",
      isPending: false,
      lastLoadedAt: current.lastLoadedAt,
    });
  }

  function getSnapshot(target: WorkspaceTreeTarget | null): WorkspaceTreeDirectoryState {
    const targetKey = getWorkspaceTreeTargetKey(target);
    return targetKey === null
      ? EMPTY_WORKSPACE_TREE_DIRECTORY_STATE
      : config.getRegistry().get(workspaceTreeDirectoryStateAtom(targetKey));
  }

  function refresh(
    target: WorkspaceTreeTarget,
    options?: {
      readonly includeHidden?: boolean;
      readonly includeIgnored?: boolean;
      readonly limit?: number;
      readonly force?: boolean;
    },
  ): Promise<WorkspaceListDirectoryResult | null> {
    const targetKey = getWorkspaceTreeTargetKey(target);
    if (targetKey === null) {
      return Promise.resolve(null);
    }
    refreshTargets.set(targetKey, target);

    const current = getSnapshot(target);
    if (
      !options?.force &&
      current.data &&
      current.lastLoadedAt !== null &&
      nowMs() - current.lastLoadedAt < staleTimeMs
    ) {
      return Promise.resolve(current.data);
    }

    const existing = refreshInFlight.get(targetKey);
    if (existing) {
      return existing;
    }

    const client = config.getClient(target.environmentId);
    if (!client) {
      setError(targetKey, new Error("Workspace file client is unavailable."));
      return Promise.resolve(current.data);
    }

    markPending(targetKey);
    const promise = client
      .listDirectory({
        cwd: target.cwd,
        relativePath: normalizeTreeRelativePath(target.relativePath),
        includeHidden: options?.includeHidden,
        includeIgnored: options?.includeIgnored,
        limit: options?.limit ?? 1000,
      })
      .then(
        (result) => {
          setData(targetKey, result);
          return result;
        },
        (error: unknown) => {
          setError(targetKey, error);
          return getSnapshot(target).data;
        },
      )
      .finally(() => {
        refreshInFlight.delete(targetKey);
      });
    refreshInFlight.set(targetKey, promise);
    return promise;
  }

  function invalidate(target?: WorkspaceTreeTarget): void {
    if (!target) {
      reset();
      return;
    }
    const targetKey = getWorkspaceTreeTargetKey(target);
    if (targetKey === null) {
      return;
    }
    refreshInFlight.delete(targetKey);
    const current = getSnapshot(target);
    setState(targetKey, { ...current, isPending: current.data === null });
  }

  function applyDirectoryResult(result: WorkspaceListDirectoryResult): void {
    for (const [targetKey, target] of refreshTargets) {
      if (
        target.cwd === result.cwd &&
        normalizeTreeRelativePath(target.relativePath) === result.relativePath
      ) {
        setData(targetKey, result);
      }
    }
  }

  function updateLoadedDirectory(
    environmentId: EnvironmentId,
    cwd: string,
    relativePath: string,
    update: (data: WorkspaceListDirectoryResult) => WorkspaceListDirectoryResult,
  ): void {
    const normalizedRelativePath = normalizeTreeRelativePath(relativePath);
    for (const [targetKey, target] of refreshTargets) {
      if (
        target.environmentId !== environmentId ||
        target.cwd !== cwd ||
        normalizeTreeRelativePath(target.relativePath) !== normalizedRelativePath
      ) {
        continue;
      }
      const current = getSnapshot(target);
      if (!current.data) {
        continue;
      }
      setData(targetKey, update(current.data));
    }
  }

  function applyCreateResult(environmentId: EnvironmentId, result: WorkspaceMutationResult): void {
    const createdEntry = result.entry;
    if (!createdEntry) {
      return;
    }
    updateLoadedDirectory(
      environmentId,
      result.cwd,
      parentRelativePath(result.relativePath),
      (data) => ({
        ...data,
        entries: sortWorkspaceEntries([
          ...data.entries.filter((entry) => entry.relativePath !== createdEntry.relativePath),
          createdEntry,
        ]),
      }),
    );
  }

  function applyRenameResult(environmentId: EnvironmentId, result: WorkspaceRenameResult): void {
    updateLoadedDirectory(
      environmentId,
      result.cwd,
      parentRelativePath(result.fromRelativePath),
      (data) => ({
        ...data,
        entries: data.entries.filter((entry) => entry.relativePath !== result.fromRelativePath),
      }),
    );
    const renamedEntry = result.entry;
    if (!renamedEntry) {
      return;
    }
    updateLoadedDirectory(
      environmentId,
      result.cwd,
      parentRelativePath(result.toRelativePath),
      (data) => ({
        ...data,
        entries: sortWorkspaceEntries([
          ...data.entries.filter((entry) => entry.relativePath !== renamedEntry.relativePath),
          renamedEntry,
        ]),
      }),
    );
  }

  function applyDeleteResult(environmentId: EnvironmentId, result: WorkspaceMutationResult): void {
    updateLoadedDirectory(
      environmentId,
      result.cwd,
      parentRelativePath(result.relativePath),
      (data) => ({
        ...data,
        entries: data.entries.filter((entry) => entry.relativePath !== result.relativePath),
      }),
    );
  }

  function refreshAffectedByChange(environmentId: EnvironmentId, event: WorkspaceFileChangeEvent) {
    for (const target of refreshTargets.values()) {
      if (target.environmentId !== environmentId || target.cwd !== event.cwd) {
        continue;
      }
      const targetRelativePath = normalizeTreeRelativePath(target.relativePath);
      if (targetRelativePath === event.directoryPath) {
        void refresh(target, { force: true });
      }
    }
  }

  function watch(target: WorkspaceTreeTarget): () => void {
    const targetKey = getWorkspaceTreeTargetKey(target);
    if (targetKey === null) {
      return NOOP;
    }
    refreshTargets.set(targetKey, target);
    const existing = watched.get(targetKey);
    if (existing) {
      existing.refCount += 1;
      return () => unwatch(targetKey);
    }
    void refresh(target);
    watched.set(targetKey, { refCount: 1, teardown: NOOP });
    retainCwdWatcher(target.environmentId, target.cwd);
    return () => unwatch(targetKey);
  }

  function unwatch(targetKey: string): void {
    const entry = watched.get(targetKey);
    if (!entry) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }
    entry.teardown();
    watched.delete(targetKey);
    const target = refreshTargets.get(targetKey);
    if (target) {
      releaseCwdWatcher(target.environmentId, target.cwd);
    }
  }

  function retainCwdWatcher(environmentId: EnvironmentId, cwd: string): void {
    const key = cwdWatcherKey(environmentId, cwd);
    const existing = cwdWatchers.get(key);
    if (existing) {
      existing.refCount += 1;
      return;
    }
    const client = config.getClient(environmentId);
    const teardown =
      client?.subscribeChanges?.(
        { cwd },
        (event) => refreshAffectedByChange(environmentId, event),
        {
          onResubscribe: () => {
            for (const target of refreshTargets.values()) {
              if (target.environmentId === environmentId && target.cwd === cwd) {
                void refresh(target, { force: true });
              }
            }
          },
        },
      ) ?? NOOP;
    cwdWatchers.set(key, { refCount: 1, teardown });
  }

  function releaseCwdWatcher(environmentId: EnvironmentId, cwd: string): void {
    const key = cwdWatcherKey(environmentId, cwd);
    const entry = cwdWatchers.get(key);
    if (!entry) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }
    entry.teardown();
    cwdWatchers.delete(key);
  }

  function reset(): void {
    refreshInFlight.clear();
    for (const entry of watched.values()) {
      entry.teardown();
    }
    for (const entry of cwdWatchers.values()) {
      entry.teardown();
    }
    watched.clear();
    cwdWatchers.clear();
    refreshTargets.clear();
    for (const targetKey of knownWorkspaceTreeKeys) {
      setState(targetKey, INITIAL_WORKSPACE_TREE_DIRECTORY_STATE);
    }
  }

  return {
    refresh,
    invalidate,
    getSnapshot,
    watch,
    applyDirectoryResult,
    applyCreateResult,
    applyRenameResult,
    applyDeleteResult,
    refreshAffectedByChange,
    reset,
  };
}

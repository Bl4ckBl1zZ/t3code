import type {
  EnvironmentId,
  WorkspaceFileChangeEvent,
  WorkspaceFileVersion,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceWriteFileInput,
  WorkspaceWriteFileResult,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export interface WorkspaceDocumentTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export interface WorkspaceDocumentState {
  readonly status:
    | "idle"
    | "loading"
    | "ready"
    | "saving"
    | "conflict"
    | "deleted"
    | "unsupported"
    | "error";
  readonly serverContents: string | null;
  readonly draftContents: string | null;
  readonly version: WorkspaceFileVersion | null;
  readonly error: string | null;
  readonly dirty: boolean;
  readonly readonly: boolean;
  readonly binary: boolean;
  readonly tooLarge: boolean;
  readonly externalChange: boolean;
}

export interface WorkspaceDocumentClient {
  readonly readFile: (input: WorkspaceReadFileInput) => Promise<WorkspaceReadFileResult>;
  readonly writeFile: (input: WorkspaceWriteFileInput) => Promise<WorkspaceWriteFileResult>;
  readonly subscribeChanges?: (
    input: { readonly cwd: string },
    callback: (event: WorkspaceFileChangeEvent) => void,
    options?: { readonly onResubscribe?: () => void },
  ) => () => void;
}

export const EMPTY_WORKSPACE_DOCUMENT_STATE = Object.freeze<WorkspaceDocumentState>({
  status: "idle",
  serverContents: null,
  draftContents: null,
  version: null,
  error: null,
  dirty: false,
  readonly: false,
  binary: false,
  tooLarge: false,
  externalChange: false,
});

const LOADING_WORKSPACE_DOCUMENT_STATE = Object.freeze<WorkspaceDocumentState>({
  ...EMPTY_WORKSPACE_DOCUMENT_STATE,
  status: "loading",
});

const knownWorkspaceDocumentKeys = new Set<string>();

export const workspaceDocumentStateAtom = Atom.family((targetKey: string) => {
  knownWorkspaceDocumentKeys.add(targetKey);
  return Atom.make(EMPTY_WORKSPACE_DOCUMENT_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`workspace-document:${targetKey}`),
  );
});

export const EMPTY_WORKSPACE_DOCUMENT_ATOM = Atom.make(EMPTY_WORKSPACE_DOCUMENT_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("workspace-document:null"),
);

function normalizeDocumentRelativePath(relativePath: string): string {
  return relativePath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
}

export function getWorkspaceDocumentTargetKey(
  target: WorkspaceDocumentTarget | null,
): string | null {
  if (!target || !target.environmentId || !target.cwd || !target.relativePath) {
    return null;
  }
  return JSON.stringify([
    target.environmentId,
    target.cwd,
    normalizeDocumentRelativePath(target.relativePath),
  ]);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isConflictError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "conflict"
  );
}

function stateFromReadResult(
  result: WorkspaceReadFileResult,
  current: WorkspaceDocumentState,
  options?: { readonly preserveDirty?: boolean },
): WorkspaceDocumentState {
  const preserveDirty = options?.preserveDirty === true && current.dirty;
  if (!result.exists) {
    return {
      ...current,
      status: "deleted",
      serverContents: null,
      draftContents: preserveDirty ? current.draftContents : null,
      version: null,
      error: null,
      dirty: preserveDirty,
      readonly: result.readonly,
      binary: false,
      tooLarge: false,
      externalChange: false,
    };
  }

  if (result.contents === null || result.binary || result.tooLarge) {
    return {
      ...current,
      status: "unsupported",
      serverContents: null,
      draftContents: null,
      version: result.version,
      error: result.binary
        ? "Binary files cannot be edited in T3 Code."
        : result.tooLarge
          ? "File is too large to edit in T3 Code."
          : "File type is not supported.",
      dirty: false,
      readonly: result.readonly,
      binary: result.binary,
      tooLarge: result.tooLarge,
      externalChange: false,
    };
  }

  return {
    status: "ready",
    serverContents: result.contents,
    draftContents: preserveDirty ? current.draftContents : result.contents,
    version: result.version,
    error: null,
    dirty: preserveDirty,
    readonly: result.readonly,
    binary: false,
    tooLarge: false,
    externalChange: false,
  };
}

export interface WorkspaceDocumentManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly getClient: (environmentId: EnvironmentId) => WorkspaceDocumentClient | null;
}

export function createWorkspaceDocumentManager(config: WorkspaceDocumentManagerConfig) {
  const loadInFlight = new Map<string, Promise<WorkspaceDocumentState>>();

  function setState(targetKey: string, nextState: WorkspaceDocumentState): void {
    config.getRegistry().set(workspaceDocumentStateAtom(targetKey), nextState);
  }

  function getSnapshot(target: WorkspaceDocumentTarget | null): WorkspaceDocumentState {
    const targetKey = getWorkspaceDocumentTargetKey(target);
    return targetKey === null
      ? EMPTY_WORKSPACE_DOCUMENT_STATE
      : config.getRegistry().get(workspaceDocumentStateAtom(targetKey));
  }

  function load(
    target: WorkspaceDocumentTarget,
    options?: { readonly preserveDirty?: boolean; readonly maxBytes?: number },
  ): Promise<WorkspaceDocumentState> {
    const targetKey = getWorkspaceDocumentTargetKey(target);
    if (targetKey === null) {
      return Promise.resolve(EMPTY_WORKSPACE_DOCUMENT_STATE);
    }
    const existing = loadInFlight.get(targetKey);
    if (existing) {
      return existing;
    }
    const client = config.getClient(target.environmentId);
    if (!client) {
      const nextState = {
        ...getSnapshot(target),
        status: "error" as const,
        error: "Workspace file client is unavailable.",
      };
      setState(targetKey, nextState);
      return Promise.resolve(nextState);
    }

    const current = getSnapshot(target);
    setState(targetKey, {
      ...LOADING_WORKSPACE_DOCUMENT_STATE,
      draftContents: options?.preserveDirty && current.dirty ? current.draftContents : null,
      dirty: options?.preserveDirty === true && current.dirty,
    });
    const promise = client
      .readFile({
        cwd: target.cwd,
        relativePath: normalizeDocumentRelativePath(target.relativePath),
        ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      })
      .then(
        (result) => {
          const nextState = stateFromReadResult(result, current, options);
          setState(targetKey, nextState);
          return nextState;
        },
        (error: unknown) => {
          const nextState = {
            ...current,
            status: "error" as const,
            error: errorMessage(error, "Failed to load file."),
          };
          setState(targetKey, nextState);
          return nextState;
        },
      )
      .finally(() => {
        loadInFlight.delete(targetKey);
      });
    loadInFlight.set(targetKey, promise);
    return promise;
  }

  function edit(target: WorkspaceDocumentTarget, draftContents: string): void {
    const targetKey = getWorkspaceDocumentTargetKey(target);
    if (targetKey === null) {
      return;
    }
    const current = getSnapshot(target);
    setState(targetKey, {
      ...current,
      status: current.status === "conflict" ? "conflict" : "ready",
      draftContents,
      dirty: draftContents !== current.serverContents,
      error: current.status === "conflict" ? current.error : null,
    });
  }

  async function save(
    target: WorkspaceDocumentTarget,
    options?: { readonly overwrite?: boolean },
  ): Promise<WorkspaceDocumentState> {
    const targetKey = getWorkspaceDocumentTargetKey(target);
    if (targetKey === null) {
      return EMPTY_WORKSPACE_DOCUMENT_STATE;
    }
    const client = config.getClient(target.environmentId);
    const current = getSnapshot(target);
    if (!client) {
      const nextState = {
        ...current,
        status: "error" as const,
        error: "Workspace file client is unavailable.",
      };
      setState(targetKey, nextState);
      return nextState;
    }
    if (current.draftContents === null) {
      return current;
    }

    setState(targetKey, { ...current, status: "saving", error: null });
    let expectedVersion = current.version;
    if (options?.overwrite === true) {
      const latest = await client.readFile({
        cwd: target.cwd,
        relativePath: normalizeDocumentRelativePath(target.relativePath),
      });
      expectedVersion = latest.exists ? latest.version : null;
    }

    return client
      .writeFile({
        cwd: target.cwd,
        relativePath: normalizeDocumentRelativePath(target.relativePath),
        contents: current.draftContents,
        expectedVersion,
        create: expectedVersion === null,
      })
      .then(
        (result) => {
          const nextState: WorkspaceDocumentState = {
            status: "ready",
            serverContents: current.draftContents,
            draftContents: current.draftContents,
            version: result.version,
            error: null,
            dirty: false,
            readonly: current.readonly,
            binary: false,
            tooLarge: false,
            externalChange: false,
          };
          setState(targetKey, nextState);
          return nextState;
        },
        (error: unknown) => {
          const nextState: WorkspaceDocumentState = {
            ...current,
            status: isConflictError(error) ? "conflict" : "error",
            error: errorMessage(error, "Failed to save file."),
            dirty: true,
            externalChange: isConflictError(error) || current.externalChange,
          };
          setState(targetKey, nextState);
          return nextState;
        },
      );
  }

  function reload(target: WorkspaceDocumentTarget): Promise<WorkspaceDocumentState> {
    return load(target, { preserveDirty: false });
  }

  function revert(target: WorkspaceDocumentTarget): void {
    const targetKey = getWorkspaceDocumentTargetKey(target);
    if (targetKey === null) {
      return;
    }
    const current = getSnapshot(target);
    setState(targetKey, {
      ...current,
      status: current.serverContents === null ? current.status : "ready",
      draftContents: current.serverContents,
      dirty: false,
      error: null,
      externalChange: false,
    });
  }

  function markExternalChange(target: WorkspaceDocumentTarget): void {
    const targetKey = getWorkspaceDocumentTargetKey(target);
    if (targetKey === null) {
      return;
    }
    const current = getSnapshot(target);
    if (current.status === "idle") {
      return;
    }
    setState(targetKey, {
      ...current,
      externalChange: true,
    });
  }

  function applyChangeEvent(environmentId: EnvironmentId, event: WorkspaceFileChangeEvent): void {
    for (const targetKey of knownWorkspaceDocumentKeys) {
      const parsed = JSON.parse(targetKey) as [EnvironmentId, string, string];
      const [targetEnvironmentId, cwd, relativePath] = parsed;
      if (
        targetEnvironmentId === environmentId &&
        cwd === event.cwd &&
        relativePath === event.relativePath
      ) {
        const current = config.getRegistry().get(workspaceDocumentStateAtom(targetKey));
        if (!current.dirty && event.kind !== "deleted") {
          void load({ environmentId, cwd, relativePath }, { preserveDirty: false });
          continue;
        }
        setState(targetKey, {
          ...current,
          status: event.kind === "deleted" && !current.dirty ? "deleted" : current.status,
          externalChange: current.dirty || event.kind === "deleted",
        });
      }
    }
  }

  function reset(): void {
    loadInFlight.clear();
    for (const targetKey of knownWorkspaceDocumentKeys) {
      setState(targetKey, EMPTY_WORKSPACE_DOCUMENT_STATE);
    }
  }

  return {
    getSnapshot,
    load,
    edit,
    save,
    reload,
    revert,
    markExternalChange,
    applyChangeEvent,
    reset,
  };
}

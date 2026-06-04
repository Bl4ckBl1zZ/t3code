import { useAtomValue } from "@effect/atom-react";
import {
  createWorkspaceDocumentManager,
  createWorkspaceTreeManager,
  EMPTY_WORKSPACE_DOCUMENT_ATOM,
  EMPTY_WORKSPACE_DOCUMENT_STATE,
  EMPTY_WORKSPACE_TREE_DIRECTORY_ATOM,
  EMPTY_WORKSPACE_TREE_DIRECTORY_STATE,
  getWorkspaceDocumentTargetKey,
  getWorkspaceTreeTargetKey,
  parentWorkspaceTreeTarget,
  workspaceDocumentStateAtom,
  workspaceTreeDirectoryStateAtom,
  type WorkspaceDocumentState,
  type WorkspaceDocumentTarget,
  type WorkspaceTreeDirectoryState,
  type WorkspaceTreeTarget,
} from "@t3tools/client-runtime";
import type {
  EnvironmentId,
  WorkspaceCreateDirectoryInput,
  WorkspaceCreateFileInput,
  WorkspaceDeleteInput,
  WorkspaceRenameInput,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { readEnvironmentApi } from "../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const workspaceTreeManager = createWorkspaceTreeManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId);
    return connection ? connection.client.workspaceFiles : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
});

export const workspaceDocumentManager = createWorkspaceDocumentManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => readEnvironmentApi(environmentId)?.workspaceFiles ?? null,
});

export type {
  WorkspaceDocumentState,
  WorkspaceDocumentTarget,
  WorkspaceTreeDirectoryState,
  WorkspaceTreeTarget,
};

export function useWorkspaceDirectory(
  target: WorkspaceTreeTarget | null,
  options?: {
    readonly includeHidden?: boolean;
    readonly includeIgnored?: boolean;
    readonly limit?: number;
  },
): WorkspaceTreeDirectoryState {
  const targetKey = getWorkspaceTreeTargetKey(target);
  const environmentId = target?.environmentId;
  const cwd = target?.cwd;
  const relativePath = target?.relativePath;
  const includeHidden = options?.includeHidden;
  const includeIgnored = options?.includeIgnored;
  const limit = options?.limit;

  useEffect(() => {
    if (!environmentId || !cwd || relativePath === undefined) {
      return undefined;
    }
    const nextTarget = { environmentId, cwd, relativePath };
    const refreshOptions = {
      ...(includeHidden !== undefined ? { includeHidden } : {}),
      ...(includeIgnored !== undefined ? { includeIgnored } : {}),
      ...(limit !== undefined ? { limit } : {}),
      force: true,
    };
    const release = workspaceTreeManager.watch(nextTarget);
    void workspaceTreeManager.refresh(nextTarget, refreshOptions);
    return release;
  }, [environmentId, cwd, relativePath, includeHidden, includeIgnored, limit]);

  return useAtomValue(
    targetKey !== null
      ? workspaceTreeDirectoryStateAtom(targetKey)
      : EMPTY_WORKSPACE_TREE_DIRECTORY_ATOM,
  );
}

export function useWorkspaceDocument(
  target: WorkspaceDocumentTarget | null,
): WorkspaceDocumentState {
  const targetKey = getWorkspaceDocumentTargetKey(target);
  const environmentId = target?.environmentId;
  const cwd = target?.cwd;
  const relativePath = target?.relativePath;

  useEffect(() => {
    if (!environmentId || !cwd || !relativePath) {
      return undefined;
    }
    const nextTarget = { environmentId, cwd, relativePath };
    void workspaceDocumentManager.load(nextTarget, { preserveDirty: true });
    const api = readEnvironmentApi(environmentId);
    return api?.workspaceFiles.subscribeChanges({ cwd }, (event) => {
      workspaceDocumentManager.applyChangeEvent(environmentId, event);
    });
  }, [environmentId, cwd, relativePath]);

  return useAtomValue(
    targetKey !== null ? workspaceDocumentStateAtom(targetKey) : EMPTY_WORKSPACE_DOCUMENT_ATOM,
  );
}

export function getWorkspaceDocumentSnapshot(
  target: WorkspaceDocumentTarget | null,
): WorkspaceDocumentState {
  return target ? workspaceDocumentManager.getSnapshot(target) : EMPTY_WORKSPACE_DOCUMENT_STATE;
}

export function getWorkspaceDirectorySnapshot(
  target: WorkspaceTreeTarget | null,
): WorkspaceTreeDirectoryState {
  return target ? workspaceTreeManager.getSnapshot(target) : EMPTY_WORKSPACE_TREE_DIRECTORY_STATE;
}

export async function createWorkspaceFile(
  environmentId: EnvironmentId,
  input: WorkspaceCreateFileInput,
) {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("Workspace file client is unavailable.");
  const result = await api.workspaceFiles.createFile(input);
  workspaceTreeManager.applyCreateResult(environmentId, result);
  await workspaceTreeManager.refresh(
    parentWorkspaceTreeTarget({ environmentId, cwd: input.cwd, relativePath: result.relativePath }),
    { force: true },
  );
  return result;
}

export async function createWorkspaceDirectory(
  environmentId: EnvironmentId,
  input: WorkspaceCreateDirectoryInput,
) {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("Workspace file client is unavailable.");
  const result = await api.workspaceFiles.createDirectory(input);
  workspaceTreeManager.applyCreateResult(environmentId, result);
  await workspaceTreeManager.refresh(
    parentWorkspaceTreeTarget({ environmentId, cwd: input.cwd, relativePath: result.relativePath }),
    { force: true },
  );
  return result;
}

export async function renameWorkspacePath(
  environmentId: EnvironmentId,
  input: WorkspaceRenameInput,
) {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("Workspace file client is unavailable.");
  const result = await api.workspaceFiles.rename(input);
  workspaceTreeManager.applyRenameResult(environmentId, result);
  await workspaceTreeManager.refresh(
    parentWorkspaceTreeTarget({
      environmentId,
      cwd: input.cwd,
      relativePath: result.fromRelativePath,
    }),
    { force: true },
  );
  await workspaceTreeManager.refresh(
    parentWorkspaceTreeTarget({
      environmentId,
      cwd: input.cwd,
      relativePath: result.toRelativePath,
    }),
    { force: true },
  );
  return result;
}

export async function deleteWorkspacePath(
  environmentId: EnvironmentId,
  input: WorkspaceDeleteInput,
) {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("Workspace file client is unavailable.");
  const result = await api.workspaceFiles.delete(input);
  workspaceTreeManager.applyDeleteResult(environmentId, result);
  await workspaceTreeManager.refresh(
    parentWorkspaceTreeTarget({ environmentId, cwd: input.cwd, relativePath: result.relativePath }),
    { force: true },
  );
  return result;
}

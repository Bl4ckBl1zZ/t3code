import {
  EMPTY_WORKBENCH_TABS_STATE,
  reduceWorkbenchTabs,
  workbenchTabTitleFromPath,
  workspaceFileTabId,
  type WorkbenchTab,
  type WorkbenchTabsState,
} from "@t3tools/client-runtime";
import type { EnvironmentId, WorkspaceId } from "@t3tools/contracts";
import { create } from "zustand";

interface WorkbenchStoreState {
  readonly fileTabsState: WorkbenchTabsState;
  readonly activeSidebarPanel: "threads" | "explorer";
  readonly explorerRevealRequest: {
    readonly requestId: number;
    readonly environmentId: EnvironmentId;
    readonly workspaceId?: WorkspaceId | undefined;
    readonly cwd: string;
    readonly relativePath: string;
  } | null;
  readonly openFileTab: (input: {
    readonly environmentId: EnvironmentId;
    readonly workspaceId?: WorkspaceId | null | undefined;
    readonly cwd: string;
    readonly relativePath: string;
  }) => void;
  readonly setActiveSidebarPanel: (panel: "threads" | "explorer") => void;
  readonly revealFileInExplorer: (input: {
    readonly environmentId: EnvironmentId;
    readonly workspaceId?: WorkspaceId | null | undefined;
    readonly cwd: string;
    readonly relativePath: string;
  }) => void;
  readonly activateFileTab: (tabId: string | null) => void;
  readonly closeFileTab: (tabId: string) => void;
  readonly setFileTabDirty: (tabId: string, dirty: boolean) => void;
}

export const useWorkbenchStore = create<WorkbenchStoreState>((set) => ({
  fileTabsState: EMPTY_WORKBENCH_TABS_STATE,
  activeSidebarPanel: "threads",
  explorerRevealRequest: null,
  openFileTab: (input) =>
    set((state) => {
      const id = workspaceFileTabId(input);
      const tab: WorkbenchTab = {
        kind: "file",
        id,
        environmentId: input.environmentId,
        ...(input.workspaceId != null ? { workspaceId: input.workspaceId } : {}),
        cwd: input.cwd,
        relativePath: input.relativePath,
        title: workbenchTabTitleFromPath(input.relativePath),
        dirty: false,
      };
      return {
        fileTabsState: reduceWorkbenchTabs(state.fileTabsState, {
          type: "open",
          tab,
        }),
      };
    }),
  setActiveSidebarPanel: (panel) => set({ activeSidebarPanel: panel }),
  revealFileInExplorer: (input) =>
    set((state) => ({
      activeSidebarPanel: "explorer",
      explorerRevealRequest: {
        requestId: (state.explorerRevealRequest?.requestId ?? 0) + 1,
        environmentId: input.environmentId,
        ...(input.workspaceId != null ? { workspaceId: input.workspaceId } : {}),
        cwd: input.cwd,
        relativePath: input.relativePath,
      },
    })),
  activateFileTab: (tabId) =>
    set((state) => ({
      fileTabsState: tabId
        ? reduceWorkbenchTabs(state.fileTabsState, { type: "activate", tabId })
        : { ...state.fileTabsState, activeTabId: null },
    })),
  closeFileTab: (tabId) =>
    set((state) => ({
      fileTabsState: reduceWorkbenchTabs(state.fileTabsState, { type: "close", tabId }),
    })),
  setFileTabDirty: (tabId, dirty) =>
    set((state) => ({
      fileTabsState: reduceWorkbenchTabs(state.fileTabsState, {
        type: "set-file-dirty",
        tabId,
        dirty,
      }),
    })),
}));

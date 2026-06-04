import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

export type WorkbenchTab =
  | {
      readonly kind: "chat";
      readonly id: string;
      readonly threadRef: ScopedThreadRef;
      readonly title: string;
      readonly dirty: false;
    }
  | {
      readonly kind: "file";
      readonly id: string;
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly relativePath: string;
      readonly title: string;
      readonly dirty: boolean;
    }
  | {
      readonly kind: "diff";
      readonly id: string;
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly relativePath?: string;
      readonly title: string;
      readonly dirty: false;
    }
  | {
      readonly kind: "terminal";
      readonly id: string;
      readonly environmentId: EnvironmentId;
      readonly cwd: string;
      readonly terminalId: string;
      readonly title: string;
      readonly dirty: false;
    };

export interface WorkbenchTabsState {
  readonly tabs: ReadonlyArray<WorkbenchTab>;
  readonly activeTabId: string | null;
}

export type WorkbenchTabsAction =
  | { readonly type: "open"; readonly tab: WorkbenchTab; readonly activate?: boolean }
  | { readonly type: "close"; readonly tabId: string }
  | { readonly type: "activate"; readonly tabId: string }
  | { readonly type: "set-file-dirty"; readonly tabId: string; readonly dirty: boolean }
  | {
      readonly type: "replace-tabs";
      readonly tabs: ReadonlyArray<WorkbenchTab>;
      readonly activeTabId: string | null;
    };

export const EMPTY_WORKBENCH_TABS_STATE: WorkbenchTabsState = {
  tabs: [],
  activeTabId: null,
};

export function workspaceFileTabId(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}): string {
  return `file:${JSON.stringify([input.environmentId, input.cwd, input.relativePath])}`;
}

export function workbenchTabTitleFromPath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/\/+$/g, "");
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
}

export function reduceWorkbenchTabs(
  state: WorkbenchTabsState,
  action: WorkbenchTabsAction,
): WorkbenchTabsState {
  switch (action.type) {
    case "open": {
      const existingIndex = state.tabs.findIndex((tab) => tab.id === action.tab.id);
      const tabs =
        existingIndex === -1
          ? [...state.tabs, action.tab]
          : state.tabs.map((tab, index) =>
              index === existingIndex ? { ...tab, ...action.tab } : tab,
            );
      return {
        tabs,
        activeTabId: action.activate === false ? state.activeTabId : action.tab.id,
      };
    }
    case "close": {
      const closedIndex = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (closedIndex === -1) {
        return state;
      }
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      const activeTabId =
        state.activeTabId !== action.tabId
          ? state.activeTabId
          : (tabs[closedIndex]?.id ?? tabs[closedIndex - 1]?.id ?? null);
      return { tabs, activeTabId };
    }
    case "activate":
      return state.tabs.some((tab) => tab.id === action.tabId)
        ? { ...state, activeTabId: action.tabId }
        : state;
    case "set-file-dirty":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId && tab.kind === "file" ? { ...tab, dirty: action.dirty } : tab,
        ),
      };
    case "replace-tabs":
      return {
        tabs: action.tabs,
        activeTabId:
          action.activeTabId && action.tabs.some((tab) => tab.id === action.activeTabId)
            ? action.activeTabId
            : (action.tabs[0]?.id ?? null),
      };
  }
}

import * as Schema from "effect/Schema";

import type { SidebarWorkspace } from "./components/Sidebar.logic";
import { getLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";

/**
 * The workspace the sidebar is in (Code / Work / Chat). Persisted rather than
 * routed: surfaces outside the sidebar — the index landing, the send path that
 * stamps a Hermes thread's inbox role — have to know which side the user is on
 * before any thread exists to read it from.
 */
export const SIDEBAR_WORKSPACE_STORAGE_KEY = "t3code:sidebar-workspace";
export const SIDEBAR_WORKSPACE_SCHEMA = Schema.Literals(["work", "code", "chat"]);
const DEFAULT_SIDEBAR_WORKSPACE: SidebarWorkspace = "code";

export function useSidebarWorkspace(): [
  SidebarWorkspace,
  (value: SidebarWorkspace | ((current: SidebarWorkspace) => SidebarWorkspace)) => void,
] {
  return useLocalStorage<SidebarWorkspace, SidebarWorkspace>(
    SIDEBAR_WORKSPACE_STORAGE_KEY,
    DEFAULT_SIDEBAR_WORKSPACE,
    SIDEBAR_WORKSPACE_SCHEMA,
  );
}

/**
 * Non-reactive read for code running outside render (send paths, effects).
 * Unreadable or unrecognized storage falls back to Code — the workspace this
 * app opens in — rather than throwing into the caller.
 */
export function readSidebarWorkspace(): SidebarWorkspace {
  try {
    return (
      getLocalStorageItem(SIDEBAR_WORKSPACE_STORAGE_KEY, SIDEBAR_WORKSPACE_SCHEMA) ??
      DEFAULT_SIDEBAR_WORKSPACE
    );
  } catch {
    return DEFAULT_SIDEBAR_WORKSPACE;
  }
}

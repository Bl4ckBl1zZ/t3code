import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, WorkspaceId } from "@t3tools/contracts";

import {
  EMPTY_WORKBENCH_TABS_STATE,
  reduceWorkbenchTabs,
  workspaceFileTabId,
  type WorkbenchTab,
} from "./workbenchTabsState.ts";

const environmentId = EnvironmentId.make("env-local");
const workspaceA = WorkspaceId.make("workspace-a");
const workspaceB = WorkspaceId.make("workspace-b");

describe("workspaceFileTabId", () => {
  it("separates equal cwd/path pairs by workspace id when present", () => {
    const base = {
      environmentId,
      cwd: "/repo",
      relativePath: "src/index.ts",
    } as const;

    expect(workspaceFileTabId({ ...base, workspaceId: workspaceA })).not.toBe(
      workspaceFileTabId({ ...base, workspaceId: workspaceB }),
    );
    expect(workspaceFileTabId(base)).not.toBe(
      workspaceFileTabId({ ...base, workspaceId: workspaceA }),
    );
  });
});

describe("reduceWorkbenchTabs", () => {
  it("keeps workspace-owned file tabs distinct and falls back to the previous tab after close", () => {
    const tabA: WorkbenchTab = {
      kind: "file",
      id: workspaceFileTabId({
        environmentId,
        workspaceId: workspaceA,
        cwd: "/repo",
        relativePath: "src/index.ts",
      }),
      environmentId,
      workspaceId: workspaceA,
      cwd: "/repo",
      relativePath: "src/index.ts",
      title: "index.ts",
      dirty: false,
    };
    const tabB: WorkbenchTab = {
      ...tabA,
      id: workspaceFileTabId({
        environmentId,
        workspaceId: workspaceB,
        cwd: "/repo",
        relativePath: "src/index.ts",
      }),
      workspaceId: workspaceB,
    };

    const openedA = reduceWorkbenchTabs(EMPTY_WORKBENCH_TABS_STATE, {
      type: "open",
      tab: tabA,
    });
    const openedB = reduceWorkbenchTabs(openedA, {
      type: "open",
      tab: tabB,
    });
    const closedB = reduceWorkbenchTabs(openedB, {
      type: "close",
      tabId: tabB.id,
    });

    expect(openedB.tabs).toHaveLength(2);
    expect(openedB.activeTabId).toBe(tabB.id);
    expect(closedB.tabs).toEqual([tabA]);
    expect(closedB.activeTabId).toBe(tabA.id);
  });
});

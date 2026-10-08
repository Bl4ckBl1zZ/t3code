import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  worktreePath: "/tmp/worktree" as string | null,
  showContextMenu: vi.fn().mockResolvedValue("copy-path"),
  writeTextToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: state.showContextMenu } }),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: state.writeTextToClipboard,
}));
vi.mock("./BranchToolbarBranchSelector", () => ({ BranchToolbarBranchSelector: () => null }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({ getDraftThreadByRef: () => null, setDraftThreadContext: vi.fn() }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => ({
    environmentId: "local",
    projectId: "project",
    worktreePath: state.worktreePath,
  }),
  useProject: () => ({ workspaceRoot: "/tmp/project" }),
  useThreadShellsForProjectRefs: () => [],
}));
// Menus and tooltips render their trigger in place so the row reads without a DOM.
vi.mock("./ui/menu", () => {
  const Trigger = ({ render, children, ...props }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, props, children);
  const Passthrough = ({ children }: { children: ReactNode }) => children;
  return {
    Menu: Passthrough,
    MenuTrigger: Trigger,
    MenuPopup: () => null,
    MenuGroup: Passthrough,
    MenuGroupLabel: Passthrough,
    MenuRadioGroup: Passthrough,
    MenuRadioItem: Passthrough,
    MenuSeparator: () => null,
  };
});
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

import { BranchToolbar } from "./BranchToolbar";
import type { EnvMode } from "./BranchToolbar.logic";

let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.showContextMenu.mockClear();
  state.writeTextToClipboard.mockClear();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  state.worktreePath = "/tmp/worktree";
  vi.unstubAllGlobals();
});

async function renderPanel(input: {
  envMode: EnvMode;
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}) {
  await act(async () => {
    renderer = create(
      <BranchToolbar
        layout="panel"
        panelSection="workspace"
        environmentId={EnvironmentId.make("local")}
        threadId={ThreadId.make("thread")}
        showGitControls
        envMode={input.envMode}
        envLocked={false}
        startFromOrigin={false}
        onStartFromOriginChange={vi.fn()}
        onEnvModeChange={vi.fn()}
        {...(input.onEnvironmentChange
          ? {
              onEnvironmentChange: input.onEnvironmentChange,
              availableEnvironments: ["local", "remote"].map((id) => ({
                environmentId: EnvironmentId.make(id),
                projectId: ProjectId.make("project"),
                label: id,
                isPrimary: id === "local",
              })),
            }
          : {})}
      />,
    );
  });
  return renderer.root.findByProps({ "aria-label": "Run context" });
}

it("keeps machine choices openable when the combined row's workspace is locked", async () => {
  const row = await renderPanel({ envMode: "local", onEnvironmentChange: vi.fn() });
  // A started thread in a worktree pins its workspace, yet the row is still a menu trigger.
  expect(row.type).not.toBe("span");
});

it("renders a static row when there is nothing to choose", async () => {
  const row = await renderPanel({ envMode: "local" });
  expect(row.type).toBe("span");
});

it.each([
  ["local", null, "/tmp/project"],
  ["worktree", null, null],
  ["worktree", "/tmp/worktree", "/tmp/worktree"],
] as const)(
  "copies only an existing workspace path with mode %s and worktree %s",
  async (envMode, worktreePath, copiedPath) => {
    state.worktreePath = worktreePath;
    const row = await renderPanel({ envMode });
    const event = {
      clientX: 0,
      clientY: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    await act(async () => row.props.onContextMenu(event));
    expect(event.preventDefault).toHaveBeenCalledTimes(copiedPath === null ? 0 : 1);
    if (copiedPath === null) {
      expect(state.showContextMenu).not.toHaveBeenCalled();
      expect(state.writeTextToClipboard).not.toHaveBeenCalled();
    } else {
      expect(state.writeTextToClipboard).toHaveBeenCalledWith(copiedPath, "workspace path");
    }
  },
);

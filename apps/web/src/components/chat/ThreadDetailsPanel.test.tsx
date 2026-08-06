import type { EnvironmentId, T3ProjectFileScript, ThreadId } from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  useT3ProjectFilePreviewUrl: vi.fn(),
  projectScriptsControl: vi.fn(),
  backgroundTasksPanel: vi.fn(),
  relationshipsPanel: vi.fn(),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
  useT3ProjectFilePreviewUrl: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFilePreviewUrl(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
// Stands in for a thread with no relationships yet: the real panel renders the
// fallback in that case, so tests can read what the empty panel looks like.
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: (props: { emptyFallback?: ReactNode }) => {
    testState.relationshipsPanel(props);
    return props.emptyFallback ?? null;
  },
}));
vi.mock("./ThreadBackgroundTasksPanel", () => ({
  ThreadBackgroundTasksPanel: (props: unknown) => {
    testState.backgroundTasksPanel(props);
    return null;
  },
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

function baseProps(): ThreadDetailsPanelProps {
  return {
    mode: "popover",
    environmentId: "environment:thread-details" as EnvironmentId,
    environmentConnection: null,
    threadId: "thread:thread-details" as ThreadId,
    activeProjectName: undefined,
    activeProjectScripts: [],
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    showOpenInPicker: false,
    gitCwd: "/tmp/thread-details-project",
    isGitRepo: false,
    isServerThread: true,
    isProjectlessConversation: false,
    envLocked: false,
    availableEnvironments: [],
    onEnvironmentChange: vi.fn(),
    onEnvModeChange: vi.fn(),
    startFromOrigin: false,
    onStartFromOriginChange: vi.fn(),
    onComposerFocusRequest: vi.fn(),
    onReconnectEnvironment: vi.fn(),
    onOpenConnectionSettings: vi.fn(),
    versionMismatch: null,
    onDismissVersionMismatch: vi.fn(),
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
    onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
    onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
  };
}

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.useT3ProjectFilePreviewUrl.mockReset();
    testState.useT3ProjectFilePreviewUrl.mockReturnValue(null);
    testState.projectScriptsControl.mockReset();
    testState.backgroundTasksPanel.mockReset();
    testState.relationshipsPanel.mockReset();
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const props = baseProps();
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(
      props.environmentId,
      props.gitCwd,
    );
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  // A sent draft keeps its draft id and its `/draft/…` route while a live thread
  // runs underneath, so gating this section on the draft id hid every background
  // command a thread started on its very first turn.
  it("shows background tasks for a sent draft that now has a server thread", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    renderToStaticMarkup(
      <ThreadDetailsPanel
        {...baseProps()}
        draftId={"draft:thread-details" as DraftId}
        isServerThread
      />,
    );

    expect(testState.backgroundTasksPanel).toHaveBeenCalled();
  });

  it("hides background tasks for a draft with no thread behind it", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    renderToStaticMarkup(
      <ThreadDetailsPanel
        {...baseProps()}
        draftId={"draft:thread-details" as DraftId}
        isServerThread={false}
      />,
    );

    expect(testState.backgroundTasksPanel).not.toHaveBeenCalled();
  });

  // A Hermes chat has no workspace, so what it delegated is the only thing the
  // panel can show. Gating that on the draft id left the panel stuck on its
  // "nothing yet" copy for the whole session.
  it("shows relationships on a Hermes chat still sitting on its draft route", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    renderToStaticMarkup(
      <ThreadDetailsPanel
        {...baseProps()}
        draftId={"draft:thread-details" as DraftId}
        isServerThread
        isProjectlessConversation
      />,
    );

    expect(testState.relationshipsPanel).toHaveBeenCalledWith(
      expect.objectContaining({ emptyFallback: expect.anything() }),
    );
  });

  it("names the delegated tasks section on a Hermes chat with nothing delegated yet", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel {...baseProps()} isServerThread isProjectlessConversation />,
    );

    expect(markup).toContain("Delegated tasks");
  });

  it("keeps the delegated tasks placeholder before a Hermes draft has a thread", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    const markup = renderToStaticMarkup(
      <ThreadDetailsPanel
        {...baseProps()}
        draftId={"draft:thread-details" as DraftId}
        isServerThread={false}
        isProjectlessConversation
      />,
    );

    expect(testState.relationshipsPanel).not.toHaveBeenCalled();
    expect(markup).toContain("Delegated tasks");
  });

  it("leaves the relationships section unlabelled on a coding thread", () => {
    testState.useT3ProjectFileScripts.mockReturnValue([]);
    renderToStaticMarkup(<ThreadDetailsPanel {...baseProps()} isServerThread />);

    expect(testState.relationshipsPanel).toHaveBeenCalledWith(
      expect.not.objectContaining({ emptyFallback: expect.anything() }),
    );
  });
});

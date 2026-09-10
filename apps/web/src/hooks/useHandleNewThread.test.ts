import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  return {
    remoteConfig: {
      environment: { capabilities: { projectDefaults: true } },
      settings: {
        defaultThreadEnvMode: "worktree",
        newWorktreesStartFromOrigin: true,
        defaultModelSelection: { instanceId: "remote-account", model: "remote-model" },
      },
    },
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    reset(nextStoredDraft: typeof storedDraft) {
      storedDraft = nextStoredDraft;
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setModelSelection.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "configs"
      ? new Map([["environment-ssh", testState.remoteConfig]])
      : { defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: false },
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({ DEFAULT_RUNTIME_MODE: "default" }));
vi.mock("@t3tools/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: (input: {
    readonly projectFile: "local" | "worktree" | null;
    readonly globalDefault: "local" | "worktree";
  }) => input.projectFile ?? input.globalDefault,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", () => ({
  hasExplicitComposerModelSelection: () => false,
  resolveNewDraftStartFromOrigin: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFileDefaultThreadEnvMode: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({
  primaryServerSettingsAtom: "settings",
  environmentServerConfigsAtom: "configs",
}));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: Object.assign(() => [], {
    getState: () => ({ setLastNewThreadProjectKey: vi.fn() }),
  }),
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "./useHandleNewThread";

describe("useNewThreadHandler", () => {
  it("uses the destination machine's model and workspace defaults for a fresh draft", async () => {
    testState.reset(null);
    const pending = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.completeProjectFileRead(null);
    await pending;
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
      "draft-delayed",
      testState.remoteConfig.settings.defaultModelSelection,
      { replaceOptions: true },
    );
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      "draft-delayed",
      expect.objectContaining({ envMode: "worktree" }),
    );
  });

  it("keeps an explicit model choice ahead of the machine default", async () => {
    testState.reset(null);
    const choice = { instanceId: "chosen-account", model: "chosen-model" };
    const pending = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { modelSelection: choice as never, envMode: "local" },
    );
    testState.completeProjectFileRead(null);
    await pending;
    expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith("draft-delayed", choice, {
      replaceOptions: true,
    });
  });

  it.each([
    ["new", null],
    [
      "reusable",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
    ],
  ])("abandons a delayed %s draft open when the user navigates elsewhere", async (_, draft) => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });
});

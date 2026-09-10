import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, ProjectId, RunId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  useRightPanelStore,
  pullRequestSurface,
  selectActiveRightPanelSurface,
  type RightPanelSurface,
} from "../rightPanelStore";
import {
  observeProactivePanelUserChoice,
  shouldOpenProactivePullRequest,
  shouldOpenProactiveRunDiff,
  resolveProactiveRunDiffAction,
  shouldRetargetThreadPullRequestPanel,
} from "./proactivePanels";

describe("proactive panels", () => {
  it("keeps a manual PR selection made after following a replacement while loading", () => {
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
    const panels = useRightPanelStore.getState();
    const oldPr = pullRequestSurface({
      projectId: "project-1",
      repository: "owner/repo",
      number: 1,
    });
    const replacement = pullRequestSurface({ ...oldPr, number: 2 });
    const turnId = RunId.make("turn-1");
    panels.openPullRequest(ref, oldPr);
    const loading = observeProactivePanelUserChoice(null, {
      threadKey: "env-1:thread-1",
      runningRunId: turnId,
      userActionRevision: panels.getUserActionRevision(ref),
    });
    expect(panels.openProactive(ref, replacement, loading.userActionRevision)).toBe(true);

    panels.activateSurface(ref, oldPr.id);
    const loaded = observeProactivePanelUserChoice(loading, {
      threadKey: loading.threadKey,
      runningRunId: turnId,
      userActionRevision: panels.getUserActionRevision(ref),
    });
    expect(panels.openProactive(ref, replacement, loaded.userActionRevision)).toBe(false);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)).toEqual(
      oldPr,
    );
    expect(shouldOpenProactivePullRequest(loaded.targetKey, "owner/repo:2")).toBe(true);
    expect(
      shouldOpenProactiveRunDiff({
        previousRunningRunId: loaded.runningRunId,
        runningRunId: null,
        settledRunId: turnId,
        runCompleted: true,
      }),
    ).toBe(true);
    expect(panels.openProactive(ref, { id: "diff", kind: "diff" }, loaded.userActionRevision)).toBe(
      false,
    );
  });

  it.each(["idle", "loading", "observed"] as const)(
    "captures a new turn's choice once with initial state %s",
    (initialState) => {
      useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
      const ref = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
      const panels = useRightPanelStore.getState();
      const firstTurn = RunId.make("turn-1");
      const nextTurn = RunId.make("turn-2");
      const initial = observeProactivePanelUserChoice(null, {
        threadKey: "env-1:thread-1",
        runningRunId: initialState === "idle" ? null : firstTurn,
        userActionRevision: panels.getUserActionRevision(ref),
      });
      panels.openFile(ref, "src/first.ts");
      const loadingNextTurn = observeProactivePanelUserChoice(
        {
          ...initial,
          ...(initialState === "observed" ? { runningRunId: firstTurn, targetKey: null } : {}),
        },
        {
          threadKey: initial.threadKey,
          runningRunId: nextTurn,
          userActionRevision: panels.getUserActionRevision(ref),
        },
      );
      expect(
        panels.openProactive(ref, { id: "diff", kind: "diff" }, loadingNextTurn.userActionRevision),
      ).toBe(true);

      panels.openFile(ref, "src/second.ts");
      const loaded = observeProactivePanelUserChoice(loadingNextTurn, {
        threadKey: initial.threadKey,
        runningRunId: nextTurn,
        userActionRevision: panels.getUserActionRevision(ref),
      });
      expect(
        panels.openProactive(ref, { id: "diff", kind: "diff" }, loaded.userActionRevision),
      ).toBe(false);
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.id,
      ).toBe("file:src/second.ts");
    },
  );

  it("opens an existing pull request on entry and follows newly observed links", () => {
    expect(shouldOpenProactivePullRequest(undefined, "project:repo:42")).toBe(true);
    expect(shouldOpenProactivePullRequest(undefined, null)).toBe(false);
    expect(shouldOpenProactivePullRequest(null, "project:repo:42")).toBe(true);
    expect(shouldOpenProactivePullRequest("project:repo:42", "project:repo:42")).toBe(false);
    expect(shouldOpenProactivePullRequest("project:repo:42", null)).toBe(false);
  });

  it("follows a changed server PR link without replacing an unrelated open panel", () => {
    const previous = {
      projectId: ProjectId.make("project-1"),
      repository: "pingdotgg/t3code",
      number: 42,
      url: "https://github.com/pingdotgg/t3code/pull/42",
    };
    const current = {
      ...previous,
      number: 43,
      url: "https://github.com/pingdotgg/t3code/pull/43",
    };
    const surface = {
      id: "pull-request:previous",
      kind: "pull-request",
      projectId: previous.projectId,
      repository: "PingDotGG/T3Code",
      number: previous.number,
    } satisfies RightPanelSurface;

    expect(shouldRetargetThreadPullRequestPanel(previous, current, surface)).toBe(true);
    expect(shouldRetargetThreadPullRequestPanel(previous, previous, surface)).toBe(false);
    expect(shouldRetargetThreadPullRequestPanel(previous, null, surface)).toBe(false);
    expect(
      shouldRetargetThreadPullRequestPanel(previous, current, { ...surface, number: 99 }),
    ).toBe(false);
    expect(
      shouldRetargetThreadPullRequestPanel(previous, current, {
        ...surface,
        projectId: "another-project",
      }),
    ).toBe(false);
  });

  it("opens a completed diff on entry or when the observed running turn settles", () => {
    const turnId = RunId.make("turn-1");
    expect(
      shouldOpenProactiveRunDiff({
        previousRunningRunId: undefined,
        runningRunId: null,
        settledRunId: turnId,
        runCompleted: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenProactiveRunDiff({
        previousRunningRunId: turnId,
        runningRunId: null,
        settledRunId: turnId,
        runCompleted: true,
      }),
    ).toBe(true);
    expect(
      shouldOpenProactiveRunDiff({
        previousRunningRunId: turnId,
        runningRunId: RunId.make("turn-2"),
        settledRunId: turnId,
        runCompleted: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenProactiveRunDiff({
        previousRunningRunId: turnId,
        runningRunId: null,
        settledRunId: turnId,
        runCompleted: false,
      }),
    ).toBe(false);
  });

  it("opens a completed turn diff only for changed files", () => {
    const changedCheckpoint = {
      status: "ready",
      files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    } satisfies Pick<ThreadCheckpointSummary, "status" | "files">;
    const unchangedCheckpoint = {
      status: "ready",
      files: [],
    } satisfies Pick<ThreadCheckpointSummary, "status" | "files">;

    expect(
      resolveProactiveRunDiffAction({
        checkpoint: changedCheckpoint,
        isGitRepo: true,
      }),
    ).toBe("open");
    expect(
      resolveProactiveRunDiffAction({
        checkpoint: unchangedCheckpoint,
        isGitRepo: true,
      }),
    ).toBe("ignore");
  });

  it("waits for definitive checkpoint and repository state", () => {
    const missingCheckpoint = {
      status: "missing",
      files: [],
    } satisfies Pick<ThreadCheckpointSummary, "status" | "files">;
    const changedCheckpoint = {
      status: "ready",
      files: [{ path: "src/app.ts", kind: "modified", additions: 1, deletions: 0 }],
    } satisfies Pick<ThreadCheckpointSummary, "status" | "files">;

    expect(
      resolveProactiveRunDiffAction({
        checkpoint: undefined,
        isGitRepo: true,
      }),
    ).toBe("defer");
    expect(
      resolveProactiveRunDiffAction({
        checkpoint: missingCheckpoint,
        isGitRepo: true,
      }),
    ).toBe("defer");
    expect(
      resolveProactiveRunDiffAction({
        checkpoint: changedCheckpoint,
        isGitRepo: undefined,
      }),
    ).toBe("defer");
  });
});

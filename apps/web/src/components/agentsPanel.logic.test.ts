import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";

import {
  agentRowState,
  buildAgentsPanelModel,
  formatTokenCount,
  resolveAgentKind,
  workflowPhaseProgress,
} from "./agentsPanel.logic";

// Branded ids and DateTime fields are irrelevant to this logic, so fixtures
// are written as plain values and cast once here rather than at every call.
function subagent(
  overrides: Partial<Record<keyof OrchestrationV2Subagent, unknown>> = {},
): OrchestrationV2Subagent {
  return {
    id: "node-1",
    threadId: "thread-1",
    runId: "run-1",
    parentNodeId: "node-0",
    origin: "app_owned",
    createdBy: "agent",
    driver: "claude",
    providerInstanceId: "provider-1",
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "do the thing",
    title: null,
    model: null,
    status: "running",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    ...overrides,
  } as unknown as OrchestrationV2Subagent;
}

describe("agentRowState", () => {
  it("treats waiting as idle, not active", () => {
    // A task blocked on approval is not making progress; animating it would
    // claim otherwise.
    expect(agentRowState("waiting")).toBe("idle");
    expect(agentRowState("pending")).toBe("idle");
    expect(agentRowState("running")).toBe("active");
  });

  it("maps every non-completed terminal status to failed", () => {
    expect(agentRowState("completed")).toBe("done");
    expect(agentRowState("failed")).toBe("failed");
    expect(agentRowState("cancelled")).toBe("failed");
    expect(agentRowState("interrupted")).toBe("failed");
  });
});

describe("resolveAgentKind", () => {
  it("prefers the server-stamped kind", () => {
    // Stamped background wins even though the task type would classify as an
    // agent -- the server saw the parent linkage the client cannot.
    expect(resolveAgentKind({ agentKind: "background", taskType: "subagent" })).toBe("background");
  });

  it("falls back to classification for rows written before the stamp existed", () => {
    expect(resolveAgentKind({ agentKind: undefined, taskType: "monitor" })).toBe("background");
    expect(resolveAgentKind({ agentKind: undefined, taskType: undefined })).toBe("agent");
  });
});

describe("buildAgentsPanelModel", () => {
  it("splits agents from background work", () => {
    const model = buildAgentsPanelModel([
      subagent({ id: "a", agentKind: "agent" }),
      subagent({ id: "b", agentKind: "background", taskType: "monitor" }),
    ]);
    expect(model.agents.map((row) => row.id)).toEqual(["a"]);
    expect(model.background.map((row) => row.id)).toEqual(["b"]);
  });

  it("counts background work toward the active badge", () => {
    // The badge answers "is anything still running", and a live watch loop is.
    const model = buildAgentsPanelModel([
      subagent({ id: "a", agentKind: "agent", status: "completed" }),
      subagent({ id: "b", agentKind: "background", taskType: "shell", status: "running" }),
    ]);
    expect(model.activeCount).toBe(1);
  });

  it("sinks terminal rows below live ones", () => {
    const model = buildAgentsPanelModel([
      subagent({ id: "done", status: "completed", startedAt: "2026-08-07T10:00:00.000Z" }),
      subagent({ id: "live", status: "running", startedAt: "2026-08-07T09:00:00.000Z" }),
    ]);
    // Live sorts first even though it started earlier.
    expect(model.agents.map((row) => row.id)).toEqual(["live", "done"]);
  });

  it("orders newest-first within the live half", () => {
    const model = buildAgentsPanelModel([
      subagent({ id: "old", status: "running", startedAt: "2026-08-07T09:00:00.000Z" }),
      subagent({ id: "new", status: "running", startedAt: "2026-08-07T11:00:00.000Z" }),
    ]);
    expect(model.agents.map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("falls back through title, workflow name, then prompt for the label", () => {
    expect(buildAgentsPanelModel([subagent({ title: "Reviewer" })]).agents[0]?.title).toBe(
      "Reviewer",
    );
    expect(
      buildAgentsPanelModel([
        subagent({ title: null, workflow: { name: "review-changes", phases: [] } }),
      ]).agents[0]?.title,
    ).toBe("review-changes");
    expect(
      buildAgentsPanelModel([subagent({ title: null, prompt: "first line\nsecond line" })])
        .agents[0]?.title,
    ).toBe("first line");
  });
});

describe("workflowPhaseProgress", () => {
  it("returns null when no phases were declared", () => {
    expect(workflowPhaseProgress(undefined)).toBeNull();
    expect(workflowPhaseProgress({ phases: [] })).toBeNull();
  });

  it("resolves position by title", () => {
    const progress = workflowPhaseProgress({
      phases: [
        { index: 0, title: "Scan" },
        { index: 1, title: "Fix" },
        { index: 2, title: "Verify" },
      ],
      currentPhase: "Fix",
    });
    expect(progress).toEqual({ current: 2, total: 3 });
  });

  it("reports progress running backwards when a script revisits a phase", () => {
    // Honest over monotonic: the workflow really is back in phase 1.
    const progress = workflowPhaseProgress({
      phases: [
        { index: 0, title: "Scan" },
        { index: 1, title: "Fix" },
      ],
      currentPhase: "Scan",
    });
    expect(progress).toEqual({ current: 1, total: 2 });
  });

  it("counts an undeclared current phase as started rather than dropping it", () => {
    const progress = workflowPhaseProgress({
      phases: [{ index: 0, title: "Scan" }],
      currentPhase: "Improvised",
    });
    expect(progress).toEqual({ current: 1, total: 1 });
  });

  it("reports zero progress before any phase is entered", () => {
    expect(workflowPhaseProgress({ phases: [{ index: 0, title: "Scan" }] })).toEqual({
      current: 0,
      total: 1,
    });
  });
});

describe("formatTokenCount", () => {
  it("keeps small counts exact", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("compacts thousands and millions", () => {
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(45_000)).toBe("45k");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});

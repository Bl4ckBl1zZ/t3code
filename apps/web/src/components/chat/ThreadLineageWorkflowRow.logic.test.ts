import type { OrchestrationV2Subagent, OrchestrationV2WorkflowAgent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkflowGroup, workflowPhaseStatusLabel } from "./ThreadLineageWorkflowRow.logic";

type Coordinator = Parameters<typeof deriveWorkflowGroup>[0];

const coordinator = (overrides: Partial<Coordinator> = {}): Coordinator => ({
  status: "running",
  completedAt: null,
  workflow: { phases: [], agents: [] },
  ...overrides,
});

const member = (
  overrides: Partial<OrchestrationV2WorkflowAgent> = {},
): OrchestrationV2WorkflowAgent => ({
  index: 1,
  label: "alpha:one",
  state: "running",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

const workflowOf = (
  agents: ReadonlyArray<OrchestrationV2WorkflowAgent>,
  phases: NonNullable<OrchestrationV2Subagent["workflow"]>["phases"] = [],
) => ({ phases, agents });

describe("deriveWorkflowGroup", () => {
  it("leaves a subagent without a reported roster as a plain row", () => {
    expect(deriveWorkflowGroup(coordinator({ workflow: undefined }))).toBeNull();
    expect(deriveWorkflowGroup(coordinator({ workflow: { phases: [] } }))).toBeNull();
    expect(deriveWorkflowGroup(coordinator())).toEqual({ phases: [], unphasedMembers: [] });
  });

  it("groups members under their phases and counts the run", () => {
    const group = deriveWorkflowGroup(
      coordinator({
        workflow: workflowOf(
          [
            member({ state: "completed" }),
            member({ index: 2, label: "alpha:two", state: "failed" }),
            member({ index: 3, label: "beta:one", phaseIndex: 2, phaseTitle: "Beta" }),
            member({
              index: 4,
              label: "beta:two",
              phaseIndex: 2,
              phaseTitle: "Beta",
              state: "queued",
            }),
          ],
          [
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
        ),
      }),
    );
    expect(group?.phases.map((phase) => [phase.title, phase.state, phase.settledCount])).toEqual([
      ["Alpha", "done", 2],
      ["Beta", "running", 0],
    ]);
    expect(group?.phases.map(workflowPhaseStatusLabel)).toEqual(["failed", "running"]);
    // A queued member is not started work: it reports no clock.
    const queued = group?.phases[1]?.members[1];
    expect(queued?.status).toBe("pending");
    expect(queued?.startedAt).toBeNull();
    expect(group?.unphasedMembers).toEqual([]);
  });

  it("shows a phase the script only reached at runtime", () => {
    const group = deriveWorkflowGroup(
      coordinator({
        // The declared plan has not caught up with the member's phase yet.
        workflow: workflowOf(
          [
            member({ state: "completed" }),
            member({ index: 2, label: "dynamic:late", phaseIndex: 3, phaseTitle: "Gamma" }),
          ],
          [{ index: 1, title: "Alpha" }],
        ),
      }),
    );
    expect(group?.phases.map((phase) => phase.title)).toEqual(["Alpha", "Gamma"]);
  });

  it.each([false, true])("keeps a reported phase title, missing title first=%s", (missingFirst) => {
    const agents = [member({ phaseTitle: "Review" }), member({ index: 2, phaseTitle: undefined })];
    const group = deriveWorkflowGroup(
      coordinator({ workflow: workflowOf(missingFirst ? agents.toReversed() : agents) }),
    );
    expect(group?.phases[0]?.title).toBe("Review");
  });

  it("keeps unphased members under the workflow in spawn order", () => {
    const group = deriveWorkflowGroup(
      coordinator({
        workflow: workflowOf([
          member({ index: 2, label: "second", phaseIndex: undefined, phaseTitle: undefined }),
          member({ index: 1, label: "first", phaseIndex: undefined, phaseTitle: undefined }),
        ]),
      }),
    );
    expect(group?.phases).toEqual([]);
    expect(group?.unphasedMembers.map((agent) => agent.title)).toEqual(["first", "second"]);
  });

  it("derives a settled member's end from its reported duration", () => {
    const startedAt = Date.UTC(2026, 7, 1, 10, 0, 0);
    const group = deriveWorkflowGroup(
      coordinator({
        workflow: workflowOf([
          member({
            state: "completed",
            startedAt,
            durationMs: 1500,
            totalTokens: 71_141,
            toolCalls: 3,
            prompt: "Reply with exactly: A1",
            result: "A1",
          }),
        ]),
      }),
    );
    const settled = group?.phases[0]?.members[0];
    expect(settled?.status).toBe("completed");
    expect(settled && DateTime.formatIso(settled.completedAt!)).toBe("2026-08-01T10:00:01.500Z");
    expect(settled?.result).toBe("A1");
    expect(settled?.prompt).toBe("Reply with exactly: A1");
    expect(settled?.usage).toEqual({ totalTokens: 71_141, toolUses: 3, durationMs: 1500 });
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "settles unfinished members when the coordinator is %s",
    (status) => {
      const completedAt = DateTime.makeUnsafe("2026-08-01T10:00:09.000Z");
      const group = deriveWorkflowGroup(
        coordinator({
          status,
          completedAt,
          workflow: workflowOf([
            member(),
            member({ index: 2, state: "queued" }),
            member({ index: 3, state: "completed" }),
          ]),
        }),
      );
      const members = group?.phases.flatMap((phase) => phase.members);
      expect(members?.map((agent) => agent.status)).toEqual([status, status, "completed"]);
      expect(members?.[0]?.completedAt).toEqual(completedAt);
      // Nothing is left running, so the phase reads as settled.
      expect(group?.phases[0]?.state).toBe("done");
    },
  );
});

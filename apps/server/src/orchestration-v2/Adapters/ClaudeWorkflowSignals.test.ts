import { describe, expect, it } from "@effect/vitest";

import {
  claudeRunHandlesFromMessage,
  claudeTaskUsageFromMessage,
  claudeWorkflowProgressFromMessage,
  claudeWorkflowRunHandlesFromToolResult,
  mergeClaudeWorkflowProgress,
} from "./ClaudeWorkflowSignals.ts";

describe("claudeTaskUsageFromMessage", () => {
  it("reads a snake_case usage block", () => {
    const usage = claudeTaskUsageFromMessage({
      usage: {
        total_tokens: 1500,
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        tool_uses: 3,
        duration_ms: 4200,
      },
    });
    expect(usage).toEqual({
      totalTokens: 1500,
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      toolUses: 3,
      durationMs: 4200,
    });
  });

  it("reads the camelCase spelling too", () => {
    expect(claudeTaskUsageFromMessage({ taskUsage: { totalTokens: 42 } })?.totalTokens).toBe(42);
  });

  it("derives a missing total from the parts", () => {
    const usage = claudeTaskUsageFromMessage({
      usage: { input_tokens: 700, output_tokens: 300 },
    });
    expect(usage?.totalTokens).toBe(1000);
  });

  it("returns undefined when no usage is reported at all", () => {
    expect(claudeTaskUsageFromMessage({})).toBeUndefined();
    expect(claudeTaskUsageFromMessage({ usage: {} })).toBeUndefined();
    expect(claudeTaskUsageFromMessage(null)).toBeUndefined();
    expect(claudeTaskUsageFromMessage("nope")).toBeUndefined();
  });

  it("rejects malformed counts rather than passing them downstream", () => {
    // These would fail schema encoding much later, far from the cause.
    const usage = claudeTaskUsageFromMessage({
      usage: { total_tokens: 100, input_tokens: -5, output_tokens: 1.5, tool_uses: "many" },
    });
    expect(usage?.totalTokens).toBe(100);
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.outputTokens).toBeUndefined();
    expect(usage?.toolUses).toBeUndefined();
  });
});

describe("claudeWorkflowProgressFromMessage", () => {
  it("reads a nested workflow block", () => {
    const workflow = claudeWorkflowProgressFromMessage({
      workflow: {
        name: "review-changes",
        description: "Review and verify",
        current_phase: "Verify",
        spawned_count: 4,
        phases: [
          { index: 0, title: "Review" },
          { index: 1, title: "Verify", detail: "adversarial" },
        ],
      },
    });
    expect(workflow?.name).toBe("review-changes");
    expect(workflow?.currentPhase).toBe("Verify");
    expect(workflow?.spawnedCount).toBe(4);
    expect(workflow?.phases).toHaveLength(2);
    expect(workflow?.phases[1]?.detail).toBe("adversarial");
  });

  it("reads workflow fields flattened onto the message", () => {
    const workflow = claudeWorkflowProgressFromMessage({
      workflow_name: "migrate",
      workflow_phases: [{ title: "Discover" }],
      current_phase: "Discover",
    });
    expect(workflow?.name).toBe("migrate");
    expect(workflow?.phases[0]?.title).toBe("Discover");
  });

  it("falls back to array position when a phase omits its index", () => {
    const workflow = claudeWorkflowProgressFromMessage({
      workflow: { phases: [{ title: "A" }, { title: "B" }] },
    });
    expect(workflow?.phases.map((phase) => phase.index)).toEqual([0, 1]);
  });

  it("drops untitled phases instead of rendering blank pips", () => {
    const workflow = claudeWorkflowProgressFromMessage({
      workflow: { phases: [{ title: "A" }, { index: 1 }, "garbage"] },
    });
    expect(workflow?.phases).toHaveLength(1);
  });

  it("returns undefined for an ordinary subagent with no workflow shape", () => {
    expect(claudeWorkflowProgressFromMessage({ task_id: "t1" })).toBeUndefined();
    expect(claudeWorkflowProgressFromMessage({})).toBeUndefined();
  });

  it("still reports a workflow that has only a current phase", () => {
    // Phase progress can arrive before the declared phase list does.
    const workflow = claudeWorkflowProgressFromMessage({ current_phase: "Scan" });
    expect(workflow?.currentPhase).toBe("Scan");
    expect(workflow?.phases).toEqual([]);
  });
});

describe("claudeRunHandlesFromMessage", () => {
  it("reads nested and flattened handles", () => {
    expect(
      claudeRunHandlesFromMessage({
        run_handles: { run_id: "wf_1", script_path: "/tmp/s.js", transcript_dir: "/tmp/t" },
      }),
    ).toEqual({ runId: "wf_1", scriptPath: "/tmp/s.js", transcriptDir: "/tmp/t" });

    expect(claudeRunHandlesFromMessage({ runId: "wf_2" })).toEqual({ runId: "wf_2" });
  });

  it("keeps http and https session urls", () => {
    expect(claudeRunHandlesFromMessage({ session_url: "https://x.test/run" })?.sessionUrl).toBe(
      "https://x.test/run",
    );
  });

  it("drops a non-http session url at the boundary", () => {
    // The client renders this as a link and cannot re-check it, so it must
    // never reach storage.
    expect(claudeRunHandlesFromMessage({ session_url: "javascript:alert(1)" })).toBeUndefined();
    expect(claudeRunHandlesFromMessage({ session_url: "file:///etc/passwd" })).toBeUndefined();
  });

  it("returns undefined when no handle is present", () => {
    expect(claudeRunHandlesFromMessage({ task_id: "t1" })).toBeUndefined();
    expect(claudeRunHandlesFromMessage(undefined)).toBeUndefined();
  });
});

const startFrame = {
  type: "system",
  subtype: "task_started",
  task_id: "w1",
  task_type: "local_workflow",
  workflow_name: "probe-wf",
};

const snapshotFrame = (
  entries: ReadonlyArray<Record<string, unknown>>,
  usage?: Record<string, number>,
) => ({
  type: "system",
  subtype: "task_progress",
  task_id: "w1",
  description: "Alpha: alpha:one",
  workflow_progress: entries,
  ...(usage === undefined ? {} : { usage }),
});

const phase = (index: number, title: string) => ({ type: "workflow_phase", index, title });

const agent = (overrides: Record<string, unknown>) => ({
  type: "workflow_agent",
  index: 1,
  label: "alpha:one",
  state: "start",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

describe("mergeClaudeWorkflowProgress", () => {
  it("marks a coordinator as a workflow before any member exists", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      isWorkflow: true,
      message: startFrame,
    });
    expect(workflow).toEqual({ name: "probe-wf", phases: [], agents: [] });
  });

  it("leaves an ordinary subagent's frames alone", () => {
    expect(
      mergeClaudeWorkflowProgress({
        previous: undefined,
        message: {
          type: "system",
          subtype: "task_progress",
          task_id: "t1",
          description: "reading files",
          usage: { total_tokens: 500, tool_uses: 2, duration_ms: 90 },
        },
      }),
    ).toBeUndefined();
  });

  it("maps provider agent states and per-member metrics", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        phase(1, "Alpha"),
        agent({
          state: "done",
          agentId: "a1",
          model: "claude-opus-5[1m]",
          attempt: 2,
          tokens: 71_141,
          toolCalls: 3,
          durationMs: 1277,
          startedAt: 1_700_000_000_000,
          queuedAt: 1_699_999_999_000,
          promptPreview: "Reply with exactly: A1",
          resultPreview: "A1",
        }),
        agent({ index: 2, label: "alpha:two", state: "queued" }),
      ]),
    });
    expect(workflow?.phases).toEqual([{ index: 1, title: "Alpha" }]);
    expect(workflow?.agents?.[0]).toEqual({
      index: 1,
      label: "alpha:one",
      agentId: "a1",
      state: "completed",
      phaseIndex: 1,
      phaseTitle: "Alpha",
      model: "claude-opus-5[1m]",
      attempt: 2,
      totalTokens: 71_141,
      toolCalls: 3,
      durationMs: 1277,
      queuedAt: 1_699_999_999_000,
      startedAt: 1_700_000_000_000,
      prompt: "Reply with exactly: A1",
      result: "A1",
    });
    expect(workflow?.agents?.[1]?.state).toBe("queued");
    // The roster drives the phase indicator and fan-out count the Agents
    // surface already renders.
    expect(workflow?.currentPhase).toBe("Alpha");
    expect(workflow?.spawnedCount).toBe(2);
  });

  it("follows the phase its running members are in", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        phase(1, "Alpha"),
        phase(2, "Beta"),
        agent({ state: "done" }),
        agent({ index: 2, label: "beta:one", phaseIndex: 2, phaseTitle: "Beta" }),
      ]),
    });
    expect(workflow?.currentPhase).toBe("Beta");
  });

  it.each(["something-new", "toString", "constructor", "__proto__"])(
    "treats unrecognised state %s as still running rather than settled",
    (state) => {
      const workflow = mergeClaudeWorkflowProgress({
        previous: undefined,
        message: snapshotFrame([agent({ state })]),
      });
      expect(workflow?.agents?.[0]?.state).toBe("running");
    },
  );

  it("keeps the roster through a usage-only frame", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      isWorkflow: true,
      message: { ...startFrame, ...snapshotFrame([phase(1, "Alpha"), agent({})]) },
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([], { total_tokens: 250, tool_uses: 2, duration_ms: 900 }),
    });
    expect(second?.agents).toHaveLength(1);
    expect(second?.phases).toHaveLength(1);
    expect(second?.name).toBe("probe-wf");
  });

  it("harvests run handles from the launch acknowledgement", () => {
    expect(
      claudeWorkflowRunHandlesFromToolResult({
        status: "async_launched",
        taskType: "local_workflow",
        runId: "wf_abc",
        transcriptDir: "/root/.claude/projects/p/s/subagents/workflows/wf_abc",
        scriptPath: "/root/.claude/projects/p/s/workflows/scripts/x.js",
      }),
    ).toEqual({
      runId: "wf_abc",
      transcriptDir: "/root/.claude/projects/p/s/subagents/workflows/wf_abc",
      scriptPath: "/root/.claude/projects/p/s/workflows/scripts/x.js",
    });
  });

  it("ignores a non-workflow tool acknowledgement", () => {
    expect(
      claudeWorkflowRunHandlesFromToolResult({
        status: "async_launched",
        taskType: "local_agent",
        runId: "agent_abc",
      }),
    ).toBeUndefined();
  });

  it("keeps a phase the plan reached at runtime even if a later frame omits it", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([phase(1, "Alpha"), phase(2, "Beta"), phase(3, "Gamma")]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([phase(1, "Alpha")]),
    });
    expect(second?.phases.map((entry) => entry.title)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("keeps other members and phase links when a sparse frame starts a new attempt", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        phase(1, "Alpha"),
        agent({
          state: "error",
          attempt: 1,
          promptPreview: "First prompt",
          resultPreview: "First result",
          tokens: 100,
          toolCalls: 2,
          durationMs: 50,
          queuedAt: 1000,
          startedAt: 1010,
        }),
        agent({ index: 2, state: "done" }),
      ]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([
        { type: "workflow_agent", index: 1, label: "alpha:one", state: "start", attempt: 2 },
      ]),
    });
    expect(second?.agents).toEqual([
      {
        index: 1,
        label: "alpha:one",
        state: "running",
        attempt: 2,
        phaseIndex: 1,
        phaseTitle: "Alpha",
      },
      first?.agents?.[1],
    ]);
    expect(second?.phases).toEqual(first?.phases);
  });

  it("ignores an older attempt after a retry completes", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ state: "done", attempt: 2, resultPreview: "New result" })]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([agent({ state: "error", attempt: 1, resultPreview: "Old result" })]),
    });
    expect(second?.agents).toEqual(first?.agents);
  });

  it.each([
    ["done", "start"],
    ["done", "queued"],
    ["error", "start"],
    ["error", "queued"],
    ["start", "queued"],
  ])("keeps member state when the same attempt regresses from %s to %s", (state, staleState) => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ state, attempt: 2, resultPreview: "Current result" })]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([
        agent({ state: staleState, attempt: 2, resultPreview: "Old result" }),
      ]),
    });
    expect(second?.agents).toEqual(first?.agents);
  });

  it("retains member fields omitted by a later frame in the same attempt", () => {
    const first = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([agent({ attempt: 2, promptPreview: "Current prompt", tokens: 100 })]),
    });
    const second = mergeClaudeWorkflowProgress({
      previous: first,
      message: snapshotFrame([agent({ state: "done", resultPreview: "Current result" })]),
    });
    expect(second?.agents?.[0]).toMatchObject({
      state: "completed",
      attempt: 2,
      prompt: "Current prompt",
      result: "Current result",
      totalTokens: 100,
    });
  });

  it("preserves prompt and result whitespace", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        agent({ promptPreview: "  indented\n", resultPreview: "\n  answer\n" }),
      ]),
    });
    expect(workflow?.agents?.[0]?.prompt).toBe("  indented\n");
    expect(workflow?.agents?.[0]?.result).toBe("\n  answer\n");
  });

  it("drops timestamps outside the DateTime range", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        agent({ startedAt: 8_640_000_000_000_001, queuedAt: Number.MAX_SAFE_INTEGER }),
        agent({ index: 2, startedAt: 8_640_000_000_000_000, queuedAt: 0 }),
      ]),
    });
    expect(workflow?.agents?.[0]).not.toHaveProperty("startedAt");
    expect(workflow?.agents?.[0]).not.toHaveProperty("queuedAt");
    expect(workflow?.agents?.[1]?.startedAt).toBe(8_640_000_000_000_000);
    expect(workflow?.agents?.[1]?.queuedAt).toBe(0);
  });

  it("drops malformed entries instead of failing the frame", () => {
    const workflow = mergeClaudeWorkflowProgress({
      previous: undefined,
      message: snapshotFrame([
        { type: "workflow_phase", title: "No index" },
        { type: "workflow_agent", index: 4 },
        { type: "something_else", index: 1, title: "Ignored" },
        phase(1, "Alpha"),
      ]),
    });
    expect(workflow).toEqual({ phases: [{ index: 1, title: "Alpha" }], agents: [] });
  });
});

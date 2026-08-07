import { describe, expect, it } from "@effect/vitest";

import {
  claudeRunHandlesFromMessage,
  claudeTaskUsageFromMessage,
  claudeWorkflowProgressFromMessage,
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

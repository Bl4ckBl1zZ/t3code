import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  classifyV2AgentKind,
  OrchestrationV2Subagent,
  OrchestrationV2WorkflowProgress,
  sanitizeV2SessionUrl,
} from "./orchestrationV2.ts";

const decodeSubagent = Schema.decodeUnknownEffect(OrchestrationV2Subagent);
const decodeWorkflow = Schema.decodeUnknownEffect(OrchestrationV2WorkflowProgress);

const baseSubagent = {
  id: "node-1",
  threadId: "thread-1",
  runId: "run-1",
  parentNodeId: "node-0",
  origin: "app_owned",
  createdBy: "agent",
  driver: "claude",
  providerInstanceId: "provider-1",
  providerThreadId: null,
  childThreadId: "thread-2",
  nativeTaskRef: null,
  prompt: "do the thing",
  title: "worker",
  model: "claude-opus-5",
  status: "running",
  result: null,
  startedAt: DateTime.makeUnsafe("2026-08-07T12:00:00.000Z"),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-08-07T12:00:01.000Z"),
};

describe("classifyV2AgentKind", () => {
  it("treats unknown task types as agents so a drifting driver vocabulary fails safe", () => {
    // The whole point of the denylist: a name nobody has seen before must
    // still show up in the roster.
    expect(classifyV2AgentKind({ taskType: "local_workflow" })).toBe("agent");
    expect(classifyV2AgentKind({ taskType: "some_future_name" })).toBe("agent");
    expect(classifyV2AgentKind({})).toBe("agent");
  });

  it("classifies watch loops and shells as background", () => {
    for (const taskType of ["monitor", "monitor_mcp", "local_bash", "shell", "background_shell"]) {
      expect(classifyV2AgentKind({ taskType })).toBe("background");
    }
  });

  it("classifies plan-mode bookkeeping types as background", () => {
    expect(classifyV2AgentKind({ taskType: "plan" })).toBe("background");
    expect(classifyV2AgentKind({ taskType: "dream" })).toBe("background");
  });

  it("keeps a nested agent in the roster but demotes nested non-agent work", () => {
    // A nested agent can outlive its parent, so it stays an agent.
    expect(classifyV2AgentKind({ taskType: "subagent", hasParentTask: true })).toBe("agent");
    // A shell launched from inside an agent is that agent's internal business.
    expect(classifyV2AgentKind({ taskType: "shell", hasParentTask: true })).toBe("background");
    // Nested with no type at all cannot be shown to be an agent.
    expect(classifyV2AgentKind({ hasParentTask: true })).toBe("background");
  });
});

describe("sanitizeV2SessionUrl", () => {
  it("keeps http and https", () => {
    expect(sanitizeV2SessionUrl("https://example.com/run/1")).toBe("https://example.com/run/1");
    expect(sanitizeV2SessionUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  });

  it("drops non-http schemes rather than escaping them", () => {
    // These render as links; there is no safe way to keep them.
    expect(sanitizeV2SessionUrl("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeV2SessionUrl("file:///etc/passwd")).toBeUndefined();
    expect(sanitizeV2SessionUrl("data:text/html,<script>")).toBeUndefined();
  });

  it("drops unparseable and empty input", () => {
    expect(sanitizeV2SessionUrl("not a url")).toBeUndefined();
    expect(sanitizeV2SessionUrl("   ")).toBeUndefined();
    expect(sanitizeV2SessionUrl(null)).toBeUndefined();
    expect(sanitizeV2SessionUrl(undefined)).toBeUndefined();
  });
});

describe("subagent observability fields", () => {
  it.effect("decodes a legacy row that carries none of them", () =>
    Effect.gen(function* () {
      // The compatibility guarantee: rows written before this feature existed
      // must decode untouched, with every new field absent rather than zeroed.
      const decoded = yield* decodeSubagent(baseSubagent);
      expect(decoded.usage).toBeUndefined();
      expect(decoded.workflow).toBeUndefined();
      expect(decoded.runHandles).toBeUndefined();
      expect(decoded.agentKind).toBeUndefined();
      expect(decoded.taskType).toBeUndefined();
    }),
  );

  it.effect("decodes a fully annotated workflow task", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeSubagent({
        ...baseSubagent,
        taskType: "local_workflow",
        agentKind: "agent",
        usage: { totalTokens: 1200, inputTokens: 900, outputTokens: 300, toolUses: 4 },
        workflow: {
          name: "review-changes",
          phases: [
            { index: 0, title: "Review" },
            { index: 1, title: "Verify", detail: "adversarial pass" },
          ],
          currentPhase: "Verify",
          spawnedCount: 3,
        },
        runHandles: {
          runId: "wf_abc123",
          scriptPath: "/home/u/.claude/projects/p/script.js",
          sessionUrl: "https://example.com/run",
        },
      });
      expect(decoded.workflow?.phases).toHaveLength(2);
      expect(decoded.workflow?.currentPhase).toBe("Verify");
      expect(decoded.usage?.totalTokens).toBe(1200);
      // Not reported by this driver — must stay absent, not become 0.
      expect(decoded.usage?.reasoningOutputTokens).toBeUndefined();
      expect(decoded.runHandles?.runId).toBe("wf_abc123");
    }),
  );

  it.effect("accepts a workflow with no declared phases", () =>
    Effect.gen(function* () {
      // A script may declare no meta.phases at all; that is an empty roster,
      // not a decode failure.
      const decoded = yield* decodeWorkflow({ phases: [] });
      expect(decoded.phases).toHaveLength(0);
      expect(decoded.currentPhase).toBeUndefined();
    }),
  );
});

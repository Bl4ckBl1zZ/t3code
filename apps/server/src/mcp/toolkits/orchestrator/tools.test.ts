import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  ScheduleTaskTool,
  TaskCancelTool,
  ThreadSendTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "child agent/subagent");
    assert.include(DelegateTaskTool.description ?? "", "cross-provider");
    assert.include(CreateThreadsTool.description ?? "", "not delegation");
    assert.include(CreateThreadsTool.description ?? "", "call delegate_task");
    assert.include(DelegateTaskTool.description ?? "", "call delegate_task again");
    assert.include(DelegateTaskTool.description ?? "", "childThreadId is backing storage");
    assert.include(
      ThreadSendTool.description ?? "",
      "Do not use a delegated task's childThreadId to start another review round",
    );
    assert.include(
      TaskCancelTool.description ?? "",
      "without interrupting later child-thread runs",
    );
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "STRUCTURED OBJECT");
    assert.include(ScheduleTaskTool.description ?? "", "nextRunAt");
  });
});

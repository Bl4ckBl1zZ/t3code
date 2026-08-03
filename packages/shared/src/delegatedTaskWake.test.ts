import { describe, expect, it } from "vite-plus/test";

import { parseDelegatedTaskWakeMessage } from "./delegatedTaskWake.ts";

describe("parseDelegatedTaskWakeMessage", () => {
  it("parses the completed variant with a quoted title", () => {
    expect(
      parseDelegatedTaskWakeMessage(
        'Delegated task "RestoreCord scheduled first-touch next: a@b.com" completed. Use task_status with taskId node:delegated-task:command%3Amcp%3A1234 to read the result.',
      ),
    ).toEqual({
      title: "RestoreCord scheduled first-touch next: a@b.com",
      taskId: "node:delegated-task:command%3Amcp%3A1234",
      status: "completed",
    });
  });

  it("parses the completed variant for an untitled task (bare id label)", () => {
    expect(
      parseDelegatedTaskWakeMessage(
        "Delegated task node:task-1 completed. Use task_status with taskId node:task-1 to read the result.",
      ),
    ).toEqual({ title: "node:task-1", taskId: "node:task-1", status: "completed" });
  });

  it("parses the non-completed terminal variant", () => {
    expect(
      parseDelegatedTaskWakeMessage(
        'Delegated task "Bounce triage" ended with status failed. Use task_status with taskId node:task-2 for details.',
      ),
    ).toEqual({ title: "Bounce triage", taskId: "node:task-2", status: "failed" });
  });

  it("keeps titles containing quotes intact", () => {
    expect(
      parseDelegatedTaskWakeMessage(
        'Delegated task "Send "final" notice" completed. Use task_status with taskId node:task-3 to read the result.',
      ),
    ).toEqual({ title: 'Send "final" notice', taskId: "node:task-3", status: "completed" });
  });

  it("returns null for ordinary messages", () => {
    expect(parseDelegatedTaskWakeMessage("Please check the deploy logs.")).toBeNull();
    expect(parseDelegatedTaskWakeMessage("Delegated task finished")).toBeNull();
    expect(parseDelegatedTaskWakeMessage("")).toBeNull();
  });
});

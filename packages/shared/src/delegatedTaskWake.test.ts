import { describe, expect, it } from "vite-plus/test";

import {
  formatDelegatedTaskWakeMessage,
  parseDelegatedTaskWakeMessage,
  parseDelegatedTaskWakeMessages,
} from "./delegatedTaskWake.ts";

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

describe("delegated task cohort wakes", () => {
  it("keeps the singular sentence so existing clients parse it unchanged", () => {
    const text = formatDelegatedTaskWakeMessage([
      { id: "task-1", title: "Ship the fix", status: "completed" },
    ]);
    expect(text).toBe(
      'Delegated task "Ship the fix" completed. Use task_status with taskId task-1 to read the result.',
    );
    expect(parseDelegatedTaskWakeMessage(text)).toEqual({
      title: "Ship the fix",
      taskId: "task-1",
      status: "completed",
    });
    expect(parseDelegatedTaskWakeMessages(text)).toEqual([
      { title: "Ship the fix", taskId: "task-1", status: "completed" },
    ]);
  });

  it("round-trips a cohort of several tasks with mixed statuses", () => {
    const text = formatDelegatedTaskWakeMessage([
      { id: "task-1", title: "Ship the fix", status: "completed" },
      { id: "task-2", title: null, status: "failed" },
    ]);
    expect(parseDelegatedTaskWakeMessages(text)).toEqual([
      { title: "Ship the fix", taskId: "task-1", status: "completed" },
      { title: "task-2", taskId: "task-2", status: "failed" },
    ]);
  });

  it("survives a comma inside a task title", () => {
    const text = formatDelegatedTaskWakeMessage([
      { id: "task-1", title: "Fix a, b and c", status: "completed" },
      { id: "task-2", title: "Second", status: "cancelled" },
    ]);
    expect(parseDelegatedTaskWakeMessages(text)).toEqual([
      { title: "Fix a, b and c", taskId: "task-1", status: "completed" },
      { title: "Second", taskId: "task-2", status: "cancelled" },
    ]);
  });

  it("returns null for text that is not a wake message", () => {
    expect(parseDelegatedTaskWakeMessages("Just a normal message.")).toBeNull();
  });
});

import * as DateTime from "effect/DateTime";
import {
  NodeId,
  type OrchestrationV2CommandExecutionItem,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commandExitLine } from "./V2ItemInspector";

const START = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const END = DateTime.makeUnsafe("2026-08-04T12:00:01.500Z");

function commandItem(
  overrides: Partial<OrchestrationV2CommandExecutionItem> = {},
): OrchestrationV2CommandExecutionItem {
  return {
    id: TurnItemId.make("item-1"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: NodeId.make("node-1"),
    providerThreadId: ProviderThreadId.make("pt-1"),
    providerTurnId: ProviderTurnId.make("ptn-1"),
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: START,
    completedAt: END,
    updatedAt: END,
    type: "command_execution",
    input: "pnpm test",
    ...overrides,
  };
}

describe("commandExitLine", () => {
  it("says nothing while the command is still running", () => {
    expect(commandExitLine(commandItem({ status: "running", completedAt: null }))).toBeNull();
    expect(
      commandExitLine(commandItem({ status: "running", completedAt: null, background: true })),
    ).toBeNull();
  });

  it("reports the exit code and duration of a finished command", () => {
    expect(commandExitLine(commandItem({ exitCode: 0 }))).toEqual({
      tone: "success",
      text: "Exited with code 0 · 1.5s",
    });
    expect(commandExitLine(commandItem({ status: "failed", exitCode: 2 }))).toEqual({
      tone: "danger",
      text: "Exited with code 2 · 1.5s",
    });
  });

  it("drops the duration when the command never recorded an end", () => {
    expect(commandExitLine(commandItem({ exitCode: 0, completedAt: null }))).toEqual({
      tone: "success",
      text: "Exited with code 0",
    });
  });

  it("explains a background command that did not finish cleanly instead of its exit code", () => {
    expect(
      commandExitLine(
        commandItem({
          background: true,
          status: "interrupted",
          exitReason: "killed",
          exitCode: 137,
        }),
      ),
    ).toEqual({ tone: "warning", text: "Stopped when the session ended · 1.5s" });
    expect(
      commandExitLine(commandItem({ background: true, status: "failed", exitCode: 1 })),
    ).toEqual({ tone: "danger", text: "Failed with exit code 1 · 1.5s" });
  });

  it("shows the exit code for a background command that finished cleanly", () => {
    expect(commandExitLine(commandItem({ background: true, exitCode: 0 }))).toEqual({
      tone: "success",
      text: "Exited with code 0 · 1.5s",
    });
  });
});

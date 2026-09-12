import { TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, it, expect } from "vite-plus/test";
import {
  latestWorkspaceMutationId,
  workspaceMutationRefreshToken,
} from "./useWorkspaceMutationRefresh";

type Row = Parameters<typeof latestWorkspaceMutationId>[0][number];
const row = (
  id: string,
  time: number,
  type: Row["item"]["type"] = "file_change",
  status: Row["item"]["status"] = "completed",
): Row => ({
  sourceThreadId: "thread-1",
  item: { id: TurnItemId.make(id), type, status, updatedAt: DateTime.makeUnsafe(time) },
});
describe("V2 workspace refresh", () => {
  it("refreshes for file writes and finished commands, including failures that may have written files", () => {
    expect(
      latestWorkspaceMutationId([
        row("write", 10),
        row("command", 20, "command_execution", "failed"),
      ]),
    ).toBe("thread-1:command:20");
  });
  it("uses completion time when an earlier parallel command finishes last", () => {
    expect(latestWorkspaceMutationId([row("first", 30), row("second", 20)])).toBe(
      "thread-1:first:30",
    );
  });
  it("does not refresh for streaming work, read-only tools or assistant messages", () => {
    expect(
      latestWorkspaceMutationId([
        row("write", 10, "file_change", "running"),
        row("read", 20, "file_search"),
        row("answer", 30, "assistant_message"),
      ]),
    ).toBeNull();
  });
  it("distinguishes both the changed resource and completion revision", () => {
    expect(workspaceMutationRefreshToken("first", "mutation")).not.toBe(
      workspaceMutationRefreshToken("second", "mutation"),
    );
    expect(workspaceMutationRefreshToken("first", null)).toBeNull();
  });
});

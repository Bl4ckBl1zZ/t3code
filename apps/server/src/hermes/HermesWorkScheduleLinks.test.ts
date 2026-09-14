import { expect, it } from "@effect/vitest";
import { hermesCreatedScheduleIds } from "./HermesWorkScheduleLinks.ts";
it("links only successful native cron create receipts", () => {
  const receipt = {
    type: "dynamic_tool",
    status: "completed",
    nativeItemRef: { driver: "hermes" },
    toolName: "cronjob",
    input: { action: "create" },
    output: { success: true, job_id: "0899156242e3" },
  };
  expect(
    hermesCreatedScheduleIds([
      receipt,
      receipt,
      { ...receipt, input: { action: "list" } },
      { ...receipt, output: { success: false, job_id: "failed" } },
      { ...receipt, toolName: "terminal" },
      { ...receipt, nativeItemRef: { driver: "codex" } },
      { type: "assistant_message", text: "Created job fake" },
    ]),
  ).toEqual(["0899156242e3"]);
});

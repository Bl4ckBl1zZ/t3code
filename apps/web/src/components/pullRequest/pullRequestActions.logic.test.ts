import type { PullRequestAction } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { type PullRequestActionPhase, sendPullRequestAction } from "./pullRequestActions.logic";

function recorder() {
  const phases: Array<[PullRequestAction, PullRequestActionPhase]> = [];
  const requests: Array<Record<string, unknown>> = [];
  return {
    phases,
    requests,
    onActed: (action: PullRequestAction, phase: PullRequestActionPhase) => {
      phases.push([action, phase]);
    },
    succeed: async (request: Record<string, unknown>) => {
      requests.push(request);
      return AsyncResult.success(undefined);
    },
    refuse: async (request: Record<string, unknown>) => {
      requests.push(request);
      return AsyncResult.failure(Cause.fail(new Error("Pull request is not mergeable")));
    },
  };
}

describe("sendPullRequestAction", () => {
  it("reports sent before the host answers, then done", async () => {
    const record = recorder();
    const outcome = await sendPullRequestAction({
      action: "close",
      options: {},
      run: record.succeed,
      onActed: record.onActed,
    });
    expect(outcome).toEqual({ _tag: "done" });
    expect(record.phases).toEqual([
      ["close", "sent"],
      ["close", "done"],
    ]);
  });

  it("reports failed with the host's refusal, and a rebase hint for a rebase update", async () => {
    const record = recorder();
    const outcome = await sendPullRequestAction({
      action: "update-branch",
      options: { updateMethod: "rebase" },
      run: record.refuse,
      onActed: record.onActed,
    });
    expect(record.phases).toEqual([
      ["update-branch", "sent"],
      ["update-branch", "failed"],
    ]);
    expect(record.requests).toEqual([{ updateMethod: "rebase" }]);
    expect(outcome._tag).toBe("failed");
    if (outcome._tag !== "failed") return;
    expect((outcome.failure as Error).message).toBe("Pull request is not mergeable");
    expect(outcome.hint).toMatch(/rebase stops/i);
  });

  it("queues merge preparation with the action only when no method was chosen", async () => {
    const prepareMerge = { stackActions: true, resolveMergeMethod: () => "squash" as const };
    const record = recorder();
    await sendPullRequestAction({
      action: "merge",
      options: {},
      prepareMerge,
      run: record.succeed,
      onActed: record.onActed,
    });
    expect(record.requests).toEqual([{ prepareMerge }]);
    expect(record.phases).toEqual([
      ["merge", "sent"],
      ["merge", "done"],
    ]);

    const chosen = recorder();
    await sendPullRequestAction({
      action: "merge",
      options: { mergeMethod: "rebase" },
      prepareMerge,
      run: chosen.succeed,
    });
    expect(chosen.requests).toEqual([{ mergeMethod: "rebase" }]);

    const close = recorder();
    await sendPullRequestAction({ action: "close", options: {}, prepareMerge, run: close.succeed });
    expect(close.requests).toEqual([{}]);
  });

  it("stops before sending when the work ahead of it fails", async () => {
    const record = recorder();
    const outcome = await sendPullRequestAction({
      action: "close",
      options: { before: async () => false },
      run: record.succeed,
      onActed: record.onActed,
    });
    expect(outcome).toEqual({ _tag: "stopped" });
    expect(record.phases).toEqual([]);
    expect(record.requests).toEqual([]);
  });
});

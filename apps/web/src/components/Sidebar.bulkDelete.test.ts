import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { summarizeThreadDeletions } from "./Sidebar.logic";

describe("summarizeThreadDeletions", () => {
  const success = AsyncResult.success(undefined);
  const failure = AsyncResult.failure(Cause.fail(new Error("Delete failed")));
  const laterFailure = AsyncResult.failure(Cause.fail(new Error("Later failure")));
  const interrupted = AsyncResult.failure(Cause.interrupt());

  it("keeps successes and the first reportable failure", () => {
    expect(
      summarizeThreadDeletions(
        ["one", "two", "three", "four"],
        [interrupted, success, failure, laterFailure],
      ),
    ).toEqual({ deletedThreadKeys: new Set(["two"]), firstFailure: failure });
  });

  it("never reports an interruption", () => {
    expect(summarizeThreadDeletions(["one", "two"], [interrupted, success])).toEqual({
      deletedThreadKeys: new Set(["two"]),
      firstFailure: null,
    });
  });
});

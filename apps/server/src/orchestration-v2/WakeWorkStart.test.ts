import type { OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { wakeWorkStartedAt } from "./WakeWorkStart.ts";

const at = (minutes: number) =>
  DateTime.makeUnsafe(Date.parse("2026-10-01T10:00:00.000Z") + minutes * 60_000);

function run(
  ordinal: number,
  timing: Partial<Pick<OrchestrationV2Run, "requestedAt" | "startedAt" | "workStartedAt">>,
): OrchestrationV2Run {
  return {
    ordinal,
    requestedAt: at(0),
    startedAt: null,
    ...timing,
  } as OrchestrationV2Run;
}

const millis = (value: DateTime.Utc | undefined) =>
  value === undefined ? undefined : DateTime.toEpochMillis(value);

describe("wakeWorkStartedAt", () => {
  it("leaves runs that start new work unstamped", () => {
    expect(wakeWorkStartedAt([run(1, { startedAt: at(1) })], {})).toEqual({});
    expect(
      wakeWorkStartedAt([run(1, { startedAt: at(1) })], { restartContinuation: false }),
    ).toEqual({});
  });

  it("keeps the start of the run that started last, not the one requested last", () => {
    // The queued prompt was requested before the wake run but started long
    // after it; a later wake counts from that start.
    const runs = [
      run(1, { requestedAt: at(0), startedAt: at(0) }),
      run(2, { requestedAt: at(1), startedAt: at(10) }),
      run(3, { requestedAt: at(2), startedAt: at(5) }),
      run(4, { requestedAt: at(3) }),
    ];
    expect(millis(wakeWorkStartedAt(runs, { delegatedCompletion: {} }).workStartedAt)).toBe(
      millis(at(10)),
    );
  });

  it("carries a previous wake's work start forward", () => {
    const runs = [run(1, { startedAt: at(0) }), run(2, { startedAt: at(4), workStartedAt: at(0) })];
    expect(millis(wakeWorkStartedAt(runs, { restartContinuation: true }).workStartedAt)).toBe(
      millis(at(0)),
    );
    expect(millis(wakeWorkStartedAt(runs, { notification: {} }).workStartedAt)).toBe(millis(at(0)));
  });

  it("has no start to keep before any run has started", () => {
    expect(wakeWorkStartedAt([run(1, {})], { delegatedCompletion: {} })).toEqual({});
  });
});

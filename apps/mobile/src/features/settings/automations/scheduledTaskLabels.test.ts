import { describe, expect, it } from "@effect/vitest";

import {
  automationSubtitle,
  isValidTimeOfDay,
  nextRunLabel,
  parseIntervalMinutes,
  scheduleLabel,
} from "./scheduledTaskLabels";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");

describe("scheduleLabel", () => {
  it("labels whole-minute intervals in minutes", () => {
    expect(scheduleLabel({ type: "interval", everyMs: 30 * 60_000 })).toBe("Every 30 min");
  });

  it("labels sub-minute intervals in seconds", () => {
    expect(scheduleLabel({ type: "interval", everyMs: 90_000 })).toBe("Every 90 sec");
  });

  it("labels empty weekdays as daily", () => {
    expect(scheduleLabel({ type: "fixed_time", timeOfDay: "09:00" })).toBe("Daily at 09:00");
  });

  it("collapses Monday-to-Friday to weekdays", () => {
    expect(
      scheduleLabel({ type: "fixed_time", timeOfDay: "07:30", weekdays: [1, 2, 3, 4, 5] }),
    ).toBe("Weekdays at 07:30");
  });

  it("lists explicit day subsets", () => {
    expect(scheduleLabel({ type: "fixed_time", timeOfDay: "16:00", weekdays: [5] })).toBe(
      "Fri at 16:00",
    );
  });
});

describe("nextRunLabel", () => {
  it("returns null when unscheduled", () => {
    expect(nextRunLabel(null, NOW)).toBeNull();
  });

  it("renders future instants at minute, hour and day granularity", () => {
    expect(nextRunLabel(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe("next in 5m");
    expect(nextRunLabel(new Date(NOW + 3 * 3_600_000).toISOString(), NOW)).toBe("next in 3h");
    expect(nextRunLabel(new Date(NOW + 49 * 3_600_000).toISOString(), NOW)).toBe("next in 2d");
  });

  it("handles overdue and invalid values", () => {
    expect(nextRunLabel(new Date(NOW - 1000).toISOString(), NOW)).toBe("next any moment");
    expect(nextRunLabel("not-a-date", NOW)).toBeNull();
  });
});

describe("automationSubtitle", () => {
  const base = {
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    nextRunAt: new Date(NOW + 2 * 3_600_000).toISOString(),
    lastRunStatus: "succeeded",
  } as const;

  it("shows schedule and next run when enabled", () => {
    expect(automationSubtitle(base, NOW)).toBe("Weekdays at 09:00 · next in 2h");
  });

  it("shows running state and suppresses next run", () => {
    expect(automationSubtitle({ ...base, lastRunStatus: "running" }, NOW)).toBe(
      "Weekdays at 09:00 · running now",
    );
  });

  it("shows paused instead of next run when disabled", () => {
    expect(automationSubtitle({ ...base, enabled: false }, NOW)).toBe("Weekdays at 09:00 · paused");
  });

  it("surfaces a failed last run alongside the next run", () => {
    expect(automationSubtitle({ ...base, lastRunStatus: "failed" }, NOW)).toBe(
      "Weekdays at 09:00 · last run failed · next in 2h",
    );
  });
});

describe("form parsing", () => {
  it("parses interval minutes", () => {
    expect(parseIntervalMinutes("15")).toBe(15);
    expect(parseIntervalMinutes(" 60 ")).toBe(60);
    expect(parseIntervalMinutes("0")).toBeNull();
    expect(parseIntervalMinutes("abc")).toBeNull();
  });

  it("validates HH:MM time of day", () => {
    expect(isValidTimeOfDay("09:00")).toBe(true);
    expect(isValidTimeOfDay("23:59")).toBe(true);
    expect(isValidTimeOfDay("24:00")).toBe(false);
    expect(isValidTimeOfDay("9:00")).toBe(false);
  });
});

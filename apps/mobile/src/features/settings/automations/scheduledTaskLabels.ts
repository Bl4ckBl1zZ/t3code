import type { ScheduledTaskRunStatus, ScheduledTaskSchedule } from "@t3tools/contracts";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * Human label for the next scheduled fire. `nextRunAt` is a future instant, so
 * a plain relative-time formatter would render a misleading "just now".
 */
export function nextRunLabel(nextRunAt: string | null, nowMs: number): string | null {
  if (nextRunAt === null) return null;
  const diffMs = new Date(nextRunAt).getTime() - nowMs;
  if (Number.isNaN(diffMs)) return null;
  if (diffMs <= 0) return "next any moment";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "next in under a minute";
  if (minutes < 60) return `next in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `next in ${hours}h`;
  return `next in ${Math.round(hours / 24)}d`;
}

/** One-line row subtitle: schedule, then run state, matching the web panel. */
export function automationSubtitle(
  task: {
    readonly enabled: boolean;
    readonly schedule: ScheduledTaskSchedule;
    readonly nextRunAt: string | null;
    readonly lastRunStatus: ScheduledTaskRunStatus;
  },
  nowMs: number,
): string {
  const parts = [scheduleLabel(task.schedule)];
  if (task.lastRunStatus === "running") {
    parts.push("running now");
  } else if (!task.enabled) {
    parts.push("paused");
  } else {
    if (task.lastRunStatus === "failed") parts.push("last run failed");
    const next = nextRunLabel(task.nextRunAt, nowMs);
    if (next !== null) parts.push(next);
  }
  return parts.join(" · ");
}

/** Status-dot Tailwind class per run status, mirroring the web settings page. */
export function automationStatusDotClass(status: ScheduledTaskRunStatus): string {
  switch (status) {
    case "never":
      return "bg-foreground-muted opacity-40";
    case "running":
      return "bg-sky-500";
    case "succeeded":
      return "bg-emerald-500";
    case "failed":
      return "bg-red-500";
  }
}

export function parseIntervalMinutes(raw: string): number | null {
  const minutes = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  return minutes;
}

export function isValidTimeOfDay(raw: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.trim());
}

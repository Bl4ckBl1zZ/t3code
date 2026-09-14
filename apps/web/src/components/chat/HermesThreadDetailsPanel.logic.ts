/** A paused job's old next-run timestamp must not read as an upcoming execution. */
export function hermesThreadScheduleSummary(task: {
  readonly paused: boolean;
  readonly nextRunAt: string | null;
  readonly lastStatus: string | null;
}) {
  const next = task.nextRunAt === null ? null : new Date(task.nextRunAt);
  return {
    timing: task.paused
      ? "Paused"
      : next === null || Number.isNaN(next.getTime())
        ? "Next run not reported"
        : `Next ${next.toLocaleString()}`,
    outcome: task.lastStatus ? `Last run: ${task.lastStatus.replaceAll("_", " ")}` : null,
  };
}

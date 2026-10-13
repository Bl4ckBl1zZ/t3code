import type { DesktopUpdateState } from "@t3tools/contracts";

/**
 * How long a backend's idle report counts. Backends repeat their report every
 * 30 seconds while an automatic install waits, so one missed report is
 * tolerated and an older answer is treated as unknown.
 */
export const AGENT_ACTIVITY_REPORT_TTL_MS = 75_000;

export interface AgentActivityRecord {
  readonly busy: boolean;
  readonly reportedAtMs: number;
}

/**
 * Whether a downloaded update may install now without asking. Every running
 * backend must have recently said it has no agent work; a backend that never
 * reports (a WSL backend has no control channel) keeps the update waiting,
 * and the update then installs when the app quits.
 */
export function canAutoInstall(input: {
  readonly state: DesktopUpdateState;
  readonly runningBackendIds: ReadonlyArray<string>;
  readonly activity: ReadonlyMap<string, AgentActivityRecord>;
  readonly nowMs: number;
}): boolean {
  if (input.state.autoUpdateEnabled !== true || input.state.status !== "downloaded") {
    return false;
  }
  return input.runningBackendIds.every((id) => {
    const record = input.activity.get(id);
    return (
      record !== undefined &&
      !record.busy &&
      input.nowMs - record.reportedAtMs <= AGENT_ACTIVITY_REPORT_TTL_MS
    );
  });
}

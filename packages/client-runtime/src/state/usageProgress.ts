import type { UsageSummary } from "@t3tools/contracts";

interface UsageProgressEnvironment {
  readonly isConnected: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

/**
 * Where one environment's answer stands for the usage on screen.
 *
 * - `inactive`: disconnected or failed, so waiting on it changes nothing.
 * - `loading`: no summary yet.
 * - `stale`: its summary on screen predates the current request.
 * - `ready`: answered.
 *
 * While a manual `refreshing` runs, every summary counts as stale.
 */
export function usageEnvironmentProgress(
  environment: UsageProgressEnvironment,
  refreshing = false,
): "inactive" | "loading" | "stale" | "ready" {
  if (!environment.isConnected || environment.error !== null) return "inactive";
  if (environment.summary === null) return "loading";
  return refreshing || environment.isPending ? "stale" : "ready";
}

/**
 * True while the merged usage on screen will still change because a selected
 * environment has not answered, or is answering again, so clients can mute
 * those figures.
 */
export function isUsageUpdating(
  environments: readonly UsageProgressEnvironment[],
  refreshing = false,
): boolean {
  return environments.some((environment) => {
    const progress = usageEnvironmentProgress(environment, refreshing);
    return progress === "loading" || progress === "stale";
  });
}

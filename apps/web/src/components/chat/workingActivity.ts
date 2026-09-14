/** Native activity is a transient label, not an assistant reasoning message. */
export function resolveWorkingActivityText(
  activityText: string | null | undefined,
  isWorking: boolean,
) {
  return isWorking ? activityText?.trim() || null : null;
}

import * as DateTime from "effect/DateTime";

type Timestamp = DateTime.Utc | string;

/** The shell fields auto-delete reads; server shells carry DateTimes, client shells ISO strings. */
export interface AutoDeleteThread {
  readonly archivedAt: Timestamp | null;
  readonly deletedAt: Timestamp | null;
  readonly pinnedAt?: Timestamp | null | undefined;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: Timestamp | null;
  readonly settledRecordedAt?: Timestamp | null | undefined;
}

const DAY_MS = 86_400_000;
const toMillis = (value: Timestamp) =>
  typeof value === "string" ? Date.parse(value) : DateTime.toEpochMillis(value);

/**
 * Epoch millis at which a settled thread becomes due for automatic deletion,
 * or null when it is not settled or is kept: pinned and archived threads are
 * never auto-deleted. Counts from when the thread entered Settled, falling
 * back to `settledAt` for threads settled before that moment was recorded.
 */
export function resolveAutoDeleteAtMs(
  thread: AutoDeleteThread,
  afterDays: number | null,
): number | null {
  if (afterDays === null) return null;
  if (thread.deletedAt !== null || thread.archivedAt !== null || thread.pinnedAt != null) {
    return null;
  }
  if (thread.settledOverride !== "settled") return null;
  const since = thread.settledRecordedAt ?? thread.settledAt;
  if (since === null) return null;
  const sinceMs = toMillis(since);
  return Number.isNaN(sinceMs) ? null : sinceMs + afterDays * DAY_MS;
}

export function isAutoDeleteDue(
  thread: AutoDeleteThread,
  afterDays: number | null,
  now: DateTime.Utc,
): boolean {
  const dueAtMs = resolveAutoDeleteAtMs(thread, afterDays);
  return dueAtMs !== null && dueAtMs <= DateTime.toEpochMillis(now);
}

import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

// Timestamps in this contract are ISO date-time strings; validate the value
// while preserving the plain string output shape. Date.parse alone is too
// permissive — it accepts date-only values ("2025-01-01") and non-ISO forms
// ("Jan 1 2025") — so require the full grammar and then confirm the calendar
// date is real (rejecting e.g. 2025-02-30, which the pattern cannot catch).
// Offset hours/minutes are bounded in the pattern itself so "+99:99" cannot
// slip through. Seconds are bounded at 59: these are gateway event timestamps,
// not an RFC 3339 leap-second ledger, so 60 is rejected outright rather than
// pretending to know the leap-second table for the supplied date and offset.
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const IsoDateTime = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const match = ISO_DATE_TIME_PATTERN.exec(value);
    if (match === null) return "Expected an ISO 8601 date-time string.";
    const [, year, month, day, hour, minute, second] = match;
    const monthValue = Number(month);
    const dayValue = Number(day);
    if (monthValue < 1 || monthValue > 12 || dayValue < 1 || dayValue > 31) {
      return "Expected an ISO 8601 date-time string.";
    }
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
      return "Expected an ISO 8601 date-time string.";
    }
    // Reject impossible calendar dates (e.g. 2025-02-30, 2025-04-31), which
    // the pattern above cannot catch, using the month's real length.
    const isLeapYear =
      Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
    const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
      monthValue - 1
    ]!;
    if (dayValue > daysInMonth) return "Expected an ISO 8601 date-time string.";
    return true;
  }),
);

export const HermesProactiveRequiredCapabilities = [
  "cron.events.global_cursor",
  "events.stable_ids",
] as const;

export const HermesProactiveCapabilityState = Schema.Literals(["ready", "degraded"]);
export type HermesProactiveCapabilityState = typeof HermesProactiveCapabilityState.Type;

export const HermesProactiveDiagnosticCode = Schema.Literals([
  "ready",
  "missing_capability_inventory",
  "missing_durable_global_cursor",
  "missing_stable_event_ids",
]);
export type HermesProactiveDiagnosticCode = typeof HermesProactiveDiagnosticCode.Type;

export const HermesProactiveSourceStatus = Schema.Struct({
  sourceId: Schema.String,
  providerInstanceId: Schema.String,
  profileKey: Schema.String,
  state: HermesProactiveCapabilityState,
  diagnosticCode: HermesProactiveDiagnosticCode,
  missingCapabilities: Schema.Array(Schema.String),
  checkpointCursor: Schema.NullOr(Schema.String),
  checkpointSequence: NonNegativeInt,
  lastCheckedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HermesProactiveSourceStatus = typeof HermesProactiveSourceStatus.Type;

/**
 * A Hermes thread T3 keeps subscribed to its gateway so runs that start
 * without a T3 turn (cron jobs, other clients) are witnessed live.
 * `selectedBy` records why: "job" when the gateway named the session its
 * scheduled job runs in, "recent" when it did not and T3 fell back to the most
 * recently used threads on the profile.
 */
export const HermesProactiveResidentThread = Schema.Struct({
  providerInstanceId: Schema.String,
  threadId: Schema.String,
  storedSessionKey: Schema.String,
  selectedBy: Schema.Literals(["job", "recent"]),
});
export type HermesProactiveResidentThread = typeof HermesProactiveResidentThread.Type;

export const HermesProactiveProviderStatus = Schema.Struct({
  providerInstanceId: Schema.String,
  displayName: Schema.String,
  profileKey: Schema.String,
  enabled: Schema.Boolean,
  source: Schema.NullOr(HermesProactiveSourceStatus),
  enabledJobCount: NonNegativeInt,
  residentThreads: Schema.Array(HermesProactiveResidentThread),
  diagnostics: Schema.Array(Schema.String),
});
export type HermesProactiveProviderStatus = typeof HermesProactiveProviderStatus.Type;

export const HermesProactiveStatusInput = Schema.Struct({});
export type HermesProactiveStatusInput = typeof HermesProactiveStatusInput.Type;

export const HermesProactiveStatusResult = Schema.Struct({
  providers: Schema.Array(HermesProactiveProviderStatus),
  sweptAt: Schema.NullOr(IsoDateTime),
});
export type HermesProactiveStatusResult = typeof HermesProactiveStatusResult.Type;

export const HermesProactiveEventProvenance = Schema.Struct({
  provider: Schema.Literal("hermes"),
  providerInstanceId: Schema.String,
  profileKey: Schema.String,
  sourceId: Schema.String,
  externalEventId: Schema.String,
  externalCursor: Schema.String,
  gatewayRevision: Schema.NullOr(Schema.String),
  protocolMajor: Schema.NullOr(NonNegativeInt),
  protocolMinor: Schema.NullOr(NonNegativeInt),
  ingestedAt: IsoDateTime,
});
export type HermesProactiveEventProvenance = typeof HermesProactiveEventProvenance.Type;

/**
 * How T3 came to know an event happened.
 *
 * `durable` events were replayed from the gateway's global cron cursor and can
 * be re-read after a restart. `witnessed` events were seen live on a session T3
 * had subscribed, or inferred on the next sweep from a job whose last run time
 * advanced while T3 was away. Only the durable kind moves the source
 * checkpoint; a witnessed event is recorded exactly once, when T3 notices it,
 * because the pinned protocol offers nothing to replay it from.
 */
export const HermesProactiveEventKinds = {
  /** A run T3 saw stream on a session it was subscribed to. */
  cronRunWitnessed: "cron.run.witnessed",
  /** A run T3 learned about only from the job's run time moving. */
  cronRunMissed: "cron.run.missed",
  /** A reported run that Hermes says ended badly, whichever way T3 heard. */
  cronRunFailed: "cron.run.failed",
} as const;

export const HermesProactiveEvent = Schema.Struct({
  eventId: Schema.String,
  sourceId: Schema.String,
  externalEventId: Schema.String,
  externalCursor: Schema.String,
  eventKind: Schema.String,
  title: Schema.String,
  body: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  occurredAt: IsoDateTime,
  receivedAt: IsoDateTime,
  provenance: HermesProactiveEventProvenance,
});
export type HermesProactiveEvent = typeof HermesProactiveEvent.Type;

export const HermesProactiveWorkItem = Schema.Struct({
  workItemId: Schema.String,
  eventId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  title: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["unread", "read", "dismissed"]),
  occurredAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HermesProactiveWorkItem = typeof HermesProactiveWorkItem.Type;

export const HermesInAppNotification = Schema.Struct({
  notificationId: Schema.String,
  eventId: Schema.String,
  workItemId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  title: Schema.String,
  body: Schema.String,
  status: Schema.Literals(["unread", "read", "dismissed"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HermesInAppNotification = typeof HermesInAppNotification.Type;

export const HermesNotificationOutboxState = Schema.Literals([
  "pending",
  "processing",
  "retry",
  "delivered",
  "dead_letter",
]);
export type HermesNotificationOutboxState = typeof HermesNotificationOutboxState.Type;

export const HermesNotificationOutboxEntry = Schema.Struct({
  outboxId: Schema.String,
  eventId: Schema.String,
  state: HermesNotificationOutboxState,
  attemptCount: NonNegativeInt,
  availableAt: IsoDateTime,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  lastErrorCode: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type HermesNotificationOutboxEntry = typeof HermesNotificationOutboxEntry.Type;

/**
 * What a client renders for Hermes work that happened without anyone asking.
 * `unreadCount` counts the notifications, not the work items: the two tables
 * are written together and a client that only shows a badge should not have to
 * load the list to draw it.
 */
export const HermesProactiveInboxSnapshot = Schema.Struct({
  notifications: Schema.Array(HermesInAppNotification),
  unreadCount: NonNegativeInt,
  /**
   * Entries the outbox gave up on. Surfaced rather than hidden so a broken
   * delivery path is visible instead of looking like a quiet inbox.
   */
  deadLetterCount: NonNegativeInt,
});
export type HermesProactiveInboxSnapshot = typeof HermesProactiveInboxSnapshot.Type;

export const HermesProactiveInboxInput = Schema.Struct({});
export type HermesProactiveInboxInput = typeof HermesProactiveInboxInput.Type;

export const HermesProactiveNotificationStatus = Schema.Literals(["unread", "read", "dismissed"]);
export type HermesProactiveNotificationStatus = typeof HermesProactiveNotificationStatus.Type;

/**
 * Every status is reachable in both directions, so a dismissed notification can
 * be brought back rather than being a one-way door.
 */
export const HermesProactiveMarkNotificationsInput = Schema.Struct({
  notificationIds: Schema.Array(Schema.String),
  status: HermesProactiveNotificationStatus,
});
export type HermesProactiveMarkNotificationsInput =
  typeof HermesProactiveMarkNotificationsInput.Type;

export const HermesProactiveMarkNotificationsResult = Schema.Struct({
  updated: NonNegativeInt,
  snapshot: HermesProactiveInboxSnapshot,
});
export type HermesProactiveMarkNotificationsResult =
  typeof HermesProactiveMarkNotificationsResult.Type;

export class HermesProactiveInboxError extends Schema.TaggedErrorClass<HermesProactiveInboxError>()(
  "HermesProactiveInboxError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

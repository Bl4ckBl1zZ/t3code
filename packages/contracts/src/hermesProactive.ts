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
